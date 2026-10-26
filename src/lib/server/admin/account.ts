import { randomUUID } from 'crypto';
import { createAdminServices } from '@/lib/server/composition';
import { accountDto } from './device-session';
import { requireAdmin, withClearedSession } from './guard';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import type { ApiCounter } from '@/lib/server/http/metrics';
import { clientIp, hitRateLimit, rateLimitSubject } from '@/lib/server/security';

async function finish(status: number, body: unknown, headers: Record<string, string>, clear: boolean, record: ApiCounter['recordFinalResponse']) {
  const recorded = await record({ routeId: 'GET /api/admin/account', status, body });
  const response = Response.json(recorded.body, { status: recorded.status, headers: { ...headers, 'cache-control': 'private, no-store' } });
  return clear ? withClearedSession(response) : response;
}

export function createAccountGet(deps: {
  authorize?: typeof requireAdmin;
  record?: ApiCounter['recordFinalResponse'];
} = {}) {
  const authorize = deps.authorize ?? ((request: Request) => requireAdmin(request, ['ADMIN', 'SALES', 'EDITOR']));
  const record = deps.record ?? ((response) => createAdminServices().apiCounter.recordFinalResponse(response));
  return async function GET(request: Request) {
    const requestId = randomUUID();
    try {
      const decision = await authorize(request);
      if (decision instanceof Response) {
        const { error } = await decision.json() as { error: 'unauthorized' | 'account_disabled' | 'forbidden' | 'service_unavailable' };
        const mapped = classifyThrown(new AppError(error), requestId);
        if (mapped.kind !== 'mapped') throw new Error('account denial');
        return finish(mapped.status, mapped.body, mapped.headers, decision.headers.getSetCookie().length > 0, record);
      }
      const allowed = await hitRateLimit(`admin:account.read:${rateLimitSubject(clientIp(request))}`, 120, 60_000, { onStoreError: 'closed' });
      if (!allowed) {
        const mapped = classifyThrown(new AppError('rate_limited', { retryAfterSeconds: 60 }), requestId);
        if (mapped.kind !== 'mapped') throw new Error('account rate limit');
        return finish(mapped.status, mapped.body, mapped.headers, false, record);
      }
      const body = accountDto(decision.user, decision.device, decision.bounds);
      return finish(200, body, {}, false, record);
    } catch (error) {
      const mapped = classifyThrown(error, requestId);
      if (mapped.kind === 'legacy-response') return mapped.response;
      if (mapped.kind === 'legacy-body') return finish(500, mapped.body, { 'cache-control': 'private, no-store' }, false, record);
      return finish(mapped.status, mapped.body, mapped.headers, false, record);
    }
  };
}
