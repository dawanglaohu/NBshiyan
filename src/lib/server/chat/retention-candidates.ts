import { Prisma, type PrismaClient } from '@prisma/client';
import type { AppErrorCode } from '../../contracts/errors';
import type { JobCountsDTO, JobResultStatus } from '../../contracts/ops';
import { CHAT_VISITOR_POLICY, type ChatVisitorPolicy } from '../config';
import { createJobLeaseRepo } from '../jobs/lease-repo';
import {
  CHAT_RETENTION_JOB_KEY,
  createJobBudget,
  isBudgetTimeoutError,
  runWithinBudget,
  type JobBudget,
  type JobRunContext,
  type JobRunOutcome,
  type RegisteredJob,
} from '../jobs/registry';
import { isDatabaseUnavailable } from './repo';
import {
  assertRetentionInstant,
  evaluateChatRetentionGate,
  visitorIdleExpiryCutoff,
  type ChatRetentionGateDecision,
  type ChatRetentionPolicy,
} from './retention-policy';

/** 只读候选列举上限（与 08 节固定作业单轮工作单位上限一致）。 */
export const CHAT_RETENTION_MAX_CANDIDATE_SCAN = 500;

/** JobState 租约 owner：只由本固定作业写入，不接受外部输入。 */
export const CHAT_RETENTION_OWNER = 'chat-retention';

/** 只读查询接口：物理上不提供 $executeRaw 或任何模型写方法。 */
export type ChatRetentionQueryDb = Pick<PrismaClient, '$queryRaw'>;

/** 聊天保留作业数据库依赖：仅包含租约/只读查询所需的 $queryRaw 与 $transaction，不含业务表写原语。 */
export type ChatRetentionDb = Pick<PrismaClient, '$queryRaw' | '$transaction'>;

const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

function isoColumn(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`to_char(${column}, ${ISO_FORMAT})`;
}

function assertCandidateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_RETENTION_MAX_CANDIDATE_SCAN) {
    throw new Error('invalid_limit');
  }
  return limit;
}

function errorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name)) return error.name;
  return 'Error';
}

export type ChatRetentionCandidateSummary = {
  /** 满足 anonymizedAt IS NULL AND retainUntil <= now（90 天到期）的咨询计数。 */
  candidateCount: number;
  /** 最早一笔到期候选的安全 retainUntil 时间戳（UTC ISO），无候选时为 null。 */
  oldestRetainUntil: string | null;
  /** 最新一笔到期候选的安全 retainUntil 时间戳（UTC ISO），无候选时为 null。 */
  newestRetainUntil: string | null;
  /** 已过期/撤销且没有任何 ChatConversation 引用的空访客会话数（不并入 candidateCount）。 */
  emptyExpiredSessionCount: number;
  /** 本次只读评估的注入时钟时刻（UTC ISO）。 */
  evaluatedAt: string;
};

export type ChatRetentionCandidateRef = {
  id: string;
  version: number;
  retainUntil: string;
  lastActivityAt: string;
};

export type ChatRetentionCandidateRepo = {
  summary(): Promise<ChatRetentionCandidateSummary>;
  expiredConversationRefs(limit: number): Promise<ChatRetentionCandidateRef[]>;
};

/**
 * 聊天保留只读候选仓储（M4-T7）：
 * - 按 90 天 `retainUntil <= now` 与 `anonymizedAt IS NULL` 筛选咨询候选；
 * - 绝不因为 `ChatVisitorSession` 的 7d 闲置/30d 绝对/撤销而提前选中保留期内的咨询（E-85）；
 * - 绝不纳入 Inquiry(730d)、Analytics*、OpsSourceSnapshot 或 MailMessage；
 * - 不选择正文（bodyText）、email、sourcePath、tokenHash 或 payloadHash。
 */
