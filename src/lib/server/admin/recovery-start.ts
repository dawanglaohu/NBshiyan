import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { RecoveryStartRequestSchema, RecoveryStateDTOSchema } from '@/lib/contracts/recovery';
import { AppErrorCodeSchema, type AppErrorCode } from '@/lib/contracts/errors';
import { ADMIN_GRANT_POLICY } from '@/lib/server/config';
import { prisma } from '@/lib/server/db';
import { isDbUnavailable } from '@/lib/server/designs';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import type { ApiCounter } from '@/lib/server/http/metrics';
import { clientIp, hitRateLimit, rateLimitKeyHash, rateLimitSubject } from '@/lib/server/security';
import { assertSameOrigin } from '@/lib/server/admin-guard';
import { readJson, TOO_LARGE } from './inquiries';
import { verifySecret } from './crypto';
import { hashRecoveryPermitToken, hashRecoverySessionToken, createRecoveryRepo, type RecoveryRepo } from './recovery-repo';

const START_WINDOW_MS = 10 * 60_000;
const START_ACCOUNT_LIMIT = 5;
const START_IP_LIMIT = 20;
const BODY_LIMIT = 8_000;
export const RECOVERY_START_ROUTE_ID = 'POST /api/auth-admin/recovery/start';
export const RECOVERY_COOKIE = 'pj_recovery';

export type RecoveryStartInput = {
  email: string;
  credentialKind: 'RECOVERY_CODE' | 'PERMIT';
  credential: string;
  ip?: string | null;
};

export type StartedRecovery = {
  token: string;
  expiresAt: Date;
  source: 'RECOVERY_CODE' | 'ADMIN' | 'SERVER_OWNER';
};

export type RecoveryStartService = {
  start(input: RecoveryStartInput): Promise<StartedRecovery>;
};

/**
 * 受限恢复入口：一次性核销恢复码或 permit，同事务递增 sv、撤销旧设备与旧恢复会话、
 * 建 10min 受限 session 并审计。原有效 TOTP/password/defaultMode 一律保留，
 * 只有后续 confirm 才原子发布新绑定（E-10、E-11、E-14）。
 */
