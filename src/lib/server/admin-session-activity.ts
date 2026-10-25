import { randomUUID } from 'crypto';
import { sealSessionCookie, sessionSetCookie } from '@/auth';
import { SessionActivityDTOSchema, SessionActivityRequestSchema } from '@/lib/contracts/account';
import { AppErrorCodeSchema, type AppErrorCode } from '@/lib/contracts/errors';
import { withClearedSession } from '@/lib/server/admin/guard';
import { readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { assertSameOrigin, enforceAdminUserRateLimit, requireAdmin } from '@/lib/server/auth';
import type { AdminServices } from '@/lib/server/composition';
import { createAdminServices } from '@/lib/server/composition';
import { AppError, classifyThrown } from '@/lib/server/http/errors';

const ROUTE_ID = 'POST /api/admin/account/session/activity';
const ROLES = ['ADMIN', 'SALES', 'EDITOR'] as const;
/** 真实客户端 15 分钟才上报一次。按用户每分钟大约 6 次，挡住不守节流的调用方。 */
const ACTIVITY_USER_LIMIT = 6;
type ActivityRecord = (response: { routeId: string; status: number; body: unknown }) => Promise<{ status: number; body: unknown }>;

async function finish(
  status: number,
  body: unknown,
  headers: Record<string, string>,
  cookies: readonly string[],
  clear: boolean,
  record: ActivityRecord,
) {
  const recorded = await record({ routeId: ROUTE_ID, status, body });
  const responseHeaders = new Headers({ ...headers, 'cache-control': 'private, no-store' });
  let response = Response.json(recorded.body, { status: recorded.status, headers: responseHeaders });
  if (clear) response = withClearedSession(response);
  for (const cookie of cookies) response.headers.append('set-cookie', cookie);
  return response;
}

function mappedDenial(code: AppErrorCode, requestId: string, retryAfterSeconds?: number) {
  const mapped = classifyThrown(new AppError(code, retryAfterSeconds ? { retryAfterSeconds } : {}), requestId);
  if (mapped.kind !== 'mapped') throw new Error('activity denial');
  return mapped;
}

/** 把守卫的旧 {error} 响应收成带 requestId 的信封。未授权和停用清 cookie；同源拒绝、限流和角色不符保留 cookie。 */
async function fromGuard(response: Response, requestId: string, record: ActivityRecord) {
  const payload = await response.json() as { error?: unknown };
  const code = AppErrorCodeSchema.safeParse(payload.error);
  if (!code.success) throw new Error('activity guard');
  const retry = Number(response.headers.get('retry-after'));
  const mapped = mappedDenial(code.data, requestId, Number.isInteger(retry) && retry > 0 ? retry : undefined);
  const clear = code.data === 'unauthorized' || code.data === 'account_disabled';
  return finish(mapped.status, mapped.body, mapped.headers, [], clear, record);
}

export async function handleSessionActivity(request: Request, services: AdminServices = createAdminServices()) {
  const requestId = randomUUID();
  const record: ActivityRecord = (response) => services.apiCounter.recordFinalResponse(response);
  try {
    const originBlocked = assertSameOrigin(request);
    if (originBlocked) return fromGuard(originBlocked, requestId, record);
    const decision = await requireAdmin(request, [...ROLES]);
    if (decision instanceof Response) return fromGuard(decision, requestId, record);
    const limited = await enforceAdminUserRateLimit(decision.user.id, 'account.session.activity', ACTIVITY_USER_LIMIT);
    if (limited) return fromGuard(limited, requestId, record);
    const json = await readJson(request, 1_000);
    if (json === TOO_LARGE) {
      const mapped = mappedDenial('too_large', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, [], false, record);
    }
    const parsed = SessionActivityRequestSchema.safeParse(json);
    if (!parsed.success) {
      const mapped = mappedDenial('invalid', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, [], false, record);
    }
    const activity = await services.devices.recordActivity({
      userId: decision.user.id,
      sessionVersion: decision.user.sessionVersion,
      sid: decision.device.id,
    });
    if (!activity.ok) {
      if (activity.reason === 'unavailable') {
        const mapped = mappedDenial('service_unavailable', requestId);
        return finish(mapped.status, mapped.body, mapped.headers, [], false, record);
      }
      const code: AppErrorCode = activity.reason === 'disabled' ? 'account_disabled' : activity.reason === 'forbidden' ? 'forbidden' : 'unauthorized';
      const mapped = mappedDenial(code, requestId);
      return finish(mapped.status, mapped.body, mapped.headers, [], code !== 'forbidden', record);
    }
    const body = SessionActivityDTOSchema.parse({
      effectiveExpiresAt: activity.bounds.effectiveExpiresAt.toISOString(),
      absoluteExpiresAt: activity.bounds.absoluteExpiresAt ? activity.bounds.absoluteExpiresAt.toISOString() : null,
    });
    const headers = { 'retry-after': String(activity.retryAfterSeconds) };
    if (!activity.wrote) return finish(200, body, headers, [], false, record);
    const sealed = await sealSessionCookie({
      sub: activity.user.id,
      uid: activity.user.id,
      sid: activity.device.id,
      sv: activity.user.sessionVersion,
      role: activity.user.role,
      email: activity.user.email,
      name: activity.user.name,
      authTime: activity.device.createdAt.toISOString(),
      effectiveExpiresAt: body.effectiveExpiresAt,
      absoluteExpiresAt: body.absoluteExpiresAt,
    });
    if (!sealed) {
      const mapped = mappedDenial('service_unavailable', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, [], false, record);
    }
    return finish(200, body, headers, [sessionSetCookie(sealed.value, sealed.exp)], false, record);
  } catch (error) {
    const mapped = classifyThrown(error, requestId);
    if (mapped.kind === 'legacy-response') return mapped.response;
    if (mapped.kind === 'legacy-body') return finish(500, mapped.body, {}, [], false, record);
    return finish(mapped.status, mapped.body, mapped.headers, [], false, record);
  }
}
