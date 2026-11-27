import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { AppErrorCodeSchema, type FieldError } from '../../contracts/errors';
import {
  BackupValuesSchema,
  OpsReportReceiptDTOSchema,
  OpsReportRequestSchema,
  OpsReportStatusSchema,
  OpsSourceSchema,
  StorageValuesSchema,
  type OpsReportReceiptDTO,
  type OpsReportRequestDTO,
  type OpsReportStatus,
  type OpsSource,
  type StatsSource,
} from '../../contracts/ops';
import { AppError, classifyThrown, type UnknownFailureLog } from '../http/errors';
import type { ApiCounter, ApiRouteId } from '../http/metrics';
import { readBody } from '../security';
import { toStatsSourceDTO } from './source-dto';
import type { NonCoreSourceReader } from './stats-service';

export const OPS_REPORT_ROUTE_ID: ApiRouteId = 'POST /api/internal/ops-report';

/** 新运维报告 JSON 上限（8 KiB），先限体再解析 JSON。 */
export const OPS_REPORT_MAX_BODY_BYTES = 8 * 1024;

/** 存储采样周期 15 分钟，新鲜阈值 45 分钟（09/16/18 节）。 */
export const STORAGE_FRESHNESS_MS = 45 * 60_000;

/** 每日备份计划，新鲜阈值 36 小时（09/16/18 节）。 */
export const BACKUP_FRESHNESS_MS = 36 * 60 * 60_000;

export const OPS_SNAPSHOT_SOURCES = ['storage', 'backup'] as const satisfies readonly StatsSource[];
export type OpsSnapshotStatsSource = (typeof OPS_SNAPSHOT_SOURCES)[number];

const PRIVATE_NO_STORE = 'private, no-store';
const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const TX_OPTIONS = { maxWait: 2_000, timeout: 5_000 } as const;
const MAPPED_FIELD_ERRORS = new Set<keyof FieldError>([
  'source',
  'measuredAt',
  'status',
  'values',
  'safeErrorCode',
]);

export type OpsReportDb = Pick<PrismaClient, '$transaction'>;

export type OpsSnapshotRecord = {
  source: OpsSource;
  status: OpsReportStatus;
  measuredAt: Date;
  lastSucceededAt: Date | null;
  values: unknown;
  safeErrorCode: string | null;
  payloadHash: string;
};

type StoredSnapshotRow = {
  source: string;
  status: string;
  measuredAt: string;
  lastSucceededAt: string | null;
  values: unknown;
  safeErrorCode: string | null;
  payloadHash: string;
};

