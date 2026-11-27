import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { AppErrorCode } from '../../contracts/errors';
import type { BackupValuesDTO, JobCountsDTO, JobResultStatus, StorageValuesDTO } from '../../contracts/ops';
import { createJobLeaseRepo } from '../jobs/lease-repo';
import {
  budgetExhausted,
  createJobBudget,
  JobDeadlineExceeded,
  OPS_SAMPLE_JOB_KEY,
  runWithinBudget,
  type JobRunOutcome,
  type RegisteredJob,
} from '../jobs/registry';
import {
  BACKUP_FRESHNESS_MS,
  createOpsReportService,
  STORAGE_FRESHNESS_MS,
  type OpsSnapshotRecord,
} from './ops-report';

export { OPS_SAMPLE_JOB_KEY };

const OPS_SAMPLE_OWNER = 'ops-sample-runtime';

/** 单轮本地存储只读遍历的最大目录项扫描上限，防止超大目录耗尽 55s 作业预算。 */
const MAX_LOCAL_STORAGE_ENTRIES = 50_000;
const MAX_LOCAL_STORAGE_DEPTH = 16;

export type StorageSampleOutcome =
  | { kind: 'ok'; values: StorageValuesDTO }
  | { kind: 'not_connected' }
  | { kind: 'unconfigured' }
  | { kind: 'failed'; errorCode: AppErrorCode };

export type BackupSampleOutcome =
  | { kind: 'ok'; values: BackupValuesDTO }
  | { kind: 'not_connected' }
  | { kind: 'unconfigured' }
  | { kind: 'failed'; errorCode: AppErrorCode };

export type OpsSampleDeps = {
  db: PrismaClient;
  clock?: () => Date;
  env?: Record<string, string | undefined>;
  /** 受控本地存储采样器；默认仅在 STORAGE_DRIVER=local 且显式设置绝对/受控 UPLOAD_DIR 时只读统计字节数。 */
  sampleStorage?: (context: { now: Date; signal: AbortSignal }) => Promise<StorageSampleOutcome>;
  /**
   * 备份元数据采样器；容器不挂载宿主机 backup 目录，生产默认不伪造备份成功，
   * 仅由宿主机受控 deploy/ops-report.py 上报，或在测试中显式注入受控验证采样器。
   */
  sampleBackup?: (context: { now: Date; signal: AbortSignal }) => Promise<BackupSampleOutcome>;
};

function isErrno(error: unknown, ...codes: string[]): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && codes.includes(code);
}

/**
 * 受控本地存储只读采样（绝不读文件内容、不跟随符号链接、不接受外部任意路径）。
 * 仅在 STORAGE_DRIVER=local 且显式配置 UPLOAD_DIR 时执行；未配置返回 unconfigured，避免覆写外部报告。
 */
export async function sampleControlledLocalStorage(
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<StorageSampleOutcome> {
  const driver = env.STORAGE_DRIVER?.trim() || 'local';
  if (driver !== 'local') return { kind: 'unconfigured' };
  const rawDir = env.UPLOAD_DIR?.trim();
  if (!rawDir) return { kind: 'unconfigured' };

  const resolved = path.resolve(rawDir);
  let rootStat;
  try {
    rootStat = await fs.lstat(resolved);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { kind: 'not_connected' };
    return { kind: 'failed', errorCode: 'service_unavailable' };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { kind: 'failed', errorCode: 'service_unavailable' };
  }

  try {
    const realRoot = await fs.realpath(resolved);
    let bytesUsed = 0;
    let scanned = 0;
    const queue: Array<{ dir: string; depth: number }> = [{ dir: realRoot, depth: 0 }];

    while (queue.length > 0) {
      if (signal.aborted) return { kind: 'failed', errorCode: 'service_unavailable' };
      const current = queue.shift()!;
      const entries = await fs.readdir(current.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (signal.aborted) return { kind: 'failed', errorCode: 'service_unavailable' };
        scanned += 1;
        if (scanned > MAX_LOCAL_STORAGE_ENTRIES) {
          return { kind: 'failed', errorCode: 'service_unavailable' };
        }
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(current.dir, entry.name);
        const st = await fs.lstat(fullPath);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (current.depth + 1 > MAX_LOCAL_STORAGE_DEPTH) {
            return { kind: 'failed', errorCode: 'service_unavailable' };
          }
          queue.push({ dir: fullPath, depth: current.depth + 1 });
        } else if (st.isFile()) {
          bytesUsed = Math.min(Number.MAX_SAFE_INTEGER, bytesUsed + Math.max(0, Math.trunc(st.size)));
        }
      }
    }

    const stats = await fs.statfs(realRoot);
    const freeRaw = BigInt(stats.bavail) * BigInt(stats.bsize);
    const bytesFree = freeRaw > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, Number(freeRaw));

    return { kind: 'ok', values: { bytesUsed, bytesFree } };
  } catch {
    return { kind: 'failed', errorCode: 'service_unavailable' };
  }
}

