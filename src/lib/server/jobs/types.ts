import { z } from 'zod';
import { PositiveIntSchema, UtcDateTimeSchema } from '../../contracts/common';
import { type AppErrorCode } from '../../contracts/errors';
import { JobCountsSchema, JobKeySchema, JobResultStatusSchema, type JobKey } from '../../contracts/ops';

/** 应用内固定作业的互斥窗口。到期等号视为已释放。 */
export const JOB_LEASE_MS = 90_000;

/** 没有 analytics.settings 行时，当前时区代次使用数据模型规定的初值 1。 */
export const INITIAL_TIMEZONE_REVISION = 1;

export const ANALYTICS_SETTINGS_KEY = 'analytics.settings';

export const JobRunStatusSchema = z.enum(['NEVER', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL']);
export type JobRunStatus = z.infer<typeof JobRunStatusSchema>;

/** 服务端工人标识。不接受路径、空白或可当作脚本的自由文本。 */
export const JobLeaseOwnerSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

export const JobSummarySchema = z.object({
  counts: JobCountsSchema.optional(),
  times: z.object({
    dataThrough: UtcDateTimeSchema.optional(),
    sourceThrough: UtcDateTimeSchema.optional(),
    aggregatedAt: UtcDateTimeSchema.optional(),
    measuredAt: UtcDateTimeSchema.optional(),
  }).strict().optional(),
  versions: z.object({
    timezoneRevision: PositiveIntSchema.optional(),
    policyVersion: PositiveIntSchema.optional(),
  }).strict().optional(),
}).strict();
export type JobSummary = z.infer<typeof JobSummarySchema>;

export const StoredTimezoneRevisionSchema = z.object({
  timezoneRevision: PositiveIntSchema,
}).passthrough();

export type JobLeaseView = {
  key: JobKey;
  generation: number;
  lastStatus: JobRunStatus;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSucceededAt: string | null;
  lockedUntil: string | null;
  leaseActive: boolean;
  lastErrorCode: AppErrorCode | null;
  summary: JobSummary | null;
};

export type ClaimResult =
  | { acquired: true; generation: number; lockedUntil: string; timezoneRevision: number; view: JobLeaseView }
  | { acquired: false; reason: 'invalid' | 'busy' | 'revision_unreadable' };

export type RenewResult =
  | { renewed: true; generation: number; lockedUntil: string; view: JobLeaseView }
  | { renewed: false; reason: 'invalid' | 'stale' | 'expired' };

export type CompleteResult =
  | { committed: true; view: JobLeaseView }
  | { committed: false; reason: 'invalid' | 'stale' | 'expired' | 'revision_conflict' | 'revision_unreadable' };

export type ReadResult =
  | { ok: true; view: JobLeaseView }
  | { ok: false; reason: 'invalid' };

export type ClaimInput = { key: string; owner: string };
export type RenewInput = { key: string; owner: string; generation: number };
export type CompleteInput = {
  key: string;
  owner: string;
  generation: number;
  status: string;
  summary: unknown;
  errorCode?: string | null;
  timezoneRevision: number;
};

export function neverView(key: JobKey): JobLeaseView {
  return {
    key,
    generation: 0,
    lastStatus: 'NEVER',
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSucceededAt: null,
    lockedUntil: null,
    leaseActive: false,
    lastErrorCode: null,
    summary: null,
  };
}

export { JobKeySchema, JobResultStatusSchema };
