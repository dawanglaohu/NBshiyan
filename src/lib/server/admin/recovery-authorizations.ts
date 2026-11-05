import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  AdminResetTotpRequestSchema,
  RecoveryAuthorizationRequestSchema,
  RecoveryPermitDTOSchema,
} from '@/lib/contracts/recovery';
import { AppErrorCodeSchema, type AppErrorCode } from '@/lib/contracts/errors';
import { ADMIN_GRANT_POLICY } from '@/lib/server/config';
import { prisma } from '@/lib/server/db';
import { isDbUnavailable } from '@/lib/server/designs';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import type { ApiCounter } from '@/lib/server/http/metrics';
import { hitRateLimit, rateLimitKeyHash, rateLimitSubject } from '@/lib/server/security';
import { withClearedSession, type AdminCtx } from './guard';
import { readJson, TOO_LARGE } from './inquiries';
import type { ActionGrantService } from './action-grant';
import { createRecoveryRepo, hashRecoveryPermitToken, type RecoveryRepo } from './recovery-repo';

const ISSUE_WINDOW_MS = 10 * 60_000;
const ISSUE_ACCOUNT_LIMIT = 5;
const ISSUE_IP_LIMIT = 20;
const BODY_LIMIT = 8_000;

export const RECOVERY_AUTHORIZE_ROUTE_ID = 'POST /api/admin/account/recovery-authorizations';
export const RESET_2FA_ALIAS_ROUTE_ID = 'POST /api/admin/users/[id]/reset-2fa';

export type IssueRecoveryPermitInput = {
  actorId: string;
  sid: string;
  targetId: string;
  reason: string;
  grantToken: string;
  ip?: string | null;
};

export type IssuedRecoveryPermit = { token: string; expiresAt: Date };

export type RecoveryAuthorizationService = {
  issue(input: IssueRecoveryPermitInput): Promise<IssuedRecoveryPermit>;
};

/**
 * 目标恢复 permit：消费一枚 RECOVERY_AUTHORIZE grant 后签发 15min 一次性凭据。
 * 授权核销、目标账号当前状态、permit 落库、审计都在同一事务；grant 已由 reauth 用当前密码+新 TOTP 签发，
 * 这里不接受 body 里的 password/totp 来替代，普通 passwordless 会话不能借此省略现密码（E-73、E-75）。
 */
