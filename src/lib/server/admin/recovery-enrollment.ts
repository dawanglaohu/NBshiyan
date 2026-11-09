import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { authenticator } from 'otplib';
import {
  RecoveryCompleteDTOSchema,
  RecoveryConfirmRequestSchema,
  RecoveryEnrollDTOSchema,
  RecoveryEnrollRequestSchema,
} from '@/lib/contracts/recovery';
import { AppErrorCodeSchema, type AppErrorCode } from '@/lib/contracts/errors';
import { ADMIN_GRANT_POLICY } from '@/lib/server/config';
import { prisma } from '@/lib/server/db';
import { isDbUnavailable } from '@/lib/server/designs';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import type { ApiCounter } from '@/lib/server/http/metrics';
import { clientIp, hitRateLimit, rateLimitKeyHash, rateLimitSubject } from '@/lib/server/security';
import { assertSameOrigin } from '@/lib/server/admin-guard';
import { decrypt, encrypt } from './crypto';
import { hashCodes, newRecoveryCodes } from './login';
import { readJson, TOO_LARGE } from './inquiries';
import {
  createRecoveryRepo,
  hashRecoverySessionToken,
  type RecoveryRepo,
} from './recovery-repo';
import { RECOVERY_COOKIE, recoveryClearCookie } from './recovery-start';

const WINDOW_MS = 10 * 60_000;
const ACCOUNT_LIMIT = 5;
const IP_LIMIT = 20;
const BODY_LIMIT = 8_000;
const FAILED_ATTEMPTS_MAX = 5;
const TOTP_ISSUER = 'PackJoyU Admin';

export const RECOVERY_ENROLL_ROUTE_ID = 'POST /api/auth-admin/recovery/enroll';
export const RECOVERY_CONFIRM_ROUTE_ID = 'POST /api/auth-admin/recovery/confirm';

export type RecoveryEnrollInput = { token: string; ip?: string | null };
export type RecoveryConfirmInput = { token: string; totp: string; ip?: string | null };
export type RecoveryEnrolled = { otpauthUri: string; expiresAt: Date };
export type RecoveryCompleted = { recoveryCodes: string[] };

export type RecoveryEnrollmentService = {
  enroll(input: RecoveryEnrollInput): Promise<RecoveryEnrolled>;
  confirm(input: RecoveryConfirmInput): Promise<RecoveryCompleted>;
};

/**
 * M3-T5：受限会话的再入绑定与最终确认。
 *
 * 09 节状态机 `RESTRICTED → ENROLLING → COMPLETED`：
 * - enroll 首次写加密 pendingSecret，pendingUntil=min(now+10min, session.expiresAt)；
 *   同一有效 session/sv 内重入只返回原 URI/原期限，不旋转、不续时；pending 到期即失效并持久撤销。
 * - 固定锁序（R1）：无锁 hint 只定位 user → 锁 User → 锁 session → 用两把锁后的行重做全部授权判定，
 *   与 start 的 User→session 一致，不会形成 ABBA。
 * - confirm 的 10 个恢复码 hash 与账号限流都在事务外完成；两把锁取得后才取 now，
 *   之后不再有外部 I/O 或昂贵计算，过期/step/CAS 全部使用这个 now。
 *   新 secret＋step＋10 个新恢复码 hash＋sv+1（SERVER_OWNER 预授权时含 passwordHash）同一条 User CAS；
 *   同事务置 completedAt、撤旧设备、撤其他未完成受限会话、写审计；恢复码只返回一次。
 * - 失败/过期/错码/重放/完成后再来一律不提交；第 5 次错码在同一条 UPDATE 里作废 pending 与受限会话，
 *   拒绝分支的副作用不会因事务内 throw 被回滚（该 UPDATE 先于 throw 执行）。
 */