export function createRecoveryStartService(deps: {
  db?: PrismaClient;
  clock?: () => Date;
  restrictedTtlMs?: number;
  repo?: RecoveryRepo;
  verifyPassword?: (hash: string, plain: string) => Promise<boolean>;
}): RecoveryStartService {
  const db = deps.db ?? prisma;
  const clock = deps.clock ?? (() => new Date());
  const restrictedTtlMs = deps.restrictedTtlMs ?? ADMIN_GRANT_POLICY.restrictedTtlMs;
  const repo = deps.repo ?? createRecoveryRepo();
  const verifyPassword = deps.verifyPassword ?? verifySecret;

  async function start(input: RecoveryStartInput): Promise<StartedRecovery> {
    const now = clock();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashRecoverySessionToken(token);
    const expiresAt = new Date(now.getTime() + restrictedTtlMs);
    try {
      return await db.$transaction(async (tx) => {
        // 固定锁序：先锁 User 行，再重读当前 recoveryCodes/sv，禁止旧快照整组覆盖。
        const user = await repo.lockRecoveryUser(tx, input.email);
        if (!user || user.disabled || !user.totpEnabled) throw new AppError('bad_credentials');

        let source: 'RECOVERY_CODE' | 'ADMIN' | 'SERVER_OWNER';
        let pendingPasswordHash: string | null = null;
        let passwordResetSource: string | null = null;
        if (input.credentialKind === 'PERMIT') {
          const permit = await repo.consumePermit(tx, hashRecoveryPermitToken(input.credential), user.id, user.sessionVersion, now);
          if (!permit) throw new AppError('bad_credentials');
          source = permit.source;
          // SERVER_OWNER 的本地 TTY 预授权 hash 只在服务器事务里转入受限 session，HTTP body 永不接该值。
          pendingPasswordHash = permit.pendingPasswordHash;
          if (pendingPasswordHash) passwordResetSource = permit.source;
        } else {
          // 锁后按当前数组里恰好匹配的哈希核销；不同码并发不会复活已用码。
          let matched: string | null = null;
          for (const hash of user.recoveryCodes) {
            if (await verifyPassword(hash, input.credential.replace(/[\s-]/g, '').toLowerCase())) { matched = hash; break; }
          }
          if (!matched || !(await repo.consumeRecoveryCode(tx, user.id, matched))) throw new AppError('bad_credentials');
          source = 'RECOVERY_CODE';
        }

        // sv 递增后旧设备与旧恢复会话一起失效；旧有效 TOTP/password/defaultMode 不动。
        const sessionVersion = await repo.bumpSessionVersion(tx, user.id, now);
        await repo.revokeOldDevices(tx, user.id, sessionVersion, now);
        await repo.revokeOldRecoverySessions(tx, user.id, now);
        await repo.createRecoverySession(tx, {
          id: randomBytes(16).toString('hex'),
          tokenHash,
          userId: user.id,
          sessionVersion,
          source,
          createdAt: now,
          expiresAt,
          pendingPasswordHash,
          passwordResetSource,
        });
        await repo.createAudit(tx, {
          actorId: null,
          action: 'recovery.started',
          target: user.id,
          meta: { source, kind: input.credentialKind },
          ip: input.ip || 'unknown',
        });
        return { token, expiresAt, source };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isDbUnavailable(error)) throw new AppError('service_unavailable');
      throw error;
    }
  }

  return { start };
}

type StartServices = {
  recoveryStart: RecoveryStartService;
  apiCounter: ApiCounter;
};

function mappedDenial(code: AppErrorCode, requestId: string, retryAfterSeconds?: number) {
  const mapped = classifyThrown(new AppError(code, retryAfterSeconds ? { retryAfterSeconds } : {}), requestId);
  if (mapped.kind !== 'mapped') throw new Error('recovery start denial');
  return mapped;
}

/** 受限恢复 cookie：仅 Path=/api/auth-admin/recovery、Secure/HttpOnly/SameSite=Strict，无 Domain，令牌只进 hash。 */
export function recoverySetCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${RECOVERY_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/api/auth-admin/recovery',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function recoveryClearCookie(): string {
  return [
    `${RECOVERY_COOKIE}=`,
    'Path=/api/auth-admin/recovery',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0',
  ].join('; ');
}

async function finish(status: number, body: unknown, headers: Record<string, string>, counter: ApiCounter, setCookie?: string) {
  const recorded = await counter.recordFinalResponse({ routeId: RECOVERY_START_ROUTE_ID, status, body });
  const response = Response.json(recorded.body, {
    status: recorded.status,
    headers: { ...headers, 'cache-control': 'private, no-store' },
  });
  if (setCookie) response.headers.append('set-cookie', setCookie);
  return response;
}

/**
 * HTTP 层：同源 → 按账号+IP 限流 → 限体 → Zod strict → service → 错误映射。
 * 不读 Auth.js 会话；受限 cookie 不挂 ADMIN 角色，也不能换后台会话。
 */
export async function handleRecoveryStart(request: Request, services: StartServices) {
  const requestId = randomUUID();
  const counter = services.apiCounter;
  try {
    const originBlocked = assertSameOrigin(request);
    if (originBlocked) {
      const payload = await originBlocked.json() as { error?: unknown };
      const code = AppErrorCodeSchema.safeParse(payload.error);
      const mapped = mappedDenial(code.success ? code.data : 'forbidden_origin', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, counter);
    }
    const ip = clientIp(request);
    const json = await readJson(request, BODY_LIMIT);
    if (json === TOO_LARGE) {
      const mapped = mappedDenial('too_large', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, counter);
    }
    const parsed = RecoveryStartRequestSchema.safeParse(json);
    if (!parsed.success) {
      const mapped = mappedDenial('invalid', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, counter);
    }
    const email = parsed.data.email.trim().toLowerCase();
    const [accountOk, ipOk] = await Promise.all([
      hitRateLimit(`recovery-start:acct:${rateLimitKeyHash(email)}`, START_ACCOUNT_LIMIT, START_WINDOW_MS, { onStoreError: 'closed' }),
      hitRateLimit(`recovery-start:ip:${rateLimitSubject(ip)}`, START_IP_LIMIT, START_WINDOW_MS, { onStoreError: 'closed' }),
    ]);
    if (!accountOk || !ipOk) {
      const mapped = mappedDenial('rate_limited', requestId, START_WINDOW_MS / 1000);
      return finish(mapped.status, mapped.body, mapped.headers, counter);
    }
    const started = await services.recoveryStart.start({
      email,
      credentialKind: parsed.data.credentialKind,
      credential: parsed.data.credential,
      ip,
    });
    const body = RecoveryStateDTOSchema.parse({ restricted: true, expiresAt: started.expiresAt.toISOString() });
    const maxAge = Math.max(1, Math.floor((started.expiresAt.getTime() - Date.now()) / 1000));
    return finish(200, body, {}, counter, recoverySetCookie(started.token, maxAge));
  } catch (error) {
    const mapped = classifyThrown(error, requestId);
    if (mapped.kind === 'legacy-response') return mapped.response;
    if (mapped.kind === 'legacy-body') return finish(500, mapped.body, { 'cache-control': 'private, no-store' }, counter);
    return finish(mapped.status, mapped.body, mapped.headers, counter, recoveryClearCookie());
  }
}