function isSnapshotStale(snapshot: OpsSnapshotRecord, now: Date): boolean {
  if (snapshot.status === 'NOT_CONNECTED') return false;
  if (snapshot.status === 'FAILED') return snapshot.lastSucceededAt !== null;
  if (snapshot.lastSucceededAt === null) return false;
  if (snapshot.source === 'STORAGE') {
    return now.getTime() - snapshot.lastSucceededAt.getTime() >= STORAGE_FRESHNESS_MS;
  }
  const values = snapshot.values as { backupCompletedAt?: unknown } | null;
  const completedMs = typeof values?.backupCompletedAt === 'string' ? Date.parse(values.backupCompletedAt) : Number.NaN;
  return (Number.isFinite(completedMs) && now.getTime() - completedMs >= BACKUP_FRESHNESS_MS)
    || (now.getTime() - snapshot.lastSucceededAt.getTime() >= BACKUP_FRESHNESS_MS);
}

/**
 * 固定运维采样作业 `ops-sample`（每 15 分钟经 POST /api/admin/cron/operations 调度）：
 * - 领取 JobState('ops-sample') 90s 租约，受 55s 预算约束，构造期不触碰数据库；
 * - 事务外执行受控本地存储只读字节统计（无任意路径、不读文件内容），经同一单调 CAS 仓储写快照；
 * - 不伪造备份完成或恢复验证，只读核验已有 STORAGE/BACKUP 快照的新鲜度与失败数并写脱敏 JobState 摘要。
 */