export function createRecoveryAuthorizationService(deps: {
  db?: PrismaClient;
  clock?: () => Date;
  permitTtlMs?: number;
  actionGrants: ActionGrantService;
  repo?: RecoveryRepo;
}): RecoveryAuthorizationService {
  const db = deps.db ?? prisma;
  const clock = deps.clock ?? (() => new Date());
  const permitTtlMs = deps.permitTtlMs ?? ADMIN_GRANT_POLICY.permitTtlMs;
  const repo = deps.repo ?? createRecoveryRepo();

  async function issue(input: IssueRecoveryPermitInput): Promise<IssuedRecoveryPermit> {
    const now = clock();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashRecoveryPermitToken(token);
    const expiresAt = new Date(now.getTime() + permitTtlMs);
    try {
      await db.$transaction(async (tx) => {
        // 与最终动作同事务一次性消费：重复、跨用途、跨设备、过期、目的不符都不再签发。
        const consumed = await deps.actionGrants.consume({
          token: input.grantToken,
          purpose: 'RECOVERY_AUTHORIZE',
          targetId: input.targetId,
          userId: input.actorId,
          sid: input.sid,
        }, tx);
        if (!consumed) throw new AppError('action_grant_invalid');

        // 事务内重查当前权限：grant 签发之后若角色不再是 ADMIN，旧授权立即失效。
        // 授权方 User 行已由 grant 核销持有行锁，这里只读不另加锁，保持固定锁序。
        const actorRole = await repo.readActorRole(tx, input.actorId);
        if (actorRole !== 'ADMIN') throw new AppError('forbidden');
        if (input.targetId === input.actorId) throw new AppError('forbidden', { fieldErrors: { targetUserId: 'Choose another account.' } });

        const target = await repo.readTargetUser(tx, input.targetId);
        if (!target || !target.totpEnabled || target.disabled) throw new AppError('not_found');

        // 只签发 permit：不改目标账号任何因素（totpSecret/recoveryCodes/sessionVersion 原样）。
        await repo.createPermit(tx, {
          id: randomBytes(16).toString('hex'),
          tokenHash,
          targetUserId: target.id,
          source: 'ADMIN',
          issuedById: input.actorId,
          reason: input.reason,
          sessionVersion: target.sessionVersion,
          createdAt: now,
          expiresAt,
        });
        await repo.createAudit(tx, {
          actorId: input.actorId,
          action: 'recovery.issued',
          target: target.id,
          meta: { source: 'ADMIN', reason: input.reason },
          ip: input.ip || 'unknown',
        });
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isDbUnavailable(error)) throw new AppError('service_unavailable');
      throw error;
    }
    return { token, expiresAt };
  }

  return { issue };
}

type RecoveryGate = (AdminCtx & { device: { id: string } }) | Response;
type RecoveryServices = {
  recoveryAuthorizations: RecoveryAuthorizationService;
  apiCounter: ApiCounter;
};

function mappedDenial(code: AppErrorCode, requestId: string, retryAfterSeconds?: number) {
  const mapped = classifyThrown(new AppError(code, retryAfterSeconds ? { retryAfterSeconds } : {}), requestId);
  if (mapped.kind !== 'mapped') throw new Error('recovery denial');
  return mapped;
}

async function finish(routeId: string, status: number, body: unknown, headers: Record<string, string>, clear: boolean, counter: ApiCounter) {
  const recorded = await counter.recordFinalResponse({ routeId, status, body });
  let response = Response.json(recorded.body, {
    status: recorded.status,
    headers: { ...headers, 'cache-control': 'private, no-store' },
  });
  if (clear) response = withClearedSession(response);
  return response;
}

async function fromGuard(routeId: string, response: Response, requestId: string, counter: ApiCounter) {
  const payload = await response.json() as { error?: unknown };
  const code = AppErrorCodeSchema.safeParse(payload.error);
  if (!code.success) throw new Error('recovery guard');
  const retry = Number(response.headers.get('retry-after'));
  const mapped = mappedDenial(code.data, requestId, Number.isInteger(retry) && retry > 0 ? retry : undefined);
  const clear = code.data === 'unauthorized' || code.data === 'account_disabled';
  return finish(routeId, mapped.status, mapped.body, mapped.headers, clear, counter);
}

type HandlerOptions = {
  routeId: string;
  /** 兼容别名把目标账号 id 放在 URL，新路由放在 body；两者都用同一 service。 */
  targetIdFromPath?: string;
};

/**
 * 两个入口共用的 HTTP 层。route 负责 requireAdmin 与同源，这里负责限流、限体、Zod strict、service 与错误映射。
 * 旧「无 body 直接重置」、仅 session、SALES/EDITOR、未消费 grant 都到不了 service，目标因素不变。
 */
export async function handleRecoveryAuthorization(request: Request, gate: RecoveryGate, services: RecoveryServices, options: HandlerOptions) {
  const requestId = randomUUID();
  const counter = services.apiCounter;
  try {
    if (gate instanceof Response) return fromGuard(options.routeId, gate, requestId, counter);
    const decision = gate;
    const [accountOk, ipOk] = await Promise.all([
      hitRateLimit(`recovery-authorize:acct:${rateLimitKeyHash(decision.user.id)}`, ISSUE_ACCOUNT_LIMIT, ISSUE_WINDOW_MS, { onStoreError: 'closed' }),
      hitRateLimit(`recovery-authorize:ip:${rateLimitSubject(decision.ip)}`, ISSUE_IP_LIMIT, ISSUE_WINDOW_MS, { onStoreError: 'closed' }),
    ]);
    if (!accountOk || !ipOk) {
      const mapped = mappedDenial('rate_limited', requestId, ISSUE_WINDOW_MS / 1000);
      return finish(options.routeId, mapped.status, mapped.body, mapped.headers, false, counter);
    }
    const json = await readJson(request, BODY_LIMIT);
    if (json === TOO_LARGE) {
      const mapped = mappedDenial('too_large', requestId);
      return finish(options.routeId, mapped.status, mapped.body, mapped.headers, false, counter);
    }
    let input: { targetUserId: string; reason: string; actionGrant: string };
    if (options.targetIdFromPath === undefined) {
      const parsed = RecoveryAuthorizationRequestSchema.safeParse(json);
      if (!parsed.success) {
        const mapped = mappedDenial('invalid', requestId);
        return finish(options.routeId, mapped.status, mapped.body, mapped.headers, false, counter);
      }
      input = parsed.data;
    } else {
      const parsed = AdminResetTotpRequestSchema.safeParse(json);
      if (!parsed.success) {
        const mapped = mappedDenial('invalid', requestId);
        return finish(options.routeId, mapped.status, mapped.body, mapped.headers, false, counter);
      }
      input = { ...parsed.data, targetUserId: options.targetIdFromPath };
    }
    const issued = await services.recoveryAuthorizations.issue({
      actorId: decision.user.id,
      sid: decision.device.id,
      targetId: input.targetUserId,
      reason: input.reason,
      grantToken: input.actionGrant,
      ip: decision.ip,
    });
    const body = RecoveryPermitDTOSchema.parse({ token: issued.token, expiresAt: issued.expiresAt.toISOString() });
    return finish(options.routeId, 200, body, {}, false, counter);
  } catch (error) {
    const mapped = classifyThrown(error, requestId);
    if (mapped.kind === 'legacy-response') return mapped.response;
    if (mapped.kind === 'legacy-body') return finish(options.routeId, 500, mapped.body, { 'cache-control': 'private, no-store' }, false, counter);
    const clear = mapped.body.error === 'unauthorized' || mapped.body.error === 'account_disabled';
    return finish(options.routeId, mapped.status, mapped.body, mapped.headers, clear, counter);
  }
}
