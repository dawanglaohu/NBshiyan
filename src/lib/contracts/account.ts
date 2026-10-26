import { z } from 'zod';
import { EmailSchema, EmptyRequestSchema, IdSchema, NonNegativeIntSchema, TokenSchema, TotpSchema, UtcDateTimeSchema, makeCursorSchema, queryIntSchema } from './common';

export const LoginModeSchema = z.enum(['password', 'totp']);
export type LoginMode = z.infer<typeof LoginModeSchema>;
export const RoleSchema = z.enum(['ADMIN', 'SALES', 'EDITOR']);
export type AccountRole = z.infer<typeof RoleSchema>;
// Auth.js carries strings; accepting boolean true here would exceed its explicit field protocol (E-95).
export const RememberDeviceSchema = z.union([z.literal('true'), z.literal('false'), z.literal(false)])
  .optional().transform((value) => value === 'true');
const PasswordSchema = z.string().min(1).max(200);
export const NewPasswordSchema = z.string().min(12).max(200);

function emptyToAbsent(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

// 原始输入最长 40。去掉空白和连字符并转成小写后，必须是签发时的 10 位十六进制。空字符串视为没带。
function loginRecoveryInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 40) return trimmed;
  return trimmed.replace(/[\s-]/g, '').toLowerCase();
}

const LoginRecoveryCodeSchema = z.string().max(40).regex(/^[a-f0-9]{10}$/);

type LoginShape = {
  mode: LoginMode;
  email?: string;
  password?: string;
  totp?: string;
  recoveryCode?: string;
};

/** 第二步只提交验证码。邮箱和密码都不在请求里，挑战放在 cookie 里。 */
function challengeContinuation(input: LoginShape): boolean {
  return input.mode === 'password'
    && input.email === undefined
    && input.password === undefined
    && input.recoveryCode === undefined
    && input.totp !== undefined;
}

export const LoginRequestSchema = z.object({
  email: EmailSchema.pipe(z.string().max(200)).optional(), mode: LoginModeSchema.default('password'),
  password: PasswordSchema.optional(),
  totp: z.preprocess(emptyToAbsent, TotpSchema.optional()),
  rememberDevice: RememberDeviceSchema,
  recoveryCode: z.preprocess(loginRecoveryInput, LoginRecoveryCodeSchema.optional()),
}).strict()
  .refine((input) => challengeContinuation(input) || input.email !== undefined, { path: ['email'], message: 'Email required' })
  .refine((input) => challengeContinuation(input) || input.mode !== 'password' || input.password !== undefined, { path: ['password'], message: 'Password required' })
  .refine((input) => input.totp !== undefined || input.recoveryCode !== undefined, { path: ['totp'], message: 'Authenticator or recovery code required' });
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const ActionPurposeSchema = z.enum(['LOGIN_MODE', 'PASSWORD', 'TOTP_RESET', 'RECOVERY_AUTHORIZE', 'DEVICE_REVOKE', 'LOGOUT_ALL']);
export type ActionPurpose = z.infer<typeof ActionPurposeSchema>;
export const ReauthRequestSchema = z.object({
  purpose: ActionPurposeSchema, targetId: IdSchema.optional(), password: PasswordSchema, totp: TotpSchema,
}).strict().refine((input) => !['RECOVERY_AUTHORIZE', 'DEVICE_REVOKE'].includes(input.purpose) || input.targetId !== undefined,
  { path: ['targetId'], message: 'Target required' });
export type ReauthRequest = z.infer<typeof ReauthRequestSchema>;
export const ActionGrantDTOSchema = z.object({ token: TokenSchema, purpose: ActionPurposeSchema, expiresAt: UtcDateTimeSchema }).strict();
export type ActionGrantDTO = z.infer<typeof ActionGrantDTOSchema>;
export const AccountModeRequestSchema = z.object({ passwordlessEnabled: z.boolean(), actionGrant: TokenSchema }).strict();
export type AccountModeRequest = z.infer<typeof AccountModeRequestSchema>;
export const AccountModeDTOSchema = z.object({ passwordlessEnabled: z.boolean(), changedAt: UtcDateTimeSchema }).strict();
export type AccountModeDTO = z.infer<typeof AccountModeDTOSchema>;