function utcSql(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

function isoColumn(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`to_char(${column}, ${ISO_FORMAT})`;
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 常量时间比较 Bearer 密钥；未配置或缺失令牌一律拒绝。 */
function bearerSecretMatches(given: string | null, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const left = Buffer.from(given, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeIsoTimestamp(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new AppError('invalid', { fieldErrors: { measuredAt: 'Invalid timestamp.' } });
  return new Date(ms).toISOString();
}

function normalizeValues(report: OpsReportRequestDTO): Record<string, unknown> | null {
  if (report.values == null) return null;
  if (report.source === 'STORAGE') {
    return {
      bytesUsed: report.values.bytesUsed,
      bytesFree: report.values.bytesFree,
    };
  }
  return {
    backupCompletedAt: normalizeIsoTimestamp(report.values.backupCompletedAt),
    backupAgeSeconds: report.values.backupAgeSeconds,
    verified: report.values.verified,
  };
}

/**
 * 规范载荷域分离 SHA-256 哈希。
 * 时间统一归一到精确 UTC 毫秒，字段键序固定，用于同 source+measuredAt 幂等与 409 冲突判定。
 */
export function canonicalOpsReportHash(report: OpsReportRequestDTO): string {
  const canonical = {
    source: report.source,
    measuredAt: normalizeIsoTimestamp(report.measuredAt),
    status: report.status,
    values: normalizeValues(report),
    safeErrorCode: report.safeErrorCode ?? null,
  };
  return createHash('sha256')
    .update('ops-report-v1:')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

function mapValidationIssues(issues: readonly z.ZodIssue[]): FieldError | undefined {
  const fieldErrors: Partial<Record<keyof FieldError, string>> = {};
  for (const issue of issues) {
    const first = issue.path[0];
    if (typeof first !== 'string' || !MAPPED_FIELD_ERRORS.has(first as keyof FieldError)) continue;
    const key = first as keyof FieldError;
    if (!fieldErrors[key]) {
      fieldErrors[key] = issue.message.slice(0, 200) || 'Invalid report field.';
    }
  }
  return Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined;
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function decodeSnapshotRow(row: StoredSnapshotRow): OpsSnapshotRecord | null {
  const source = OpsSourceSchema.safeParse(row.source);
  const status = OpsReportStatusSchema.safeParse(row.status);
  const measuredMs = Date.parse(row.measuredAt);
  const succeededMs = row.lastSucceededAt === null ? null : Date.parse(row.lastSucceededAt);
  if (!source.success || !status.success || !Number.isFinite(measuredMs)) return null;
  if (succeededMs !== null && !Number.isFinite(succeededMs)) return null;
  const parsedError = row.safeErrorCode === null ? null : AppErrorCodeSchema.safeParse(row.safeErrorCode);
  return {
    source: source.data,
    status: status.data,
    measuredAt: new Date(measuredMs),
    lastSucceededAt: succeededMs === null ? null : new Date(succeededMs),
    values: parseStoredJson(row.values),
    safeErrorCode: parsedError && parsedError.success ? parsedError.data : null,
    payloadHash: row.payloadHash,
  };
}

export type OpsReportService = {
  submit(rawInput: unknown): Promise<OpsReportReceiptDTO>;
  readSnapshots(): Promise<Partial<Record<OpsSource, OpsSnapshotRecord>>>;
};

/**
 * 存储/备份运维快照服务（M6-T3）：
 * - 按 source + measuredAt 单调 CAS 更新：同时间同载荷幂等返回原 accepted，同时间异载荷 409，旧时间 accepted=false 忽略；
 * - FAILED 保留此前成功 values 与 lastSucceededAt（不推进成功时间，不用失败体覆盖成功值）；
 * - NOT_CONNECTED 清空 values 与 lastSucceededAt（无验证来源不造虚假成功时间）。
 */
export function createOpsReportService(deps: { db: OpsReportDb }): OpsReportService {
  return {
    async submit(rawInput) {
      const parsed = OpsReportRequestSchema.safeParse(rawInput);
      if (!parsed.success) {
        const fieldErrors = mapValidationIssues(parsed.error.issues);
        throw new AppError('invalid', fieldErrors ? { fieldErrors } : undefined);
      }
      const report = parsed.data;
      const measuredAtIso = normalizeIsoTimestamp(report.measuredAt);
      const measuredAt = new Date(measuredAtIso);
      const normalizedValues = report.status === 'OK' ? normalizeValues(report) : null;
      const safeErrorCode = report.status === 'OK' ? null : (report.safeErrorCode ?? null);
      const payloadHash = canonicalOpsReportHash(report);

      const accepted = await deps.db.$transaction(async (tx) => {
        const valuesSql = normalizedValues === null
          ? Prisma.sql`NULL`
          : Prisma.sql`${JSON.stringify(normalizedValues)}::jsonb`;
        const succeededSql = report.status === 'OK' ? utcSql(measuredAt) : Prisma.sql`NULL`;

        // 并发首次插入采用 ON CONFLICT DO NOTHING；命中冲突后回退到 FOR UPDATE 串行判定。
        const inserted = await tx.$queryRaw<{ source: string }[]>`
          INSERT INTO "OpsSourceSnapshot" (
            "source", "status", "measuredAt", "lastSucceededAt", "values", "safeErrorCode", "payloadHash", "updatedAt"
          ) VALUES (
            ${report.source}::"OpsSource",
            ${report.status}::"OpsReportStatus",
            ${utcSql(measuredAt)},
            ${succeededSql},
            ${valuesSql},
            ${safeErrorCode},
            ${payloadHash},
            CURRENT_TIMESTAMP
          )
          ON CONFLICT ("source") DO NOTHING
          RETURNING "source"::text AS "source"
        `;
        if (inserted.length === 1) return true;

        const rows = await tx.$queryRaw<StoredSnapshotRow[]>`
          SELECT
            "source"::text AS "source",
            "status"::text AS "status",
            ${isoColumn(Prisma.sql`"measuredAt"`)} AS "measuredAt",
            ${isoColumn(Prisma.sql`"lastSucceededAt"`)} AS "lastSucceededAt",
            "values",
            "safeErrorCode",
            "payloadHash"
          FROM "OpsSourceSnapshot"
          WHERE "source" = ${report.source}::"OpsSource"
          FOR UPDATE
        `;
        const existing = rows[0] ? decodeSnapshotRow(rows[0]) : null;
        if (!existing) throw new AppError('service_unavailable');

        const incomingMs = measuredAt.getTime();
        const existingMs = existing.measuredAt.getTime();

        if (incomingMs < existingMs) {
          return false;
        }
        if (incomingMs === existingMs) {
          if (hashesEqual(payloadHash, existing.payloadHash)) {
            return true;
          }
          throw new AppError('idempotency_conflict', {
            fieldErrors: { measuredAt: 'Conflicting payload for the same source and measuredAt.' },
          });
        }

        if (report.status === 'OK') {
          await tx.$executeRaw`
            UPDATE "OpsSourceSnapshot"
            SET
              "status" = 'OK'::"OpsReportStatus",
              "measuredAt" = ${utcSql(measuredAt)},
              "lastSucceededAt" = ${utcSql(measuredAt)},
              "values" = ${valuesSql},
              "safeErrorCode" = NULL,
              "payloadHash" = ${payloadHash},
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE "source" = ${report.source}::"OpsSource"
          `;
        } else if (report.status === 'FAILED') {
          // 失败报告保留此前成功 values 与 lastSucceededAt，供看板标明旧值。
          await tx.$executeRaw`
            UPDATE "OpsSourceSnapshot"
            SET
              "status" = 'FAILED'::"OpsReportStatus",
              "measuredAt" = ${utcSql(measuredAt)},
              "safeErrorCode" = ${safeErrorCode},
              "payloadHash" = ${payloadHash},
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE "source" = ${report.source}::"OpsSource"
          `;
        } else {
          // NOT_CONNECTED：明确未接入，清空旧值与成功时间，不造虚假成功时间。
          await tx.$executeRaw`
            UPDATE "OpsSourceSnapshot"
            SET
              "status" = 'NOT_CONNECTED'::"OpsReportStatus",
              "measuredAt" = ${utcSql(measuredAt)},
              "lastSucceededAt" = NULL,
              "values" = NULL,
              "safeErrorCode" = ${safeErrorCode},
              "payloadHash" = ${payloadHash},
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE "source" = ${report.source}::"OpsSource"
          `;
        }
        return true;
      }, TX_OPTIONS);

      return OpsReportReceiptDTOSchema.parse({ accepted, measuredAt: measuredAtIso });
    },

    async readSnapshots() {
      const rows = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return tx.$queryRaw<StoredSnapshotRow[]>`
          SELECT
            "source"::text AS "source",
            "status"::text AS "status",
            ${isoColumn(Prisma.sql`"measuredAt"`)} AS "measuredAt",
            ${isoColumn(Prisma.sql`"lastSucceededAt"`)} AS "lastSucceededAt",
            "values",
            "safeErrorCode",
            "payloadHash"
          FROM "OpsSourceSnapshot"
          WHERE "source" IN ('STORAGE'::"OpsSource", 'BACKUP'::"OpsSource")
        `;
      }, TX_OPTIONS);

      const result: Partial<Record<OpsSource, OpsSnapshotRecord>> = {};
      for (const row of rows) {
        const decoded = decodeSnapshotRow(row);
        if (decoded) result[decoded.source] = decoded;
      }
      return result;
    },
  };
}

/** 将一条持久化 OpsSourceSnapshot（或缺失行）转换为受契约校验的 StatsSourceDTO。 */
export function snapshotToStatsSourceDTO(
  context: { timezone: string; timezoneRevision: number; queriedAt: string },
  source: OpsSnapshotStatsSource,
  snapshot: OpsSnapshotRecord | null,
  now: Date,
) {
  if (!snapshot || snapshot.status === 'NOT_CONNECTED') {
    return toStatsSourceDTO(context, source, { unavailableState: 'not_connected' });
  }

  if (source === 'storage') {
    const parsedValues = StorageValuesSchema.safeParse(snapshot.values);
    if (snapshot.status === 'OK') {
      if (!parsedValues.success || snapshot.lastSucceededAt === null) {
        return toStatsSourceDTO(context, 'storage', { unavailableState: 'query_failed' });
      }
      const stale = now.getTime() - snapshot.lastSucceededAt.getTime() >= STORAGE_FRESHNESS_MS;
      return toStatsSourceDTO(context, 'storage', {
        value: parsedValues.data.bytesUsed,
        coverage: 'full',
        dataThrough: snapshot.lastSucceededAt,
        lastSucceededAt: snapshot.lastSucceededAt,
        stale,
      });
    }
    // FAILED：有上次成功快照则保留原值与原成功时间并明确标为旧值；无旧值返回 query_failed。
    if (parsedValues.success && snapshot.lastSucceededAt !== null) {
      return toStatsSourceDTO(context, 'storage', {
        value: parsedValues.data.bytesUsed,
        coverage: 'partial',
        dataThrough: snapshot.lastSucceededAt,
        lastSucceededAt: snapshot.lastSucceededAt,
        stale: true,
      });
    }
    return toStatsSourceDTO(context, 'storage', { unavailableState: 'query_failed' });
  }

  const parsedValues = BackupValuesSchema.safeParse(snapshot.values);
  if (snapshot.status === 'OK') {
    if (!parsedValues.success || snapshot.lastSucceededAt === null) {
      return toStatsSourceDTO(context, 'backup', { unavailableState: 'query_failed' });
    }
    const completedMs = Date.parse(parsedValues.data.backupCompletedAt);
    if (!Number.isFinite(completedMs) || completedMs > snapshot.lastSucceededAt.getTime()) {
      return toStatsSourceDTO(context, 'backup', { unavailableState: 'query_failed' });
    }
    const completedAt = new Date(completedMs);
    const stale = (now.getTime() - completedMs >= BACKUP_FRESHNESS_MS)
      || (now.getTime() - snapshot.lastSucceededAt.getTime() >= BACKUP_FRESHNESS_MS);
    // 未做恢复验证（verified=false）不得标为 full 可恢复覆盖，仅以 partial 陈述已知完成元数据。
    const coverage = parsedValues.data.verified ? 'full' : 'partial';
    return toStatsSourceDTO(context, 'backup', {
      value: parsedValues.data.backupAgeSeconds,
      coverage,
      dataThrough: completedAt,
      lastSucceededAt: snapshot.lastSucceededAt,
      stale,
    });
  }

  if (parsedValues.success && snapshot.lastSucceededAt !== null) {
    const completedMs = Date.parse(parsedValues.data.backupCompletedAt);
    if (Number.isFinite(completedMs) && completedMs <= snapshot.lastSucceededAt.getTime()) {
      return toStatsSourceDTO(context, 'backup', {
        value: parsedValues.data.backupAgeSeconds,
        coverage: 'partial',
        dataThrough: new Date(completedMs),
        lastSucceededAt: snapshot.lastSucceededAt,
        stale: true,
      });
    }
  }
  return toStatsSourceDTO(context, 'backup', { unavailableState: 'query_failed' });
}

function readSingleSnapshot(db: OpsReportDb, source: OpsSource): Promise<OpsSnapshotRecord | null> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const rows = await tx.$queryRaw<StoredSnapshotRow[]>`
      SELECT
        "source"::text AS "source",
        "status"::text AS "status",
        ${isoColumn(Prisma.sql`"measuredAt"`)} AS "measuredAt",
        ${isoColumn(Prisma.sql`"lastSucceededAt"`)} AS "lastSucceededAt",
        "values",
        "safeErrorCode",
        "payloadHash"
      FROM "OpsSourceSnapshot"
      WHERE "source" = ${source}::"OpsSource"
    `;
    if (rows.length === 0) return null;
    const decoded = decodeSnapshotRow(rows[0]!);
    if (!decoded) throw new Error('ops_snapshot_corrupt');
    return decoded;
  }, TX_OPTIONS);
}

function readerFor(db: OpsReportDb, statsSource: OpsSnapshotStatsSource, opsSource: OpsSource): NonCoreSourceReader {
  return async ({ role, context, now }) => {
    // 纵深防御：stats-service 查询前已裁剪，此处再拒绝非 ADMIN 调用（E-66）。
    if (role !== 'ADMIN') throw new AppError('forbidden');
    try {
      const snapshot = await readSingleSnapshot(db, opsSource);
      return snapshotToStatsSourceDTO(context, statsSource, snapshot, now);
    } catch {
      // 辅助来源读取异常独立降级为 query_failed，绝不阻断核心或其他来源（E-67）。
      return toStatsSourceDTO(context, statsSource, { unavailableState: 'query_failed' });
    }
  };
}

/** 存储与备份只读来源读取器，供 GET /api/admin/stats 非核心来源槽位注入。 */
export function createOpsSourceReaders(db: OpsReportDb): Record<OpsSnapshotStatsSource, NonCoreSourceReader> {
  return {
    storage: readerFor(db, 'storage', 'STORAGE'),
    backup: readerFor(db, 'backup', 'BACKUP'),
  };
}

export type OpsReportHttpServices = {
  opsReport: OpsReportService;
  apiCounter: Pick<ApiCounter, 'recordFinalResponse'>;
};

async function finishOpsReportResponse(
  counter: Pick<ApiCounter, 'recordFinalResponse'>,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const recorded = await counter.recordFinalResponse({ routeId: OPS_REPORT_ROUTE_ID, status, body });
  return NextResponse.json(recorded.body, {
    status: recorded.status,
    headers: { 'cache-control': PRIVATE_NO_STORE, ...headers },
  });
}

/**
 * 处理 POST /api/internal/ops-report。
 * 严格只接受 Authorization: Bearer <CRON_SECRET>（常量时间比较），绝不接受后台 session cookie 替代。
 * 先限体再解析 JSON，严格白名单校验，所有响应私有不缓存并计入 ApiDailyCounter。
 */
export async function handlePostOpsReport(
  request: Request,
  services: OpsReportHttpServices,
  opts: { secret?: string; log?: (event: UnknownFailureLog) => void } = {},
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const auth = request.headers.get('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!bearerSecretMatches(token, opts.secret)) {
      throw new AppError('unauthorized');
    }

    const rawBody = await readBody(request, OPS_REPORT_MAX_BODY_BYTES);
    if (rawBody === null) {
      throw new AppError('too_large');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new AppError('invalid');
    }

    const receipt = await services.opsReport.submit(payload);
    return finishOpsReportResponse(services.apiCounter, 200, receipt);
  } catch (error) {
    const mapped = classifyThrown(error, requestId, opts.log);
    if (mapped.kind === 'legacy-response') return mapped.response;
    if (mapped.kind === 'legacy-body') return finishOpsReportResponse(services.apiCounter, 500, mapped.body);
    return finishOpsReportResponse(services.apiCounter, mapped.status, mapped.body, mapped.headers);
  }
}
