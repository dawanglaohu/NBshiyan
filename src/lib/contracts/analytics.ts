import { z } from 'zod';
import {
  LocaleSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  ProductSlugSchema,
  SitePathSchema,
  TimezoneSchema,
  UtcDateTimeSchema,
  UuidSchema,
} from './common';

export const AnalyticsEventKindSchema = z.enum([
  'page_view',
  'product_view',
  'model_view_start',
  'model_load_success',
  'model_load_failure',
  'chat_start',
]);
export type AnalyticsEventKind = z.infer<typeof AnalyticsEventKindSchema>;

export const ModelFailureReasonSchema = z.enum(['LOAD_ERROR', 'TIMEOUT', 'WEBGL_UNAVAILABLE']);
export type ModelFailureReason = z.infer<typeof ModelFailureReasonSchema>;

/**
 * `productSlug` is the internal key (`products[].slug`), not a localized category URL slug.
 * Ingest also accepts a published READY Model3D slug.
 */

const eventFields = {
  eventId: UuidSchema,
  occurredAt: UtcDateTimeSchema,
  locale: LocaleSchema,
};
const navigationFields = {
  ...eventFields,
  navigationId: UuidSchema,
};
const modelFields = {
  ...navigationFields,
  viewId: UuidSchema,
  productSlug: ProductSlugSchema,
  path: SitePathSchema.optional(),
};

export const PageViewEventSchema = z.object({
  ...navigationFields,
  kind: z.literal('page_view'),
  path: SitePathSchema,
}).strict();
export const ProductViewEventSchema = z.object({
  ...navigationFields,
  kind: z.literal('product_view'),
  productSlug: ProductSlugSchema,
  path: SitePathSchema.optional(),
}).strict();
export const ModelViewStartEventSchema = z.object({
  ...modelFields,
  kind: z.literal('model_view_start'),
}).strict();
export const ModelLoadSuccessEventSchema = z.object({
  ...modelFields,
  kind: z.literal('model_load_success'),
  durationMs: z.number().int().min(0).max(600_000),
}).strict();
export const ModelLoadFailureEventSchema = z.object({
  ...modelFields,
  kind: z.literal('model_load_failure'),
  durationMs: z.number().int().min(0).max(600_000),
  failureReason: ModelFailureReasonSchema,
}).strict();
export const ChatStartEventSchema = z.object({
  ...navigationFields,
  kind: z.literal('chat_start'),
  path: SitePathSchema.optional(),
  productSlug: ProductSlugSchema.optional(),
}).strict();

export const AnalyticsEventDTOSchema = z.discriminatedUnion('kind', [
  PageViewEventSchema,
  ProductViewEventSchema,
  ModelViewStartEventSchema,
  ModelLoadSuccessEventSchema,
  ModelLoadFailureEventSchema,
  ChatStartEventSchema,
]);
export type AnalyticsEventDTO = z.infer<typeof AnalyticsEventDTOSchema>;

export const ConsentRequestSchema = z.object({
  analytics: z.boolean(),
  consentVersion: PositiveIntSchema,
}).strict();
export type ConsentRequestDTO = z.infer<typeof ConsentRequestSchema>;

export const ConsentDTOSchema = z.discriminatedUnion('analytics', [
  z.object({ analytics: z.literal(true), expiresAt: UtcDateTimeSchema }).strict(),
  z.object({ analytics: z.literal(false), expiresAt: z.null() }).strict(),
]);
export type ConsentDTO = z.infer<typeof ConsentDTOSchema>;

export const AnalyticsEventsRequestSchema = z.object({
  events: z.array(AnalyticsEventDTOSchema).min(1).max(20),
}).strict();
export type AnalyticsEventsRequestDTO = z.infer<typeof AnalyticsEventsRequestSchema>;

export const AnalyticsReceiptDTOSchema = z.object({
  acceptedIds: z.array(UuidSchema).max(20),
  duplicateIds: z.array(UuidSchema).max(20),
  receivedAt: UtcDateTimeSchema,
}).strict().superRefine((value, context) => {
  const ids = [...value.acceptedIds, ...value.duplicateIds];
  if (ids.length < 1 || ids.length > 20 || new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['acceptedIds'], message: 'Receipt identifiers must be unique and total 1 to 20.' });
  }
});
export type AnalyticsReceiptDTO = z.infer<typeof AnalyticsReceiptDTOSchema>;

export const AnalyticsSettingsDTOSchema = z.object({
  version: NonNegativeIntSchema,
  timezone: TimezoneSchema,
  timezoneRevision: PositiveIntSchema,
  recomputableFrom: UtcDateTimeSchema.nullable(),
}).strict();
export type AnalyticsSettingsDTO = z.infer<typeof AnalyticsSettingsDTOSchema>;

export const AnalyticsSettingsUpdateRequestSchema = z.object({
  timezone: TimezoneSchema,
  expectedVersion: NonNegativeIntSchema,
}).strict();
export type AnalyticsSettingsUpdateRequestDTO = z.infer<typeof AnalyticsSettingsUpdateRequestSchema>;

export const AnalyticsSettingsUpdateDTOSchema = AnalyticsSettingsDTOSchema.extend({
  rebuildScheduled: z.boolean(),
}).strict();
export type AnalyticsSettingsUpdateDTO = z.infer<typeof AnalyticsSettingsUpdateDTOSchema>;
