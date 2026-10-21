import { z } from 'zod';
import {
  LocalDateSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  ProductSlugSchema,
  TimezoneSchema,
  UtcDateTimeSchema,
  queryIntSchema,
} from './common';
import { AppErrorCodeSchema } from './errors';

export const StatsSourceSchema = z.enum([
  'page_views',
  'visitors',
  'product_views',
  'model_starts',
  'model_successes',
  'model_failures',
  'mean_load_duration_ms',
  'chat_starts',
  'inquiries',
  'chat_conversations',
  'chat_messages',
  'chat_notifications',
  'api_requests',
  'api_errors',
  'mail',
  'storage',
  'backup',
]);
export type StatsSource = z.infer<typeof StatsSourceSchema>;

export const StatsSourceStateSchema = z.enum(['ok', 'zero', 'no_data', 'not_connected', 'query_failed', 'stale']);
export type StatsSourceState = z.infer<typeof StatsSourceStateSchema>;

export const StatsCoverageSchema = z.enum(['full', 'partial', 'unavailable']);
export type StatsCoverage = z.infer<typeof StatsCoverageSchema>;

const sourceListSchema = z.array(StatsSourceSchema).min(1).max(17).refine(
  (sources) => new Set(sources).size === sources.length,
  'Sources must be unique.',
);

