export type OwnerTarget = { id: string; role: string; disabled: boolean; totpEnabled: boolean; sessionVersion: number };
export type PermitRow = {
  id: string;
  tokenHash: string;
  targetUserId: string;
  source: 'SERVER_OWNER';
  issuedById: null;
  reason: string;
  pendingPasswordHash: string | null;
  sessionVersion: number;
  createdAt: Date;
  expiresAt: Date;
};
export type AuditMeta = {
  source: 'SERVER_OWNER';
  reason: string;
  time: string;
  actor: string;
  via: string;
  passwordReset: boolean;
};
export type AuthorizeArgs = {
  email?: string;
  id?: string;
  reason?: string;
  role?: string;
  setPassword: boolean;
  help: boolean;
  error?: never;
};
export type AuthorizeArgError = { error: string };

export const PERMIT_TTL_MS: number;
export const ARGON: { memoryCost: number; timeCost: number; parallelism: number };
export const VIA: 'cli:admin-authorize-recovery';
export const REASON_MAX: number;
export const USAGE: string;
export const MESSAGES: Record<string, string>;
export const EXIT: { ok: 0; error: 1; usage: 2; refused: 3 };

export function exitCodeOf(code: string): number;
export function parseArgs(argv: string[]): AuthorizeArgs | AuthorizeArgError;
export function hashPermitToken(token: string): string;
export function passwordPolicyError(password: string, email?: string): string | null;
export function hasOsAdminPrivilege(
  platform: string,
  deps?: { openProtected?: () => Promise<void>; geteuid?: () => number | undefined },
): Promise<boolean>;
export function openProtectedOnWindows(): Promise<void>;
export function stripPasswordEnv(env: Record<string, string | undefined>): string[];
export function promptPassword(
  email: string | undefined,
  deps: { stdin: { isTTY?: boolean }; stderr: { write: (s: string) => void } },
): Promise<{ password: string } | { error: string }>;
export function decideTarget(target: OwnerTarget | null | undefined, declaredRole?: string): string | null;
export function permitLines(token: string, expiresAt: Date): string[];
export function auditMeta(input: {
  now: Date;
  actor: string;
  target: string;
  reason: string;
  hasPendingPassword: boolean;
}): AuditMeta;
export function buildPermitRow(input: {
  targetUserId: string;
  reason: string;
  pendingPasswordHash?: string | null;
  sessionVersion: number;
  now: Date;
}): { token: string; row: PermitRow };

export type AuthorizeDeps = {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: string;
  stdin: { isTTY?: boolean; setRawMode?: (b: boolean) => void; resume?: () => void; pause?: () => void; setEncoding?: (e: string) => void; on?: (e: string, cb: (c: string) => void) => void; removeListener?: (e: string, cb: (c: string) => void) => void };
  stdout: { isTTY?: boolean; write: (s: string) => void };
  stderr: { write: (s: string) => void };
  now: () => Date;
  noDatabaseUrl: boolean;
  geteuid?: () => number | undefined;
  openProtected?: () => Promise<void>;
  hash: (password: string) => Promise<string>;
  db: {
    findById: (id: string) => Promise<OwnerTarget | undefined>;
    findByEmail: (email: string) => Promise<OwnerTarget | undefined>;
    writePermit: (row: PermitRow, meta: AuditMeta) => Promise<void>;
  };
};
export function runAuthorize(deps: AuthorizeDeps): Promise<number>;
