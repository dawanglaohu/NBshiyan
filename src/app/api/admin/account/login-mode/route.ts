import { randomUUID } from 'node:crypto';
import { AccountModeRequestSchema, AccountModeDTOSchema } from '@/lib/contracts/account';
import { AppErrorCodeSchema } from '@/lib/contracts/errors';
import { requireAdmin, assertSameOrigin } from '@/lib/server/auth';
import { withClearedSession, type AdminCtx } from '@/lib/server/admin/guard';
import { readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import type { ApiCounter } from '@/lib/server/http/metrics';
import { clientIp, hitRateLimit, rateLimitKeyHash, rateLimitSubject } from '@/lib/server/security';
import { createAdminServices } from '@/lib/server/composition';

export const runtime = 'nodejs';

const ROUTE_ID = 'PATCH /api/admin/account/login-mode';
const BODY_LIMIT = 2_000;
const WINDOW_MS = 10 * 60_000;
const ACCOUNT_LIMIT = 5;
const IP_LIMIT = 20;

type Gate = (AdminCtx & { device: { id: string } }) | Response;

function mappedDenial(code: import('@/lib/contracts/errors').AppErrorCode, requestId: string, retry?: number) {
  const mapped = classifyThrown(new AppError(code, retry ? { retryAfterSeconds: retry } : {}), requestId);
  if (mapped.kind !== 'mapped') throw new Error('account mode denial');
  return mapped;
}

async function finish(status: number, body: unknown, headers: Record<string, string>, clear: boolean, counter: ApiCounter) {
  const recorded = await counter.recordFinalResponse({ routeId: ROUTE_ID, status, body });
  let response = Response.json(recorded.body, { status: recorded.status, headers: { ...headers, 'cache-control': 'private, no-store' } });
  if (clear) response = withClearedSession(response);
  return response;
}

/** PATCH /api/admin/account/login-mode：仅 LOGIN_MODE grant 可切换，成功后所有旧设备失效。 */
export async function PATCH(request: Request) {
  const services = createAdminServices();
  const requestId = randomUUID();
  const counter = services.apiCounter;
  try {
    const originBlocked = assertSameOrigin(request);
    if (originBlocked) {
      const payload = await originBlocked.json() as { error?: unknown };
      const code = AppErrorCodeSchema.safeParse(payload.error);
      const mapped = mappedDenial(code.success ? code.data : 'forbidden_origin', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, false, counter);
    }
    const gate: Gate = await requireAdmin(request, ['ADMIN', 'SALES', 'EDITOR']);
    if (gate instanceof Response) {
      const payload = await gate.json() as { error?: unknown };
      const code = AppErrorCodeSchema.safeParse(payload.error);
      const retry = Number(gate.headers.get('retry-after'));
      const mapped = mappedDenial(code.success ? code.data : 'unauthorized', requestId, Number.isInteger(retry) && retry > 0 ? retry : undefined);
      return finish(mapped.status, mapped.body, mapped.headers, mapped.body.error === 'unauthorized', counter);
    }
    const [accountOk, ipOk] = await Promise.all([
      hitRateLimit(`account-mode:acct:${rateLimitKeyHash(gate.user.id)}`, ACCOUNT_LIMIT, WINDOW_MS, { onStoreError: 'closed' }),
      hitRateLimit(`account-mode:ip:${rateLimitSubject(clientIp(request))}`, IP_LIMIT, WINDOW_MS, { onStoreError: 'closed' }),
    ]);
    if (!accountOk || !ipOk) {
      const mapped = mappedDenial('rate_limited', requestId, WINDOW_MS / 1000);
      return finish(mapped.status, mapped.body, mapped.headers, false, counter);
    }
    const json = await readJson(request, BODY_LIMIT);
    if (json === TOO_LARGE) {
      const mapped = mappedDenial('too_large', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, false, counter);
    }
    const parsed = AccountModeRequestSchema.safeParse(json);
    if (!parsed.success) {
      const mapped = mappedDenial('invalid', requestId);
      return finish(mapped.status, mapped.body, mapped.headers, false, counter);
    }
    const changed = await services.accountSecurity.changeLoginMode({
      userId: gate.user.id,
      sid: gate.device.id,
      passwordlessEnabled: parsed.data.passwordlessEnabled,
      grantToken: parsed.data.actionGrant,
      ip: gate.ip,
    });
    const body = AccountModeDTOSchema.parse({
      passwordlessEnabled: parsed.data.passwordlessEnabled,
      changedAt: changed.changedAt.toISOString(),
    });
    return finish(200, body, {}, false, counter);
  } catch (error) {
    const mapped = classifyThrown(error, requestId);
    if (mapped.kind === 'legacy-response') return mapped.response;
    if (mapped.kind === 'legacy-body') return finish(500, mapped.body, { 'cache-control': 'private, no-store' }, false, counter);
    return finish(mapped.status, mapped.body, mapped.headers, mapped.body.error === 'unauthorized', counter);
  }
}
