import { z } from 'zod';
import { UuidSchema } from './common';

export const AppErrorCodeSchema = z.enum([
  'invalid', 'too_large', 'unauthorized', 'account_disabled', 'forbidden', 'forbidden_origin', 'not_found',
  'rate_limited', 'version_conflict', 'idempotency_conflict', 'conversation_closed', 'conversation_anonymized',
  'analytics_consent_required', 'event_time_out_of_range', 'action_grant_invalid', 'bad_credentials',
  'recovery_expired', 'job_busy', 'source_unavailable', 'service_unavailable', 'internal_error',
]);
export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;
const MessageSchema = z.string().min(1).max(200).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
export const FieldErrorSchema = z.object({
  email: MessageSchema.optional(), password: MessageSchema.optional(), newPassword: MessageSchema.optional(),
  currentPassword: MessageSchema.optional(), totp: MessageSchema.optional(), mode: MessageSchema.optional(),
  rememberDevice: MessageSchema.optional(), recoveryCode: MessageSchema.optional(), purpose: MessageSchema.optional(),
  targetId: MessageSchema.optional(), targetUserId: MessageSchema.optional(), reason: MessageSchema.optional(),
  actionGrant: MessageSchema.optional(), credentialKind: MessageSchema.optional(), credential: MessageSchema.optional(),
  passwordlessEnabled: MessageSchema.optional(), cursor: MessageSchema.optional(), limit: MessageSchema.optional(),
  locale: MessageSchema.optional(), clientMessageId: MessageSchema.optional(), clientConversationId: MessageSchema.optional(),
  bodyText: MessageSchema.optional(), productSlug: MessageSchema.optional(), sourcePath: MessageSchema.optional(),
  afterSeq: MessageSchema.optional(), lastReadSeq: MessageSchema.optional(), status: MessageSchema.optional(),
  expectedVersion: MessageSchema.optional(), unreadOnly: MessageSchema.optional(), analytics: MessageSchema.optional(),
  consentVersion: MessageSchema.optional(), events: MessageSchema.optional(), timezone: MessageSchema.optional(),
  timezoneRevision: MessageSchema.optional(), from: MessageSchema.optional(), to: MessageSchema.optional(), sources: MessageSchema.optional(),
  jobKey: MessageSchema.optional(), dryRun: MessageSchema.optional(), source: MessageSchema.optional(),
  measuredAt: MessageSchema.optional(), values: MessageSchema.optional(), safeErrorCode: MessageSchema.optional(),
}).strict();
export type FieldError = z.infer<typeof FieldErrorSchema>;
export const AppErrorDTOSchema = z.object({ error: AppErrorCodeSchema, requestId: UuidSchema, fieldErrors: FieldErrorSchema.optional() }).strict();
export type AppErrorDTO = z.infer<typeof AppErrorDTOSchema>;
export const LegacyGuardErrorSchema = z.object({ error: z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/) }).strict();
export type LegacyGuardError = z.infer<typeof LegacyGuardErrorSchema>;