const FreshCredentialsShape = { currentPassword: PasswordSchema, totp: TotpSchema, recoveryCode: z.literal('').optional() };
export const PasswordChangeRequestSchema = z.union([
  z.object({ newPassword: NewPasswordSchema, actionGrant: TokenSchema }).strict(),
  z.object({ newPassword: NewPasswordSchema, ...FreshCredentialsShape }).strict(),
]);
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>;
export const PasswordChangeDTOSchema = z.object({ ok: z.literal(true), reauthRequired: z.literal(true) }).strict();
export type PasswordChangeDTO = z.infer<typeof PasswordChangeDTOSchema>;
export const TotpResetRequestSchema = z.union([
  z.object({ actionGrant: TokenSchema }).strict(), z.object(FreshCredentialsShape).strict(),
]);
export type TotpResetRequest = z.infer<typeof TotpResetRequestSchema>;
export const TotpResetDTOSchema = z.object({
  ok: z.literal(true), reenrollRequired: z.literal(true), enrollLink: z.string().min(1).max(2048),
  expiresAt: UtcDateTimeSchema.optional(), expiresTruncated: z.boolean().optional(),
}).strict();
export type TotpResetDTO = z.infer<typeof TotpResetDTOSchema>;

export const DeviceDTOSchema = z.object({
  id: IdSchema, current: z.boolean(), remembered: z.boolean(), createdAt: UtcDateTimeSchema,
  lastActivityAt: UtcDateTimeSchema, effectiveExpiresAt: UtcDateTimeSchema,
  absoluteExpiresAt: UtcDateTimeSchema.nullable(), revokedAt: UtcDateTimeSchema.nullable(),
  deviceLabel: z.string().min(1).max(200).nullable(),
}).strict().superRefine((device, ctx) => {
  if (Date.parse(device.lastActivityAt) < Date.parse(device.createdAt)
      || Date.parse(device.effectiveExpiresAt) < Date.parse(device.lastActivityAt)
      || (device.absoluteExpiresAt !== null && Date.parse(device.effectiveExpiresAt) > Date.parse(device.absoluteExpiresAt))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid device dates' });
  }
  if (device.remembered !== (device.absoluteExpiresAt !== null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Remembered device requires absolute expiry' });
});
export type DeviceDTO = z.infer<typeof DeviceDTOSchema>;
export const AccountDTOSchema = z.object({
  id: IdSchema, name: z.string().max(200).nullable(), email: EmailSchema, role: RoleSchema,
  passwordlessEnabled: z.boolean(), totpEnabled: z.boolean(), currentDevice: DeviceDTOSchema,
}).strict();
export type AccountDTO = z.infer<typeof AccountDTOSchema>;
export const DeviceCursorSchema = makeCursorSchema('createdAt');
export const DevicePageQuerySchema = z.object({ cursor: DeviceCursorSchema.optional(), limit: queryIntSchema(50).refine((n) => n >= 1).default(25) }).strict();
export type DevicePageQuery = z.infer<typeof DevicePageQuerySchema>;
export const DevicePageDTOSchema = z.object({ items: z.array(DeviceDTOSchema).max(50), nextCursor: DeviceCursorSchema.nullable(), hasMore: z.boolean() })
  .strict().refine((page) => page.hasMore === (page.nextCursor !== null));
export type DevicePageDTO = z.infer<typeof DevicePageDTOSchema>;
export const DeviceRevokeRequestSchema = z.object({ actionGrant: TokenSchema }).strict();
export type DeviceRevokeRequest = z.infer<typeof DeviceRevokeRequestSchema>;
export const DeviceRevokeDTOSchema = z.object({ id: IdSchema, revokedAt: UtcDateTimeSchema }).strict();
export type DeviceRevokeDTO = z.infer<typeof DeviceRevokeDTOSchema>;
export const LogoutAllRequestSchema = z.object({ actionGrant: TokenSchema }).strict();
export type LogoutAllRequest = z.infer<typeof LogoutAllRequestSchema>;
export const SignedOutDTOSchema = z.object({ signedOut: z.literal(true) }).strict();
export type SignedOutDTO = z.infer<typeof SignedOutDTOSchema>;
export const SessionActivityRequestSchema = EmptyRequestSchema;
export type SessionActivityRequest = z.infer<typeof SessionActivityRequestSchema>;
export const SessionActivityDTOSchema = z.object({ effectiveExpiresAt: UtcDateTimeSchema, absoluteExpiresAt: UtcDateTimeSchema.nullable() })
  .strict().refine((session) => session.absoluteExpiresAt === null || Date.parse(session.effectiveExpiresAt) <= Date.parse(session.absoluteExpiresAt));
export type SessionActivityDTO = z.infer<typeof SessionActivityDTOSchema>;

// Metadata is optional until the device-session adapter supplies it; it is never a client authorization input.
export const AuthSessionMetadataSchema = z.object({ sid: IdSchema.optional(), sv: NonNegativeIntSchema.optional(),
  effectiveExpiresAt: UtcDateTimeSchema.optional(), absoluteExpiresAt: UtcDateTimeSchema.nullable().optional() }).strict();
export type AuthSessionMetadata = z.infer<typeof AuthSessionMetadataSchema>;