export function createChatRetentionCandidateRepo(deps: {
  db: ChatRetentionQueryDb;
  now: Date;
  visitorPolicy?: Pick<ChatVisitorPolicy, 'idleMs'>;
}): ChatRetentionCandidateRepo {
  const now = assertRetentionInstant(deps.now);
  const visitorPolicy = deps.visitorPolicy ?? CHAT_VISITOR_POLICY;
  const idleCutoff = visitorIdleExpiryCutoff(now, visitorPolicy);

  return {
    async summary(): Promise<ChatRetentionCandidateSummary> {
      const [conversationRows, emptySessionRows] = await Promise.all([
        deps.db.$queryRaw<{
          candidateCount: number;
          oldestRetainUntil: string | null;
          newestRetainUntil: string | null;
        }[]>(Prisma.sql`
          SELECT
            COUNT(*)::int AS "candidateCount",
            ${isoColumn(Prisma.sql`MIN("retainUntil")`)} AS "oldestRetainUntil",
            ${isoColumn(Prisma.sql`MAX("retainUntil")`)} AS "newestRetainUntil"
          FROM "ChatConversation"
          WHERE "anonymizedAt" IS NULL
            AND "retainUntil" <= ${utc(now)}
        `),
        deps.db.$queryRaw<{ count: number }[]>(Prisma.sql`
          SELECT COUNT(*)::int AS "count"
          FROM "ChatVisitorSession" AS s
          WHERE (
            s."revokedAt" IS NOT NULL
            OR s."absoluteExpiresAt" <= ${utc(now)}
            OR s."lastActivityAt" <= ${utc(idleCutoff)}
          )
            AND NOT EXISTS (
              SELECT 1
              FROM "ChatConversation" AS c
              WHERE c."visitorSessionId" = s."id"
            )
        `),
      ]);

      const conversationRow = conversationRows[0];
      return {
        candidateCount: Number(conversationRow?.candidateCount ?? 0),
        oldestRetainUntil: conversationRow?.oldestRetainUntil ?? null,
        newestRetainUntil: conversationRow?.newestRetainUntil ?? null,
        emptyExpiredSessionCount: Number(emptySessionRows[0]?.count ?? 0),
        evaluatedAt: now.toISOString(),
      };
    },

    async expiredConversationRefs(limit: number): Promise<ChatRetentionCandidateRef[]> {
      const take = assertCandidateLimit(limit);
      const rows = await deps.db.$queryRaw<ChatRetentionCandidateRef[]>(Prisma.sql`
        SELECT
          "id",
          "version",
          ${isoColumn(Prisma.sql`"retainUntil"`)} AS "retainUntil",
          ${isoColumn(Prisma.sql`"lastActivityAt"`)} AS "lastActivityAt"
        FROM "ChatConversation"
        WHERE "anonymizedAt" IS NULL
          AND "retainUntil" <= ${utc(now)}
        ORDER BY "retainUntil" ASC, "id" ASC
        LIMIT ${take}
      `);
      return rows.map((row) => ({
        id: row.id,
        version: Number(row.version),
        retainUntil: row.retainUntil,
        lastActivityAt: row.lastActivityAt,
      }));
    },
  };
}

export type ChatRetentionReport = {
  mode: ChatRetentionGateDecision['mode'];
  requestedDelete: boolean;
  authorized: boolean;
  rejected: boolean;
  reason: ChatRetentionGateDecision['reason'] | 'delete_not_enabled_in_stage';
  policyVersion: number;
  candidateCount: number;
  deletedCount: 0;
  emptyExpiredSessionCount: number;
  oldestRetainUntil: string | null;
  newestRetainUntil: string | null;
  cutoff: string;
};

export type ChatRetentionRun =
  | { kind: 'busy' }
  | { kind: 'timeout' }
  | {
      kind: 'completed';
      status: JobResultStatus;
      errorCode: AppErrorCode | null;
      counts: JobCountsDTO;
      report: ChatRetentionReport;
    }
  | { kind: 'finish_failed'; report: ChatRetentionReport };

