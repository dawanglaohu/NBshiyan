import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type User } from '@prisma/client';
import { authenticator } from 'otplib';
import { ActionGrantDTOSchema, ReauthRequestSchema, type ActionPurpose } from '@/lib/contracts/account';
import { AppErrorCodeSchema, type AppErrorCode } from '@/lib/contracts/errors';
import { ADMIN_GRANT_POLICY, ADMIN_SESSION_POLICY } from '@/lib/server/config';
import { prisma } from '@/lib/server/db';
import { isDbUnavailable } from '@/lib/server/designs';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import type { ApiCounter } from '@/lib/server/http/metrics';
import { hitRateLimit, rateLimitKeyHash, rateLimitSubject } from '@/lib/server/security';
import { decrypt, verifySecret } from './crypto';
import { isStrictlyBefore } from './device-session';
import { requireAdmin, withClearedSession } from './guard';
import { readJson, TOO_LARGE } from './inquiries';
import { consumeTotpStep } from './login';
import { effectiveDeadline, type ExpiryPolicy } from './session-expiry';

const SELF_PURPOSES = new Set<ActionPurpose>(['LOGIN_MODE', 'PASSWORD', 'TOTP_RESET', 'LOGOUT_ALL']);
const REAUTH_WINDOW_MS = 10 * 60_000;
const REAUTH_ACCOUNT_LIMIT = 5;
const REAUTH_IP_LIMIT = 20;
const BODY_LIMIT = 2_000;
export const REAUTH_ROUTE_ID = 'POST /api/admin/account/reauth';

type TotpStepUser = Pick<User, 'id' | 'totpSecret' | 'totpEnabled' | 'sessionVersion'>;
type GrantDb = PrismaClient | Prisma.TransactionClient;

export type IssueActionGrantInput = {
  userId: string;
  sid: string;
  purpose: ActionPurpose;
  targetId?: string;
  password: string;
  totp: string;
  ip?: string | null;
};

export type IssuedActionGrant = {
  token: string;
  purpose: ActionPurpose;
  expiresAt: Date;
};

export type ConsumeActionGrantInput = {
  token: string;
  purpose: ActionPurpose;
  targetId: string | null;
  userId: string;
  sid: string;
};

export type ActionGrantService = {
  issue(input: IssueActionGrantInput): Promise<IssuedActionGrant>;
  consume(input: ConsumeActionGrantInput, tx?: Prisma.TransactionClient): Promise<boolean>;
};

type LockedUser = {
  id: string;
  sessionVersion: number;
  disabled: boolean;
  totpEnabled: boolean;
  totpSecret: string | null;
  lockedUntil: Date | null;
  role: User['role'];
};

type LockedDevice = {
  id: string;
  userId: string;
  sessionVersion: number;
  revokedAt: Date | null;
  remembered: boolean;
  createdAt: Date;
  lastActivityAt: Date;
  absoluteExpiresAt: Date | null;
  hardExpiresAt: Date | null;
};

/** 明文只在签发响应里出现一次。库里的 tokenHash 是这段 UTF-8 的 SHA-256 十六进制。 */
export function hashGrantToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newGrantToken(): string {
  return randomBytes(32).toString('base64url');
}

function accountOpen(user: Pick<LockedUser, 'disabled' | 'totpEnabled' | 'lockedUntil'>, now: Date): boolean {
  return !user.disabled && user.totpEnabled && !(user.lockedUntil && user.lockedUntil > now);
}

function deviceOpen(device: LockedDevice, user: Pick<LockedUser, 'id' | 'sessionVersion'>, now: Date, policy: ExpiryPolicy): boolean {
  if (device.userId !== user.id || device.revokedAt || device.sessionVersion !== user.sessionVersion) return false;
  return isStrictlyBefore(now, effectiveDeadline(device, policy));
}

