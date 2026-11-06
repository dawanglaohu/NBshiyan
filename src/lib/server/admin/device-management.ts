import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  DeviceCursorSchema, DeviceDTOSchema, DevicePageDTOSchema, DevicePageQuerySchema,
  DeviceRevokeDTOSchema, DeviceRevokeRequestSchema, LogoutAllRequestSchema, SignedOutDTOSchema,
  type DevicePageDTO, type DevicePageQuery, type DeviceRevokeDTO, type SignedOutDTO,
} from '@/lib/contracts/account';
import { IdSchema } from '@/lib/contracts/common';
import { AppErrorCodeSchema } from '@/lib/contracts/errors';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import type { ApiCounter, ApiRouteId } from '@/lib/server/http/metrics';
import { isDbUnavailable } from '@/lib/server/designs';
import { assertSameOrigin } from '@/lib/server/auth';
import { hitRateLimit, rateLimitKeyHash, rateLimitSubject } from '@/lib/server/security';
import { ADMIN_SESSION_POLICY } from '@/lib/server/config';
import type { ActionGrantService } from './action-grant';
import { auditInTx } from './audit';
import { createDeviceManagementRepo, type DeviceManagementRepo } from './device-repo';
import { expiryBounds, type SessionPolicy } from './device-session';
import { withClearedSession, type requireAdmin } from './guard';
import { readJson, TOO_LARGE } from './inquiries';

export type DeviceManagementInput = { userId: string; sid: string; grantToken: string; ip?: string | null };
export type DeviceManagementService = {
  list(input: { userId: string; sid: string; query: DevicePageQuery }): Promise<DevicePageDTO>;
  revoke(input: DeviceManagementInput & { targetId: string }): Promise<DeviceRevokeDTO>;
  logoutAll(input: DeviceManagementInput): Promise<SignedOutDTO>;
};