function validateDateRange(value: { from?: string; to?: string }, context: z.RefinementCtx) {
  if (value.from === undefined || value.to === undefined) return;
  const duration = Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`);
  if (duration < 0 || duration > 399 * 86_400_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'Date range must contain 1 to 400 consecutive days.' });
  }
}

export const StatsQuerySchema = z.object({
  from: LocalDateSchema.optional(),
  to: LocalDateSchema.optional(),
  productSlug: ProductSlugSchema.optional(),
  timezoneRevision: queryIntSchema(2_147_483_647).pipe(PositiveIntSchema).optional(),
  sources: sourceListSchema.optional(),
}).strict().superRefine(validateDateRange);
export type StatsQueryDTO = z.infer<typeof StatsQuerySchema>;

export const StatsSourceDTOSchema = z.object({
  source: StatsSourceSchema,
  state: StatsSourceStateSchema,
  value: z.number().finite().nonnegative().nullable(),
  timezone: TimezoneSchema,
  timezoneRevision: PositiveIntSchema,
  dataThrough: UtcDateTimeSchema.nullable(),
  queriedAt: UtcDateTimeSchema,
  lastSucceededAt: UtcDateTimeSchema.nullable(),
  coverage: StatsCoverageSchema,
  loadDurationSamples: NonNegativeIntSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.source === 'mean_load_duration_ms') {
    if (value.loadDurationSamples === undefined
        || (value.loadDurationSamples === 0) !== (value.value === null)
        || (value.value !== null && value.value > 600_000)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['loadDurationSamples'], message: 'A measured mean requires samples; no samples means a null mean.' });
    }
  } else {
    if (value.loadDurationSamples !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['loadDurationSamples'], message: 'Only model duration means carry samples.' });
    }
    const max = value.source === 'storage' || value.source === 'backup' ? Number.MAX_SAFE_INTEGER : 2_147_483_647;
    if (value.value !== null && (!Number.isSafeInteger(value.value) || value.value > max)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Counts must be bounded integers.' });
    }
  }
  if ((value.state === 'no_data' || value.state === 'not_connected') && value.value !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'An unavailable source cannot supply a value.' });
  }
  if (value.state === 'zero' && value.value !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'A zero source must contain zero.' });
  }
  if (value.state === 'ok' && (value.value === null || value.value === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'An ok source must contain a nonzero value.' });
  }
  if (value.state === 'stale' && value.value === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'A stale source must retain its last successful value.' });
  }
  if (value.value !== null && value.lastSucceededAt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['lastSucceededAt'], message: 'A value requires a real last successful time.' });
  }
});
export type StatsSourceDTO = z.infer<typeof StatsSourceDTOSchema>;

export const StatsDTOSchema = z.object({
  sources: z.array(StatsSourceDTOSchema).min(1).max(17),
}).strict().superRefine((value, context) => {
  if (new Set(value.sources.map((source) => source.source)).size !== value.sources.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'Sources must be unique.' });
  }
});
export type StatsDTO = z.infer<typeof StatsDTOSchema>;

export const JobKeySchema = z.enum([
  'analytics-aggregate',
  'analytics-retention',
  'chat-notifications',
  'chat-retention',
  'mail-queue',
  'ops-sample',
]);
export type JobKey = z.infer<typeof JobKeySchema>;

export const OperationsRequestSchema = z.union([
  z.object({ jobKey: z.enum(['analytics-retention', 'chat-retention']), dryRun: z.boolean().default(true) }).strict(),
  z.object({ jobKey: z.enum(['analytics-aggregate', 'chat-notifications', 'mail-queue', 'ops-sample']) }).strict(),
]);
export type OperationsRequestDTO = z.infer<typeof OperationsRequestSchema>;

export const JobCountsSchema = z.object({
  candidateCount: NonNegativeIntSchema.optional(),
  deletedCount: NonNegativeIntSchema.optional(),
  stale: NonNegativeIntSchema.optional(),
  sent: NonNegativeIntSchema.optional(),
  failed: NonNegativeIntSchema.optional(),
  deferred: NonNegativeIntSchema.optional(),
  dropped: NonNegativeIntSchema.optional(),
}).strict();
export type JobCountsDTO = z.infer<typeof JobCountsSchema>;

export const JobResultStatusSchema = z.enum(['SUCCEEDED', 'FAILED', 'PARTIAL']);
export type JobResultStatus = z.infer<typeof JobResultStatusSchema>;

export const JobResultDTOSchema = z.object({
  jobKey: JobKeySchema,
  status: JobResultStatusSchema,
  counts: JobCountsSchema,
  finishedAt: UtcDateTimeSchema,
}).strict();
export type JobResultDTO = z.infer<typeof JobResultDTOSchema>;

export const OpsSourceSchema = z.enum(['STORAGE', 'BACKUP']);
export type OpsSource = z.infer<typeof OpsSourceSchema>;

export const OpsReportStatusSchema = z.enum(['OK', 'FAILED', 'NOT_CONNECTED']);
export type OpsReportStatus = z.infer<typeof OpsReportStatusSchema>;

export const StorageValuesSchema = z.object({
  bytesUsed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  bytesFree: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type StorageValuesDTO = z.infer<typeof StorageValuesSchema>;

export const BackupValuesSchema = z.object({
  backupCompletedAt: UtcDateTimeSchema,
  backupAgeSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  verified: z.boolean(),
}).strict();
export type BackupValuesDTO = z.infer<typeof BackupValuesSchema>;

const reportFields = {
  measuredAt: UtcDateTimeSchema,
  status: OpsReportStatusSchema,
  safeErrorCode: AppErrorCodeSchema.nullable().optional(),
};

export const OpsReportRequestSchema = z.discriminatedUnion('source', [
  z.object({ ...reportFields, source: z.literal('STORAGE'), values: StorageValuesSchema.nullable().optional() }).strict(),
  z.object({ ...reportFields, source: z.literal('BACKUP'), values: BackupValuesSchema.nullable().optional() }).strict(),
]).superRefine((value, context) => {
  if (value.status === 'OK' && value.values == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['values'], message: 'A successful report requires source values.' });
  }
  if (value.status === 'OK' && value.safeErrorCode != null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['safeErrorCode'], message: 'A successful report cannot contain an error code.' });
  }
  if (value.source === 'BACKUP' && value.values != null && Date.parse(value.values.backupCompletedAt) > Date.parse(value.measuredAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['values', 'backupCompletedAt'], message: 'Backup completion cannot follow the measurement.' });
  }
});
export type OpsReportRequestDTO = z.infer<typeof OpsReportRequestSchema>;

export const OpsReportReceiptDTOSchema = z.object({
  accepted: z.boolean(),
  measuredAt: UtcDateTimeSchema,
}).strict();
export type OpsReportReceiptDTO = z.infer<typeof OpsReportReceiptDTOSchema>;