/**
 * 执行一轮 `chat-retention` 固定作业（M4-T7）：
 * 1) 领取 `'chat-retention'` 持久租约，受整轮 55s 预算约束；
 * 2) 执行只读候选统计（90d `retainUntil`），不触碰正文/email 及其他业务表；
 * 3) 默认 dry-run 写 `SUCCEEDED`；请求真实删除但未授权或开关未启用时写 `FAILED`/`forbidden`；
 * 4) M4-T7 阶段在任何情况下均不修改或删除任何业务数据（`deletedCount` 恒为 0）。
 */
export async function runChatRetention(deps: {
  db: ChatRetentionDb;
  context: JobRunContext;
  clock?: () => Date;
  deleteAuthorized?: boolean;
  policy?: ChatRetentionPolicy;
  expectedPolicyVersion?: number;
  authorizationSource?: string;
  visitorPolicy?: Pick<ChatVisitorPolicy, 'idleMs'>;
  /** 测试注入：claim 成功后、候选查询前执行，用于验证租约抢占或并发场景。 */
  afterClaim?: (claim: { generation: number; timezoneRevision: number }) => Promise<void>;
}): Promise<ChatRetentionRun> {
  const clock = deps.clock ?? (() => new Date());
  const now = assertRetentionInstant(deps.context.now);
  const budget: JobBudget = createJobBudget(deps.context);
  const decision = evaluateChatRetentionGate({
    dryRun: deps.context.dryRun,
    deleteAuthorized: deps.deleteAuthorized,
    policy: deps.policy,
    expectedPolicyVersion: deps.expectedPolicyVersion,
    authorizationSource: deps.authorizationSource,
  });

  const report: ChatRetentionReport = {
    mode: 'dry-run',
    requestedDelete: decision.requestedDelete,
    authorized: decision.authorized,
    rejected: decision.rejected || decision.mode === 'delete',
    reason: decision.mode === 'delete' ? 'delete_not_enabled_in_stage' : decision.reason,
    policyVersion: decision.policyVersion,
    candidateCount: 0,
    deletedCount: 0,
    emptyExpiredSessionCount: 0,
    oldestRetainUntil: null,
    newestRetainUntil: null,
    cutoff: now.toISOString(),
  };

  const claimed = await runWithinBudget(deps.db, budget, (tx) =>
    createJobLeaseRepo({ db: tx, clock }).claim({
      key: CHAT_RETENTION_JOB_KEY,
      owner: CHAT_RETENTION_OWNER,
    }));
  if (claimed.kind === 'budget') return { kind: 'timeout' };
  if (claimed.kind === 'error') throw claimed.error;
  const claimResult = claimed.value;
  if (!claimResult.acquired) {
    if (claimResult.reason === 'busy') return { kind: 'busy' };
    throw new Error(`chat_retention_claim_${claimResult.reason}`);
  }
  const claim = claimResult;

  if (deps.afterClaim) {
    await deps.afterClaim({ generation: claim.generation, timezoneRevision: claim.timezoneRevision });
  }

  async function persist(
    status: JobResultStatus,
    errorCode: AppErrorCode | null,
    payload: ChatRetentionReport,
  ): Promise<ChatRetentionRun> {
    const counts: JobCountsDTO = {
      candidateCount: payload.candidateCount,
      deletedCount: 0,
    };
    const written = await runWithinBudget(deps.db, budget, (tx) =>
      createJobLeaseRepo({ db: tx, clock }).complete({
        key: CHAT_RETENTION_JOB_KEY,
        owner: CHAT_RETENTION_OWNER,
        generation: claim.generation,
        status,
        summary: {
          counts,
          times: { measuredAt: now.toISOString() },
          versions: {
            timezoneRevision: claim.timezoneRevision,
            policyVersion: payload.policyVersion,
          },
        },
        errorCode,
        timezoneRevision: claim.timezoneRevision,
      }, tx));
    if (written.kind === 'budget') return { kind: 'timeout' };
    if (written.kind === 'error') {
      console.error('[cron] chat retention lease finish failed', errorName(written.error));
      return { kind: 'finish_failed', report: payload };
    }
    return { kind: 'completed', status, errorCode, counts, report: payload };
  }

  const counted = await runWithinBudget(deps.db, budget, (tx) =>
    createChatRetentionCandidateRepo({
      db: tx,
      now,
      ...(deps.visitorPolicy ? { visitorPolicy: deps.visitorPolicy } : {}),
    }).summary());

  if (counted.kind === 'budget') return { kind: 'timeout' };
  if (counted.kind === 'error') {
    if (isBudgetTimeoutError(counted.error)) return { kind: 'timeout' };
    console.error('[cron] chat retention candidate query failed', errorName(counted.error));
    const code: AppErrorCode = isDatabaseUnavailable(counted.error) ? 'service_unavailable' : 'internal_error';
    return persist('FAILED', code, report);
  }

  const candidates = counted.value;
  report.candidateCount = candidates.candidateCount;
  report.emptyExpiredSessionCount = candidates.emptyExpiredSessionCount;
  report.oldestRetainUntil = candidates.oldestRetainUntil;
  report.newestRetainUntil = candidates.newestRetainUntil;

  console.info('[cron] chat retention candidates', {
    jobKey: CHAT_RETENTION_JOB_KEY,
    generation: claim.generation,
    mode: report.mode,
    rejected: report.rejected,
    reason: report.reason,
    policyVersion: report.policyVersion,
    candidateCount: report.candidateCount,
    deletedCount: 0,
    emptyExpiredSessionCount: report.emptyExpiredSessionCount,
    cutoff: report.cutoff,
    oldestRetainUntil: report.oldestRetainUntil,
    newestRetainUntil: report.newestRetainUntil,
  });

  // 生产未获保留策略授权、策略未开启，或本阶段尚未接入真实匿名化写入时，请求删除一律拒绝且 deletedCount=0。
  if (report.rejected) {
    console.warn('[cron] chat retention delete rejected', {
      jobKey: CHAT_RETENTION_JOB_KEY,
      generation: claim.generation,
      reason: report.reason,
      policyVersion: report.policyVersion,
      candidateCount: report.candidateCount,
      deletedCount: 0,
    });
    return persist('FAILED', 'forbidden', report);
  }

  return persist('SUCCEEDED', null, report);
}