export function createRecoveryEnrollmentService(deps: {
  db?: PrismaClient;
  clock?: () => Date;
  restrictedTtlMs?: number;
  repo?: RecoveryRepo;
  /** 仅测试注入：在事务外准备恢复码 hash，可在其间推进可控 clock，验证“准备期间跨过等号到期”。 */
  hashCodes?: (codes: string[]) => Promise<string[]>;
}): RecoveryEnrollmentService {
  const db = deps.db ?? prisma;
  const clock = deps.clock ?? (() => new Date());
  const restrictedTtlMs = deps.restrictedTtlMs ?? ADMIN_GRANT_POLICY.restrictedTtlMs;
  const repo = deps.repo ?? createRecoveryRepo();
  const prepareHashes = deps.hashCodes ?? hashCodes;

  async function accountRateOk(namespace: 'enroll' | 'confirm', email: string): Promise<boolean> {
    return hitRateLimit(
      `recovery-${namespace}:acct:${rateLimitKeyHash(email.trim().toLowerCase())}`,
      ACCOUNT_LIMIT,
      WINDOW_MS,
      { onStoreError: 'closed' },
    );
  }

  async function enroll(input: RecoveryEnrollInput): Promise<RecoveryEnrolled> {
    const tokenHash = hashRecoverySessionToken(input.token);
    let result: { kind: 'enrolled'; otpauthUri: string; expiresAt: Date } | { kind: 'expired' };
    try {
      // 无锁 hint 只用于选定 User 行与账号桶主体；它不决定成功，也不穿过锁等待。
      const hint = await repo.readRecoverySessionHint(db, tokenHash);
      if (!hint) throw new AppError('bad_credentials');
      if (!(await accountRateOk('enroll', hint.email))) {
        throw new AppError('rate_limited', { retryAfterSeconds: WINDOW_MS / 1000 });
      }
      result = await db.$transaction(async (tx) => {
        // 固定锁序 User→session，与 start 一致；session 的 userId 只用来复核关联。
        const user = await repo.lockRecoveryFactors(tx, hint.userId);
        if (!user || user.disabled) throw new AppError('bad_credentials');
        const session = await repo.lockRecoverySession(tx, tokenHash);
        if (!session || session.userId !== user.id) throw new AppError('bad_credentials');
        if (session.source === 'SELF_REAUTH') throw new AppError('bad_credentials');
        // 两把锁之后取 now；此后没有外部 I/O 或昂贵计算。
        const now = clock();
        if (session.revokedAt || session.completedAt) throw new AppError('bad_credentials');
        if (session.sessionVersion !== user.sessionVersion) throw new AppError('bad_credentials');
        // 过期/失效必须先提交撤销再拒绝，不能在同一事务里 throw 把撤销回滚掉。
        if (session.expiresAt.getTime() <= now.getTime()) {
          await repo.revokeRecoverySession(tx, session.id, now);
          return { kind: 'expired' as const };
        }
        if (session.pendingUntil !== null && session.pendingUntil.getTime() <= now.getTime()) {
          await repo.revokeRecoverySession(tx, session.id, now);
          return { kind: 'expired' as const };
        }
        if (session.pendingUntil !== null && session.pendingSecretEncrypted) {
          const pending = decrypt(session.pendingSecretEncrypted);
          return {
            kind: 'enrolled' as const,
            otpauthUri: authenticator.keyuri(user.email, TOTP_ISSUER, pending),
            expiresAt: session.pendingUntil,
          };
        }
        const secret = authenticator.generateSecret();
        const pendingUntil = new Date(Math.min(
          now.getTime() + restrictedTtlMs,
          session.expiresAt.getTime(),
        ));
        const written = await repo.setPendingSecret(
          tx, session.id, encrypt(secret), pendingUntil, now, session.sessionVersion,
        );
        if (!written) throw new AppError('bad_credentials');
        return {
          kind: 'enrolled' as const,
          otpauthUri: authenticator.keyuri(user.email, TOTP_ISSUER, secret),
          expiresAt: pendingUntil,
        };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isDbUnavailable(error)) throw new AppError('service_unavailable');
      throw error;
    }
    if (result.kind === 'expired') throw new AppError('recovery_expired');
    return { otpauthUri: result.otpauthUri, expiresAt: result.expiresAt };
  }

  async function confirm(input: RecoveryConfirmInput): Promise<RecoveryCompleted> {
    const tokenHash = hashRecoverySessionToken(input.token);
    let result:
      | { kind: 'completed'; recoveryCodes: string[] }
      | { kind: 'expired' }
      | { kind: 'rejected' };
    try {
      // 无锁 hint 只用于选定 User 行与账号桶主体；判定全部在两把锁之后重做。
      const hint = await repo.readRecoverySessionHint(db, tokenHash);
      if (!hint) throw new AppError('bad_credentials');
      if (!(await accountRateOk('confirm', hint.email))) {
        throw new AppError('rate_limited', { retryAfterSeconds: WINDOW_MS / 1000 });
      }
      // 10 个恢复码 hash 移出持锁事务；此后再没有外部 I/O 或昂贵计算落到锁内。
      const codes = newRecoveryCodes();
      const hashes = await prepareHashes(codes);
      result = await db.$transaction(async (tx) => {
        // 固定锁序 User→session，与 start 一致；锁前 hint 不参与成功判定。
        const user = await repo.lockRecoveryFactors(tx, hint.userId);
        if (!user || user.disabled) throw new AppError('bad_credentials');
        const session = await repo.lockRecoverySession(tx, tokenHash);
        if (!session || session.userId !== user.id) throw new AppError('bad_credentials');
        if (session.source === 'SELF_REAUTH') throw new AppError('bad_credentials');
        // 两把锁与耗时准备都完成后才取 now；之后只剩 DB 读写，期限/step/CAS 都用它。
        const now = clock();
        if (session.revokedAt || session.completedAt) throw new AppError('bad_credentials');
        if (session.sessionVersion !== user.sessionVersion) throw new AppError('bad_credentials');
        if (!session.pendingSecretEncrypted || session.pendingUntil === null) {
          throw new AppError('bad_credentials');
        }
        if (session.failedAttempts >= FAILED_ATTEMPTS_MAX) throw new AppError('bad_credentials');
        if (!user.totpEnabled) throw new AppError('bad_credentials');
        // 过期先提交撤销再拒绝（与 enroll 同一原则）。
        if (session.expiresAt.getTime() <= now.getTime()
          || session.pendingUntil.getTime() <= now.getTime()) {
          await repo.revokeRecoverySession(tx, session.id, now);
          return { kind: 'expired' as const };
        }

        const pendingSecret = decrypt(session.pendingSecretEncrypted);
        const delta = authenticator.clone({ epoch: now.getTime() }).checkDelta(
          input.totp,
          pendingSecret,
        );
        if (delta === null) {
          // 计数＋第 5 次作废在事务内提交，拒绝在事务外抛；不会把撤销回滚。
          await repo.recordConfirmFailure(tx, session.id, now);
          return { kind: 'rejected' as const };
        }
        const step = Math.floor(now.getTime() / 30_000) + delta;

        const completed = await repo.completeRecoverySession(
          tx, session.id, now, session.pendingSecretEncrypted, session.sessionVersion,
        );
        if (!completed) throw new AppError('bad_credentials');
        const committedVersion = await repo.commitRecoveredFactors(tx, {
          userId: user.id,
          expectedSessionVersion: session.sessionVersion,
          expectedTotpSecret: user.totpSecret,
          newTotpSecretEncrypted: session.pendingSecretEncrypted,
          totpLastStep: step,
          recoveryCodeHashes: hashes,
          pendingPasswordHash: session.passwordResetSource === 'SERVER_OWNER'
            ? session.pendingPasswordHash
            : null,
        });
        if (committedVersion === undefined) throw new AppError('bad_credentials');
        await repo.revokeOldDevices(tx, user.id, committedVersion, now, 'recovery_confirm');
        await repo.revokeOtherRecoverySessions(tx, user.id, session.id, now);
        await repo.createAudit(tx, {
          actorId: user.id,
          action: 'recovery.completed',
          target: user.id,
          meta: {
            source: session.source,
            passwordReset: session.passwordResetSource === 'SERVER_OWNER'
              && Boolean(session.pendingPasswordHash),
            time: now.toISOString(),
          },
          ip: input.ip || 'unknown',
        });
        return { kind: 'completed' as const, recoveryCodes: codes };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isDbUnavailable(error)) throw new AppError('service_unavailable');
      throw error;
    }
    if (result.kind === 'expired') throw new AppError('recovery_expired');
    if (result.kind === 'rejected') throw new AppError('bad_credentials');
    return { recoveryCodes: result.recoveryCodes };
  }

  return { enroll, confirm };
}

function mappedDenial(code: AppErrorCode, requestId: string, retryAfterSeconds?: number) {
  const mapped = classifyThrown(
    new AppError(code, retryAfterSeconds ? { retryAfterSeconds } : {}),
    requestId,
  );
  if (mapped.kind !== 'mapped') throw new Error('recovery enrollment denial');
  return mapped;
}

async function finish(
  status: number,
  body: unknown,
  headers: Record<string, string>,
  counter: ApiCounter,
  routeId: string,
  setCookie?: string,
) {
  const recorded = await counter.recordFinalResponse({ routeId, status, body });
  const response = Response.json(recorded.body, {
    status: recorded.status,
    headers: { ...headers, 'cache-control': 'private, no-store' },
  });
  if (setCookie) response.headers.append('set-cookie', setCookie);
  return response;
}

/** 只读受限 cookie；不碰 Auth.js 会话，也不能换后台会话。 */
export function readRecoveryCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== RECOVERY_COOKIE) continue;
    const raw = trimmed.slice(eq + 1);
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

type EnrollServices = { recoveryEnrollment: RecoveryEnrollmentService; apiCounter: ApiCounter };

/**
 * HTTP 层：同源 → 限体 → strict {} → IP 限流 → 取受限 cookie → service → 错误映射。
 * 失败不清 cookie（Jev 决策 A）；enroll 成功也不重发 cookie。
 */
export async function handleRecoveryEnroll(request: Request, services: EnrollServices) {
  const requestId = randomUUID();
  const counter = services.apiCounter;
  try {
    const originBlocked = assertSameOrigin(request);
    if (originBlocked) {
      const payload = await originBlocked.json() as { error?: unknown };
      const code = AppErrorCodeSchema.safeParse(payload.error);
      const mapped = mappedDenial(code.success ? code.data : 'forbidden_origin', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_ENROLL_ROUTE_ID);
    }
    const json = await readJson(request, BODY_LIMIT);
    if (json === TOO_LARGE) {
      const mapped = mappedDenial('too_large', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_ENROLL_ROUTE_ID);
    }
    if (!RecoveryEnrollRequestSchema.safeParse(json).success) {
      const mapped = mappedDenial('invalid', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_ENROLL_ROUTE_ID);
    }
    const ip = clientIp(request);
    if (!(await hitRateLimit(`recovery-enroll:ip:${rateLimitSubject(ip)}`, IP_LIMIT, WINDOW_MS, { onStoreError: 'closed' }))) {
      const mapped = mappedDenial('rate_limited', requestId, WINDOW_MS / 1000);
      return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_ENROLL_ROUTE_ID);
    }
    const token = readRecoveryCookie(request.headers.get('cookie'));
    if (!token) {
      const mapped = mappedDenial('bad_credentials', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_ENROLL_ROUTE_ID);
    }
    const enrolled = await services.recoveryEnrollment.enroll({ token, ip });
    const body = RecoveryEnrollDTOSchema.parse({
      otpauthUri: enrolled.otpauthUri,
      expiresAt: enrolled.expiresAt.toISOString(),
    });
    return finish(200, body, {}, counter, RECOVERY_ENROLL_ROUTE_ID);
  } catch (error) {
    const mapped = classifyThrown(error, requestId);
    if (mapped.kind === 'legacy-response') return mapped.response;
    if (mapped.kind === 'legacy-body') {
      return finish(500, mapped.body, { 'cache-control': 'private, no-store' }, counter, RECOVERY_ENROLL_ROUTE_ID);
    }
    return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_ENROLL_ROUTE_ID);
  }
}