export function createOpsSampleJob(deps: OpsSampleDeps): RegisteredJob {
  const clock = deps.clock ?? (() => new Date());
  const env = deps.env ?? process.env;
  const sampleStorage = deps.sampleStorage ?? (({ signal }) => sampleControlledLocalStorage(env, signal));
  const sampleBackup = deps.sampleBackup;

  return {
    key: OPS_SAMPLE_JOB_KEY,
    async run(context): Promise<JobRunOutcome> {
      const now = context.now;
      const budget = createJobBudget(context);
      const repo = createJobLeaseRepo({ db: deps.db, clock });
      const opsReport = createOpsReportService({ db: deps.db });

      const claimed = await runWithinBudget(deps.db, budget, (tx) =>
        createJobLeaseRepo({ db: tx, clock }).claim({ key: OPS_SAMPLE_JOB_KEY, owner: OPS_SAMPLE_OWNER }));
      if (claimed.kind === 'budget') throw new JobDeadlineExceeded();
      if (claimed.kind === 'error') throw claimed.error;
      const claim = claimed.value;
      if (!claim.acquired) {
        if (claim.reason === 'busy') return { kind: 'busy' };
        throw new Error(`claim_${claim.reason}`);
      }

      const measuredAt = now.toISOString();
      let attemptedSamples = 0;
      let failedSamples = 0;
      let sampleErrorCode: AppErrorCode | null = null;

      try {
        if (budgetExhausted(budget)) return { kind: 'timeout' };
        const storageOutcome = await sampleStorage({ now, signal: budget.signal });
        if (budgetExhausted(budget)) return { kind: 'timeout' };

        if (storageOutcome.kind === 'ok') {
          attemptedSamples += 1;
          await opsReport.submit({
            source: 'STORAGE',
            measuredAt,
            status: 'OK',
            values: storageOutcome.values,
          });
        } else if (storageOutcome.kind === 'failed') {
          attemptedSamples += 1;
          failedSamples += 1;
          sampleErrorCode = storageOutcome.errorCode;
          await opsReport.submit({
            source: 'STORAGE',
            measuredAt,
            status: 'FAILED',
            safeErrorCode: storageOutcome.errorCode,
          });
        } else if (storageOutcome.kind === 'not_connected') {
          const existing = await opsReport.readSnapshots();
          if (!existing.STORAGE) {
            await opsReport.submit({
              source: 'STORAGE',
              measuredAt,
              status: 'NOT_CONNECTED',
              safeErrorCode: 'source_unavailable',
            });
          }
        }

        if (sampleBackup) {
          if (budgetExhausted(budget)) return { kind: 'timeout' };
          const backupOutcome = await sampleBackup({ now, signal: budget.signal });
          if (budgetExhausted(budget)) return { kind: 'timeout' };

          if (backupOutcome.kind === 'ok') {
            attemptedSamples += 1;
            await opsReport.submit({
              source: 'BACKUP',
              measuredAt,
              status: 'OK',
              values: backupOutcome.values,
            });
          } else if (backupOutcome.kind === 'failed') {
            attemptedSamples += 1;
            failedSamples += 1;
            sampleErrorCode = sampleErrorCode ?? backupOutcome.errorCode;
            await opsReport.submit({
              source: 'BACKUP',
              measuredAt,
              status: 'FAILED',
              safeErrorCode: backupOutcome.errorCode,
            });
          } else if (backupOutcome.kind === 'not_connected') {
            const existing = await opsReport.readSnapshots();
            if (!existing.BACKUP) {
              await opsReport.submit({
                source: 'BACKUP',
                measuredAt,
                status: 'NOT_CONNECTED',
                safeErrorCode: 'source_unavailable',
              });
            }
          }
        }

        if (budgetExhausted(budget)) return { kind: 'timeout' };
        const snapshots = await opsReport.readSnapshots();
        const observed = Object.values(snapshots).filter((item): item is OpsSnapshotRecord => Boolean(item));
        const staleCount = observed.filter((item) => isSnapshotStale(item, now)).length;
        const snapshotFailedCount = observed.filter((item) => item.status === 'FAILED').length;

        const counts: JobCountsDTO = {
          candidateCount: observed.length,
          stale: staleCount,
          failed: Math.max(failedSamples, snapshotFailedCount),
        };
        const status: JobResultStatus = failedSamples === 0
          ? 'SUCCEEDED'
          : (failedSamples < attemptedSamples ? 'PARTIAL' : 'FAILED');
        const errorCode: AppErrorCode | null = status === 'SUCCEEDED'
          ? null
          : (sampleErrorCode ?? 'source_unavailable');

        const finished = await runWithinBudget(deps.db, budget, async (tx) => {
          await repo.complete({
            key: OPS_SAMPLE_JOB_KEY,
            owner: OPS_SAMPLE_OWNER,
            generation: claim.generation,
            status,
            summary: {
              counts,
              times: { measuredAt },
              versions: { timezoneRevision: claim.timezoneRevision },
            },
            errorCode,
            timezoneRevision: claim.timezoneRevision,
          }, tx);
        });
        if (finished.kind === 'budget') return { kind: 'timeout' };
        if (finished.kind === 'error') return { kind: 'finish_failed' };
        return { kind: 'ran', status, counts };
      } catch {
        if (budgetExhausted(budget)) return { kind: 'timeout' };
        const counts: JobCountsDTO = { candidateCount: 0, stale: 0, failed: Math.max(1, failedSamples) };
        const failed = await runWithinBudget(deps.db, budget, async (tx) => {
          await repo.complete({
            key: OPS_SAMPLE_JOB_KEY,
            owner: OPS_SAMPLE_OWNER,
            generation: claim.generation,
            status: 'FAILED',
            summary: {
              counts,
              times: { measuredAt },
              versions: { timezoneRevision: claim.timezoneRevision },
            },
            errorCode: 'service_unavailable',
            timezoneRevision: claim.timezoneRevision,
          }, tx);
        });
        if (failed.kind === 'budget') return { kind: 'timeout' };
        if (failed.kind === 'error') return { kind: 'finish_failed' };
        return { kind: 'ran', status: 'FAILED', counts };
      }
    },
  };
}