/** 本人设备管理；授权核销、撤销或 sv 递增与审计共用一笔事务。 */
export function createDeviceManagementService(deps: {
  db: PrismaClient;
  actionGrants: ActionGrantService;
  clock?: () => Date;
  policy?: SessionPolicy;
  repo?: DeviceManagementRepo;
}): DeviceManagementService {
  const repo = deps.repo ?? createDeviceManagementRepo();
  const clock = deps.clock ?? (() => new Date());
  const policy = deps.policy ?? ADMIN_SESSION_POLICY;

  async function list(input: { userId: string; sid: string; query: DevicePageQuery }): Promise<DevicePageDTO> {
    const query = DevicePageQuerySchema.parse(input.query);
    const position = query.cursor ? JSON.parse(Buffer.from(DeviceCursorSchema.parse(query.cursor), 'base64url').toString('utf8')) as { createdAt: string; id: string } : null;
    const cursor = position ? { createdAt: new Date(position.createdAt), id: position.id } : null;
    try {
      if (cursor && !await repo.findCursor(deps.db, input.userId, cursor)) throw new AppError('invalid');
      const rows = await repo.list(deps.db, input.userId, query.limit, cursor);
      const hasMore = rows.length > query.limit;
      const kept = rows.slice(0, query.limit);
      const items = kept.map((device) => {
        const bounds = expiryBounds(device, policy);
        return DeviceDTOSchema.parse({
          id: device.id, current: device.id === input.sid, remembered: device.remembered,
          createdAt: device.createdAt.toISOString(), lastActivityAt: device.lastActivityAt.toISOString(),
          effectiveExpiresAt: bounds.effectiveExpiresAt.toISOString(),
          absoluteExpiresAt: bounds.absoluteExpiresAt?.toISOString() ?? null,
          revokedAt: device.revokedAt?.toISOString() ?? null, deviceLabel: device.deviceLabel,
        });
      });
      const last = kept.at(-1);
      const nextCursor = hasMore && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString('base64url')
        : null;
      return DevicePageDTOSchema.parse({ items, nextCursor, hasMore });
    } catch (error) {
      if (isDbUnavailable(error)) throw new AppError('service_unavailable');
      throw error;
    }
  }

  async function revoke(input: DeviceManagementInput & { targetId: string }): Promise<DeviceRevokeDTO> {
    try {
      return await deps.db.$transaction(async (tx) => {
        // consume 先按固定 User→当前Device→Grant 锁序核销；目标归属在同一事务重新读。
        const consumed = await deps.actionGrants.consume({
          token: input.grantToken, purpose: 'DEVICE_REVOKE', targetId: input.targetId, userId: input.userId, sid: input.sid,
        }, tx);
        if (!consumed) throw new AppError('action_grant_invalid');
        const target = await repo.readOwnedTarget(tx, input.userId, input.targetId);
        if (!target) throw new AppError('not_found');
        // 状态幂等不恢复已用授权；新授权撤销已撤设备仍返回原 revokedAt，不重复记动作审计。
        if (target.revokedAt) return DeviceRevokeDTOSchema.parse({ id: target.id, revokedAt: target.revokedAt.toISOString() });
        const now = clock();
        if (await repo.revokeOwned(tx, input.userId, target.id, now) !== 1) throw new AppError('version_conflict');
        await auditInTx(tx, { actorId: input.userId, action: 'account.device_revoke', target: target.id, ip: input.ip });
        return DeviceRevokeDTOSchema.parse({ id: target.id, revokedAt: now.toISOString() });
      });
    } catch (error) {
      if (isDbUnavailable(error)) throw new AppError('service_unavailable');
      throw error;
    }
  }

  async function logoutAll(input: DeviceManagementInput): Promise<SignedOutDTO> {
    try {
      return await deps.db.$transaction(async (tx) => {
        const consumed = await deps.actionGrants.consume({
          token: input.grantToken, purpose: 'LOGOUT_ALL', targetId: null, userId: input.userId, sid: input.sid,
        }, tx);
        if (!consumed) throw new AppError('action_grant_invalid');
        // User 锁由 consume 持有；递增后只撤旧版本，新版本随后登录的设备不被迟到撤销。
        const user = await repo.readVersion(tx, input.userId);
        if (!user) throw new AppError('unauthorized');
        if (await repo.incrementVersion(tx, input.userId, user.sessionVersion) !== 1) throw new AppError('version_conflict');
        await repo.revokePreviousVersion(tx, input.userId, user.sessionVersion + 1, clock());
        await auditInTx(tx, { actorId: input.userId, action: 'account.logout_all', target: input.userId, ip: input.ip });
        return SignedOutDTOSchema.parse({ signedOut: true });
      });
    } catch (error) {
      if (isDbUnavailable(error)) throw new AppError('service_unavailable');
      throw error;
    }
  }
  return { list, revoke, logoutAll };
}

type DeviceGate = Awaited<ReturnType<typeof requireAdmin>>;
type DeviceHttpServices = { deviceManagement: DeviceManagementService; apiCounter: ApiCounter };

async function finish(routeId: ApiRouteId, status: number, body: unknown, headers: Record<string, string>, clear: boolean, services: DeviceHttpServices) {
  const recorded = await services.apiCounter.recordFinalResponse({ routeId, status, body });
  const response = Response.json(recorded.body, { status: recorded.status, headers: { ...headers, 'cache-control': 'private, no-store' } });
  return clear ? withClearedSession(response) : response;
}

async function fromGuard(routeId: ApiRouteId, response: Response, requestId: string, services: DeviceHttpServices) {
  const body = await response.json() as { error?: unknown };
  const code = AppErrorCodeSchema.safeParse(body.error);
  if (!code.success) throw new AppError('internal_error');
  const retry = Number(response.headers.get('retry-after'));
  const mapped = classifyThrown(new AppError(code.data, Number.isInteger(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}), requestId);
  if (mapped.kind !== 'mapped') throw new Error('device guard mapping');
  return finish(routeId, mapped.status, mapped.body, mapped.headers, code.data === 'unauthorized' || code.data === 'account_disabled', services);
}