/**
 * 固定作业包装器：接入 `jobs/registry.ts`。构造期不触碰数据库。
 */
export function createChatRetentionJob(deps: {
  db: ChatRetentionDb;
  clock?: () => Date;
  deleteAuthorized?: boolean;
  policy?: ChatRetentionPolicy;
  expectedPolicyVersion?: number;
  authorizationSource?: string;
  visitorPolicy?: Pick<ChatVisitorPolicy, 'idleMs'>;
}): RegisteredJob {
  return {
    key: CHAT_RETENTION_JOB_KEY,
    async run(context: JobRunContext): Promise<JobRunOutcome> {
      const result = await runChatRetention({
        db: deps.db,
        context,
        ...(deps.clock ? { clock: deps.clock } : {}),
        ...(deps.deleteAuthorized !== undefined ? { deleteAuthorized: deps.deleteAuthorized } : {}),
        ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
        ...(deps.expectedPolicyVersion !== undefined ? { expectedPolicyVersion: deps.expectedPolicyVersion } : {}),
        ...(deps.authorizationSource !== undefined ? { authorizationSource: deps.authorizationSource } : {}),
        ...(deps.visitorPolicy !== undefined ? { visitorPolicy: deps.visitorPolicy } : {}),
      });
      if (result.kind === 'busy') return { kind: 'busy' };
      if (result.kind === 'timeout') return { kind: 'timeout' };
      if (result.kind === 'finish_failed') return { kind: 'finish_failed' };
      return { kind: 'ran', status: result.status, counts: result.counts };
    },
  };
}
