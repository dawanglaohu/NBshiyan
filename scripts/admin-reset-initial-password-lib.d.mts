import type { Issued } from './enroll-token-lib.mjs';
export const ARGON: { memoryCost: number; timeCost: number; parallelism: number };
export function firstLine(text: string): string;
export const ENROLL_WINDOW_MS: number;
export const LOGIN_WINDOW_MS: number;
export const VIA: 'cli:admin-reset-initial-password';
export const CLEAR_FLAG: '--clear-pending-enroll';
export const IGNORED_PASSWORD_ENVS: string[];
export const USAGE: string;
export const MESSAGES: Record<string, string>;
export const EXIT: { ok: 0; error: 1; usage: 2; refused: 3 };
export function exitCodeOf(code: string): number;
export type ResetArgs = { email?: string; id?: string; clearPendingEnroll: boolean; help: boolean; error?: undefined };
export function parseArgs(argv: string[]): ResetArgs | { error: string };
export function stripPasswordEnv(env: Record<string, string | undefined>): string[];
export type ResetUser = {
  id: string; email: string; role: string; disabled: boolean; totpEnabled: boolean; totpSecret: string | null; totpLastStep: number | null;
  enrollIssuedAt: Date | null; totpPendingUntil: Date | null; totpEnrollFails: number; createdAt: Date;
};
export function enrollWindowOpen(u: Pick<ResetUser, 'enrollIssuedAt' | 'createdAt'>, now: number): boolean;
export function hasPendingEnroll(u: Partial<ResetUser>): boolean;
export type Plan = { clearPending: boolean; hadPending?: boolean; windowWasOpen?: boolean };
export function decide(u: ResetUser | null | undefined, o: { clearPendingEnroll: boolean; now: number }): string | Plan;
export function resetData(passwordHash: string, plan: Plan, now: number): Record<string, unknown>;
export function auditEntries(userId: string, plan: Plan, issued?: Issued): { actorId: null; target: string; ip: null; action: string; meta: Record<string, unknown> }[];
export function windowStartAfter(u: Pick<ResetUser, 'enrollIssuedAt' | 'createdAt'>, plan: Plan, now: number): number;
export function rateLimitEnv(env: Record<string, string | undefined>): string;
export function rateLimitKeyHash(value: string, env: Record<string, string | undefined>): string;
export const ENROLL_CONFIRM_WINDOW_MS: number;
export const UNTRUSTED: 'untrusted';
export function accountOnlyRateKeys(email: string, env: Record<string, string | undefined>): { key: string; windowMs: number }[];
export function upstashKey(key: string, env: Record<string, string | undefined>, now: number, windowMs?: number, offset?: number): string;
export function rateKeysToDelete(email: string, env: Record<string, string | undefined>, now: number): string[];
/** 读一条 RESP。数据不够返回 null。与应用里的 parseResp 对照。 */
export function readResp(buf: Buffer, at?: number, depth?: number): { kind: string; next: number; value?: unknown } | null;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
export function clearAccountRateLimits(o: { email: string; env: Record<string, string | undefined>; now: number; fetchImpl?: FetchLike }): Promise<'cleared' | 'skipped_memory' | 'failed'>;
export function safeErrorCode(e: unknown): string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ResetDb = any;
export function runReset(o: {
  argv: string[];
  env: Record<string, string | undefined>;
  readPassword: () => Promise<string | { error: string } | undefined>;
  db: () => Promise<ResetDb>;
  hash: (pw: string) => Promise<string>;
  /** 不传则用 https.request，并读取 env.NODE_EXTRA_CA_CERTS */
  fetchImpl?: FetchLike;
  now?: () => number;
  out: (s: string) => void;
  err: (s: string) => void;
  /** #347：stdout 是不是终端；不是 true 就拒绝运行（退出 2） */
  stdoutIsTTY?: boolean;
  /** stdin 是不是终端；不是 true 就拒绝运行（退出 2，stdin_not_tty），先于读密码、连库和签发令牌 */
  stdinIsTTY?: boolean;
  /** #347：签发令牌（默认 enroll-token-lib newEnrollToken） */
  issueToken?: (now: number, windowStart: number) => Issued;
}): Promise<number>;