async function fromError(routeId: ApiRouteId, error: unknown, requestId: string, services: DeviceHttpServices) {
  const mapped = classifyThrown(error, requestId);
  if (mapped.kind === 'legacy-response') return mapped.response;
  if (mapped.kind === 'legacy-body') return finish(routeId, 500, mapped.body, {}, false, services);
  return finish(routeId, mapped.status, mapped.body, mapped.headers, mapped.body.error === 'unauthorized' || mapped.body.error === 'account_disabled', services);
}

/** 真实路由传入已校验的当前 User/Device；读设备不续期、不消费授权。 */
export async function handleDeviceList(request: Request, gate: DeviceGate, services: DeviceHttpServices) {
  const routeId = 'GET /api/admin/account/devices';
  const requestId = randomUUID();
  try {
    if (gate instanceof Response) return fromGuard(routeId, gate, requestId, services);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => !['cursor', 'limit'].includes(key) || params.getAll(key).length !== 1)) throw new AppError('invalid');
    const parsed = DevicePageQuerySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success) throw new AppError('invalid');
    if (!await hitRateLimit(`admin:device-list:${rateLimitSubject(gate.ip)}`, 120, 60_000, { onStoreError: 'closed' })) throw new AppError('rate_limited', { retryAfterSeconds: 60 });
    const result = await services.deviceManagement.list({ userId: gate.user.id, sid: gate.device.id, query: parsed.data });
    return finish(routeId, 200, result, {}, false, services);
  } catch (error) { return fromError(routeId, error, requestId, services); }
}

async function mutationBody(request: Request, gate: Exclude<DeviceGate, Response>) {
  const origin = assertSameOrigin(request);
  if (origin) throw new AppError('forbidden_origin');
  const allowed = await Promise.all([
    hitRateLimit(`device-management:account:${rateLimitKeyHash(gate.user.id)}`, 5, 10 * 60_000, { onStoreError: 'closed' }),
    hitRateLimit(`device-management:ip:${rateLimitSubject(gate.ip)}`, 20, 10 * 60_000, { onStoreError: 'closed' }),
  ]);
  if (allowed.some((ok) => !ok)) throw new AppError('rate_limited', { retryAfterSeconds: 600 });
  const json = await readJson(request, 2_000);
  if (json === TOO_LARGE) throw new AppError('too_large');
  return json;
}

export async function handleDeviceRevoke(request: Request, gate: DeviceGate, services: DeviceHttpServices, targetId: string) {
  const routeId = 'POST /api/admin/account/devices/[id]/revoke';
  const requestId = randomUUID();
  try {
    if (gate instanceof Response) return fromGuard(routeId, gate, requestId, services);
    const json = await mutationBody(request, gate);
    const parsed = DeviceRevokeRequestSchema.safeParse(json);
    if (!parsed.success || !IdSchema.safeParse(targetId).success) throw new AppError('invalid');
    const result = await services.deviceManagement.revoke({ userId: gate.user.id, sid: gate.device.id, targetId, grantToken: parsed.data.actionGrant, ip: gate.ip });
    return finish(routeId, 200, result, {}, targetId === gate.device.id, services);
  } catch (error) { return fromError(routeId, error, requestId, services); }
}

export async function handleLogoutAll(request: Request, gate: DeviceGate, services: DeviceHttpServices) {
  const routeId = 'POST /api/admin/account/logout-all';
  const requestId = randomUUID();
  try {
    if (gate instanceof Response) return fromGuard(routeId, gate, requestId, services);
    const json = await mutationBody(request, gate);
    const parsed = LogoutAllRequestSchema.safeParse(json);
    if (!parsed.success) throw new AppError('invalid');
    const result = await services.deviceManagement.logoutAll({ userId: gate.user.id, sid: gate.device.id, grantToken: parsed.data.actionGrant, ip: gate.ip });
    return finish(routeId, 200, result, {}, true, services);
  } catch (error) { return fromError(routeId, error, requestId, services); }
}