/**
 * 核销必须先锁用户再锁设备，然后才改授权。调用方如果传入事务，不要提前锁这三行。
 * 时间步核销不进这个事务：consumeTotpStep 用的是另一条连接，持着用户行锁再调它会死锁。
 */
async function lockUserAndDevice(tx: GrantDb, userId: string, sid: string): Promise<{ user: LockedUser | undefined; device: LockedDevice | undefined }> {
  const users = await tx.$queryRaw<LockedUser[]>`
    SELECT id, "sessionVersion", disabled, "totpEnabled", "totpSecret", "lockedUntil", "role"
    FROM "User"
    WHERE id = ${userId}
    FOR UPDATE
  `;
  const devices = await tx.$queryRaw<LockedDevice[]>`
    SELECT id, "userId", "sessionVersion", "revokedAt", remembered, "createdAt", "lastActivityAt",
           "absoluteExpiresAt", "hardExpiresAt"
    FROM "AdminDeviceSession"
    WHERE id = ${sid}
    FOR UPDATE
  `;
  return { user: users[0], device: devices[0] };
}

export function createActionGrantService(deps: {
  db?: PrismaClient;
  clock?: () => Date;
  grantTtlMs?: number;
  sessionPolicy?: ExpiryPolicy;
  consumeStep?: (user: TotpStepUser, totp: string | undefined) => Promise<boolean>;
  verifyPassword?: (hash: string, password: string) => Promise<boolean>;
} = {}): ActionGrantService {
  const db = deps.db ?? prisma;
  const clock = deps.clock ?? (() => new Date());
  const grantTtlMs = deps.grantTtlMs ?? ADMIN_GRANT_POLICY.ttlMs;
  const sessionPolicy = deps.sessionPolicy ?? ADMIN_SESSION_POLICY;
  const consumeStep = deps.consumeStep ?? consumeTotpStep;
  const verifyPassword = deps.verifyPassword ?? verifySecret;

  async function storedTarget(user: User, purpose: ActionPurpose, targetId: string | undefined): Promise<string | null> {
    if (purpose === 'RECOVERY_AUTHORIZE') {
      if (user.role !== 'ADMIN') throw new AppError('forbidden');
      if (!targetId || targetId === user.id) throw new AppError('forbidden', { fieldErrors: { targetId: 'Choose another account.' } });
      const target = await db.user.findUnique({ where: { id: targetId }, select: { id: true } });
      if (!target) throw new AppError('not_found');
      return targetId;
    }
    if (purpose === 'DEVICE_REVOKE') {
      if (!targetId) throw new AppError('invalid', { fieldErrors: { targetId: 'Target required' } });
      const device = await db.adminDeviceSession.findUnique({ where: { id: targetId }, select: { userId: true } });
      if (!device || device.userId !== user.id) throw new AppError('not_found');
      return targetId;
    }
    if (!SELF_PURPOSES.has(purpose)) throw new AppError('invalid', { fieldErrors: { purpose: 'Unknown purpose.' } });
    if (targetId && targetId !== user.id) throw new AppError('forbidden', { fieldErrors: { targetId: 'This action stays on the current account.' } });
    return null;
  }

  async function issue(input: IssueActionGrantInput): Promise<IssuedActionGrant> {
    const now = clock();
    const user = await db.user.findUnique({ where: { id: input.userId } });
    const device = user ? await db.adminDeviceSession.findUnique({ where: { id: input.sid } }) : null;
    if (!user || !device || !accountOpen(user, now) || !deviceOpen(device, user, now, sessionPolicy)) throw new AppError('unauthorized');
    const targetId = await storedTarget(user, input.purpose, input.targetId);
    if (!(await verifyPassword(user.passwordHash, input.password))) throw new AppError('bad_credentials');
    const consumed = await consumeStep(user, input.totp);
    if (!consumed) {
      const matched = codeStillInWindow(user, input.totp);
      throw new AppError('bad_credentials', matched ? { fieldErrors: { totp: 'Wait for the next authenticator code.' } } : {});
    }
    const token = newGrantToken();
    const tokenHash = hashGrantToken(token);
    const expiresAt = new Date(now.getTime() + grantTtlMs);
    try {
      await db.$transaction(async (tx) => {
        const locked = await lockUserAndDevice(tx, user.id, device.id);
        const freshUser = locked.user;
        const freshDevice = locked.device;
        if (!freshUser || freshUser.sessionVersion !== user.sessionVersion || freshUser.totpSecret !== user.totpSecret) throw new AppError('unauthorized');
        if (!accountOpen(freshUser, now) || !freshDevice || !deviceOpen(freshDevice, freshUser, now, sessionPolicy)) throw new AppError('unauthorized');
        await tx.adminActionGrant.create({
          data: {
            id: randomBytes(16).toString('hex'),
            tokenHash,
            userId: freshUser.id,
            deviceSessionId: freshDevice.id,
            sessionVersion: freshUser.sessionVersion,
            purpose: input.purpose,
            targetId,
            createdAt: now,
            expiresAt,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: freshUser.id,
            action: 'account.reauth_issued',
            target: targetId ?? freshUser.id,
            meta: { purpose: input.purpose },
            ip: input.ip || 'unknown',
          },
        });
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isDbUnavailable(error)) throw new AppError('service_unavailable');
      throw error;
    }
    return { token, purpose: input.purpose, expiresAt };
  }

  async function consume(input: ConsumeActionGrantInput, tx?: Prisma.TransactionClient): Promise<boolean> {
    if (tx) return consumeLocked(tx, input);
    return db.$transaction((inner) => consumeLocked(inner, input));
  }

  async function consumeLocked(tx: Prisma.TransactionClient, input: ConsumeActionGrantInput): Promise<boolean> {
    const now = clock();
    const locked = await lockUserAndDevice(tx, input.userId, input.sid);
    const user = locked.user;
    const device = locked.device;
    if (!user || !device || !accountOpen(user, now) || !deviceOpen(device, user, now, sessionPolicy)) return false;
    const targetMatch = input.targetId === null
      ? Prisma.sql`"targetId" IS NULL`
      : Prisma.sql`"targetId" = ${input.targetId}`;
    // Date 参数按 timestamptz 绑定。列是无时区的 UTC 钟面，先转到 UTC 再比，避免会话时区把到期等号比成仍有效。
    const instant = Prisma.sql`(${now}::timestamptz AT TIME ZONE 'UTC')`;
    const updated = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "AdminActionGrant"
      SET "usedAt" = ${instant}
      WHERE "tokenHash" = ${hashGrantToken(input.token)}
        AND "userId" = ${user.id}
        AND "deviceSessionId" = ${device.id}
        AND "sessionVersion" = ${user.sessionVersion}
        AND purpose::text = ${input.purpose}
        AND ${targetMatch}
        AND "usedAt" IS NULL
        AND "expiresAt" > ${instant}
      RETURNING id
    `;
    return updated.length === 1;
  }

  return { issue, consume };
}

function codeStillInWindow(user: Pick<User, 'totpSecret'>, totp: string): boolean {
  if (!user.totpSecret || !/^[0-9]{6}$/.test(totp)) return false;
  try {
    return authenticator.clone({ epoch: Date.now() }).checkDelta(totp, decrypt(user.totpSecret)) !== null;
  } catch {
    return false;
  }
}

type ReauthGate = Awaited<ReturnType<typeof requireAdmin>>;
type ReauthServices = {
  actionGrants: ActionGrantService;
  apiCounter: ApiCounter;
};

function mappedDenial(code: AppErrorCode, requestId: string, retryAfterSeconds?: number) {
  const mapped = classifyThrown(new AppError(code, retryAfterSeconds ? { retryAfterSeconds } : {}), requestId);
  if (mapped.kind !== 'mapped') throw new Error('reauth denial');
  return mapped;
}

async function finish(status: number, body: unknown, headers: Record<string, string>, clear: boolean, counter: ApiCounter) {
  const recorded = await counter.recordFinalResponse({ routeId: REAUTH_ROUTE_ID, status, body });
  let response = Response.json(recorded.body, { status: recorded.status, headers: { ...headers, 'cache-control': 'private, no-store' } });
  if (clear) response = withClearedSession(response);
  return response;
}

async function fromGuard(response: Response, requestId: string, counter: ApiCounter) {
  const payload = await response.json() as { error?: unknown };
  const code = AppErrorCodeSchema.safeParse(payload.error);
  if (!code.success) throw new Error('reauth guard');
  const retry = Number(response.headers.get('retry-after'));
  const mapped = mappedDenial(code.data, requestId, Number.isInteger(retry) && retry > 0 ? retry : undefined);
  const clear = code.data === 'unauthorized' || code.data === 'account_disabled';
  return finish(mapped.status, mapped.body, mapped.headers, clear, counter);
}

function missingFactor(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const body = value as Record<string, unknown>;
  const passwordMissing = typeof body.password !== 'string' || body.password.length === 0;
  const totpMissing = body.totp === undefined || body.totp === null || body.totp === '';
  return passwordMissing || totpMissing;
}

/** 当前设备会话上的本人重验。不续设备期限，也不接受恢复码或受限恢复 cookie。 */
export async function handleReauth(request: Request, gate: ReauthGate, services: ReauthServices) {
  const requestId = randomUUID();
  const counter = services.apiCounter;
  try {
    if (gate instanceof Response) return fromGuard(gate, requestId, counter);
    const decision = gate;
    const [accountOk, ipOk] = await Promise.all([
      hitRateLimit(`reauth:acct:${rateLimitKeyHash(decision.user.id)}`, REAUTH_ACCOUNT_LIMIT, REAUTH_WINDOW_MS, { onStoreError: 'closed' }),
      hitRateLimit(`reauth:ip:${rateLimitSubject(decision.ip)}`, REAUTH_IP_LIMIT, REAUTH_WINDOW_MS, { onStoreError: 'closed' }),
    ]);
    if (!accountOk || !ipOk) {
      const mapped = mappedDenial('rate_limited', requestId, REAUTH_WINDOW_MS / 1000);
      return finish(mapped.status, mapped.body, mapped.headers, false, counter);
    }
    const json = await readJson(request, BODY_LIMIT);
    if (json === TOO_LARGE) {
      const mapped = mappedDenial('too_large', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, false, counter);
    }
    if (missingFactor(json)) {
      const mapped = mappedDenial('bad_credentials', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, false, counter);
    }
    const parsed = ReauthRequestSchema.safeParse(json);
    if (!parsed.success) {
      const mapped = mappedDenial('invalid', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, false, counter);
    }
    const issued = await services.actionGrants.issue({
      userId: decision.user.id,
      sid: decision.device.id,
      purpose: parsed.data.purpose,
      targetId: parsed.data.targetId,
      password: parsed.data.password,
      totp: parsed.data.totp,
      ip: decision.ip,
    });
    const body = ActionGrantDTOSchema.parse({
      token: issued.token,
      purpose: issued.purpose,
      expiresAt: issued.expiresAt.toISOString(),
    });
    return finish(200, body, {}, false, counter);
  } catch (error) {
    const mapped = classifyThrown(error, requestId);
    if (mapped.kind === 'legacy-response') return mapped.response;
    if (mapped.kind === 'legacy-body') return finish(500, mapped.body, { 'cache-control': 'private, no-store' }, false, counter);
    const clear = mapped.body.error === 'unauthorized' || mapped.body.error === 'account_disabled';
    return finish(mapped.status, mapped.body, mapped.headers, clear, counter);
  }
}
