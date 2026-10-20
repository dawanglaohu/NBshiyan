import { z } from 'zod';
import { EmailSchema, EmptyRequestSchema, IdSchema, TokenSchema, TotpSchema, UtcDateTimeSchema } from './common';

export const RecoveryCodeSchema = z.string().regex(/^[a-f0-9]{10}$/);
const OtpauthUriSchema = z.string().max(2048).url().startsWith('otpauth://totp/');
// Initial enrollment retains its existing fields; restricted recovery adds a separate expiry/state protocol.
export const LegacyEnrollRequestSchema = z.object({
  email: EmailSchema.pipe(z.string().max(200)).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(200), token: z.string().max(200).optional(),
}).strict();
export type LegacyEnrollRequest = z.infer<typeof LegacyEnrollRequestSchema>;
export const LegacyEnrollConfirmRequestSchema = LegacyEnrollRequestSchema.extend({ totp: TotpSchema }).strict();
export type LegacyEnrollConfirmRequest = z.infer<typeof LegacyEnrollConfirmRequestSchema>;
export const LegacyEnrollDTOSchema = z.object({ otpauthUri: OtpauthUriSchema }).strict();
export type LegacyEnrollDTO = z.infer<typeof LegacyEnrollDTOSchema>;
export const LegacyEnrollCompleteDTOSchema = z.object({ recoveryCodes: z.array(RecoveryCodeSchema).length(10) }).strict();
export type LegacyEnrollCompleteDTO = z.infer<typeof LegacyEnrollCompleteDTOSchema>;
const ReasonSchema = z.string().trim().min(1).max(500).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
export const RecoveryAuthorizationRequestSchema = z.object({ targetUserId: IdSchema, reason: ReasonSchema, actionGrant: TokenSchema }).strict();
export type RecoveryAuthorizationRequest = z.infer<typeof RecoveryAuthorizationRequestSchema>;
export const AdminResetTotpRequestSchema = z.object({ reason: ReasonSchema, actionGrant: TokenSchema }).strict();
export type AdminResetTotpRequest = z.infer<typeof AdminResetTotpRequestSchema>;
export const RecoveryPermitDTOSchema = z.object({ token: TokenSchema, expiresAt: UtcDateTimeSchema }).strict();
export type RecoveryPermitDTO = z.infer<typeof RecoveryPermitDTOSchema>;
export const RecoveryStartRequestSchema = z.discriminatedUnion('credentialKind', [
  z.object({ email: EmailSchema, credentialKind: z.literal('RECOVERY_CODE'), credential: RecoveryCodeSchema }).strict(),
  z.object({ email: EmailSchema, credentialKind: z.literal('PERMIT'), credential: TokenSchema }).strict(),
]);
export type RecoveryStartRequest = z.infer<typeof RecoveryStartRequestSchema>;
export const RecoveryStateDTOSchema = z.object({ restricted: z.literal(true), expiresAt: UtcDateTimeSchema }).strict();
export type RecoveryStateDTO = z.infer<typeof RecoveryStateDTOSchema>;
export const RecoveryEnrollRequestSchema = EmptyRequestSchema;
export type RecoveryEnrollRequest = z.infer<typeof RecoveryEnrollRequestSchema>;
export const RecoveryEnrollDTOSchema = z.object({ otpauthUri: OtpauthUriSchema, expiresAt: UtcDateTimeSchema }).strict();
export type RecoveryEnrollDTO = z.infer<typeof RecoveryEnrollDTOSchema>;
export const RecoveryConfirmRequestSchema = z.object({ totp: TotpSchema }).strict();
export type RecoveryConfirmRequest = z.infer<typeof RecoveryConfirmRequestSchema>;
export const RecoveryCompleteDTOSchema = z.object({ completed: z.literal(true), recoveryCodes: z.array(RecoveryCodeSchema).length(10) }).strict();
export type RecoveryCompleteDTO = z.infer<typeof RecoveryCompleteDTOSchema>;
