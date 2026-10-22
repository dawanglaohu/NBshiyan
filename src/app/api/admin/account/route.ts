import { randomUUID } from 'crypto';
import type { Role } from '@prisma/client';
import { readSessionToken } from '@/auth';
import { createAdminServices } from '@/lib/server/composition';
import { accountDto, type BoundAccess } from '@/lib/server/admin/device-session';
import { denialError, withClearedSession } from '@/lib/server/admin/guard';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import type { ApiCounter } from '@/lib/server/http/metrics';
import { clientIp, hitRateLimit, rateLimitSubject } from '@/lib/server/security';

export const runtime = 'nodejs';

const AREA = ['ADMIN', 'SALES', 'EDITOR'] as const satisfies readonly Role[];

export async function authorizeAccount(request: Request): Promise<BoundAccess> {
  const services = createAdminServices();
  const token = await readSessionToken(request);
  return services.devices.authenticate({
    userId: typeof token?.uid === 'string' ? token.uid : undefined,
    sessionVersion: typeof token?.sv === 'number' ? token.sv : undefined,
    sid: typeof token?.sid === 'string' ? token.sid : undefined,
    roles: AREA,
  });
}

async function finish(status: number, body: unknown, headers: Record<string, string>, clear: boolean, record: ApiCounter['recordFinalResponse']) {
  const recorded = await record({ routeId: 'GET /api/admin/account', status, body });
  const response = Response.json(recorded.body, { status: recorded.status, headers: { ...headers, 'cache-control': 'private, no-store' } });
  return clear ? withClearedSession(response) : response;
}

export function createAccountGet(deps: {
  authorize?: (request: Request) => Promise<BoundAccess>;
  record?: ApiCounter['recordFinalResponse'];
} = {}) {
  const authorize = deps.authorize ?? authorizeAccount;
  const record = deps.record ?? ((response) => createAdminServices().apiCounter.recordFinalResponse(response));
  return async function GET(request: Request) {
    const requestId = randomUUID();
    try {
      const decision = await authorize(request);
      if (!decision.ok) {
        const mapped = classifyThrown(new AppError(denialError(decision.reason) as 'unauthorized' | 'account_disabled' | 'forbidden'), requestId);
        if (mapped.kind !== 'mapped') throw new Error('account denial');
        return finish(mapped.status, mapped.body, mapped.headers, decision.reason !== 'forbidden', record);
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

export const GET = createAccountGet();