/**
 * HTTP 层：同源 → 限体 → strict {totp} → IP 限流 → 取受限 cookie → service。
 * 成功清受限 cookie；失败/过期不清（Jev 决策 A）。
 */
export async function handleRecoveryConfirm(request: Request, services: EnrollServices) {
  const requestId = randomUUID();
  const counter = services.apiCounter;
  try {
    const originBlocked = assertSameOrigin(request);
    if (originBlocked) {
      const payload = await originBlocked.json() as { error?: unknown };
      const code = AppErrorCodeSchema.safeParse(payload.error);
      const mapped = mappedDenial(code.success ? code.data : 'forbidden_origin', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_CONFIRM_ROUTE_ID);
    }
    const json = await readJson(request, BODY_LIMIT);
    if (json === TOO_LARGE) {
      const mapped = mappedDenial('too_large', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_CONFIRM_ROUTE_ID);
    }
    const parsed = RecoveryConfirmRequestSchema.safeParse(json);
    if (!parsed.success) {
      const mapped = mappedDenial('invalid', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_CONFIRM_ROUTE_ID);
    }
    const ip = clientIp(request);
    if (!(await hitRateLimit(`recovery-confirm:ip:${rateLimitSubject(ip)}`, IP_LIMIT, WINDOW_MS, { onStoreError: 'closed' }))) {
      const mapped = mappedDenial('rate_limited', requestId, WINDOW_MS / 1000);
      return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_CONFIRM_ROUTE_ID);
    }
    const token = readRecoveryCookie(request.headers.get('cookie'));
    if (!token) {
      const mapped = mappedDenial('bad_credentials', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_CONFIRM_ROUTE_ID);
    }
    const completed = await services.recoveryEnrollment.confirm({ token, totp: parsed.data.totp, ip });
    const body = RecoveryCompleteDTOSchema.parse({ completed: true, recoveryCodes: completed.recoveryCodes });
    return finish(200, body, {}, counter, RECOVERY_CONFIRM_ROUTE_ID, recoveryClearCookie());
  } catch (error) {
    const mapped = classifyThrown(error, requestId);
    if (mapped.kind === 'legacy-response') return mapped.response;
    if (mapped.kind === 'legacy-body') {
      return finish(500, mapped.body, { 'cache-control': 'private, no-store' }, counter, RECOVERY_CONFIRM_ROUTE_ID);
    }
    return finish(mapped.status, mapped.body, mapped.headers, counter, RECOVERY_CONFIRM_ROUTE_ID);
  }
}
