import { randomUUID } from 'node:crypto';
import { AnalyticsReceiptDTOSchema } from '@/lib/contracts/analytics';
import { rateLimitSubject, resolveClientIp } from '@/lib/edge/client-ip';
import { readAnalyticsCookie } from '@/lib/server/analytics/consent';
import {
  ANALYTICS_EVENTS_COOKIE_LIMIT,
  ANALYTICS_EVENTS_COOKIE_PREFIX,
  ANALYTICS_EVENTS_IP_LIMIT,
  ANALYTICS_EVENTS_IP_PREFIX,
  ANALYTICS_EVENTS_MAX_BYTES,
  ANALYTICS_EVENTS_RETRY_AFTER_SECONDS,
  ANALYTICS_EVENTS_WINDOW_MS,
  analyticsEventsAttemptCount,
} from '@/lib/server/analytics/ingest';
import { assertSameOrigin } from '@/lib/server/admin-guard';
import { isDbUnavailable } from '@/lib/server/designs';
import { createAnalyticsIngestServices, type AnalyticsIngestServices } from '@/lib/server/composition';
import type { ServerConfig } from '@/lib/server/config';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import type { CounterLog } from '@/lib/server/http/metrics';
import { hitRateLimit, rateLimitKeyHash, readBody, refundRateLimit } from '@/lib/server/security';
import type { PrismaClient } from '@prisma/client';

const ROUTE_ID = 'POST /api/analytics/events';

export function createEventsPost(deps: {
  db?: PrismaClient;
  config?: ServerConfig;
  clock?: () => Date;
  log?: (event: CounterLog) => void;
  env?: Record<string, string | undefined>;
  secret?: Buffer | null;
  services?: AnalyticsIngestServices;
} = {}) {
  return async function POST(request: Request) {
    const requestId = randomUUID();
    const env = deps.env ?? process.env;
    let services: AnalyticsIngestServices | undefined;

    const finish = async (status: number, body: unknown, headers: Record<string, string>) => {
      let outStatus = status;
      let outBody = body;
      if (services) {
        try {
          const recorded = await services.apiCounter.recordFinalResponse({ routeId: ROUTE_ID, status, body });
          outStatus = recorded.status;
          outBody = recorded.body;
        } catch {
          // 计数失败不改变已经决定的状态和正文。
        }
      }
      return Response.json(outBody, {
        status: outStatus,
        headers: { ...headers, 'cache-control': 'private, no-store' },
      });
    };

    const fail = (error: AppError) => {
      const mapped = classifyThrown(error, requestId);
      if (mapped.kind !== 'mapped') throw new Error('analytics events error');
      return finish(mapped.status, mapped.body, mapped.headers);
    };

    try {
      services = deps.services ?? createAnalyticsIngestServices({
        db: deps.db,
        config: deps.config,
        clock: deps.clock,
        log: deps.log,
        env,
        secret: deps.secret,
      });

      const origin = assertSameOrigin(request, env);
      if (origin) {
        await discardBody(request);
        return fail(new AppError('forbidden_origin'));
      }

      const header = request.headers.get('cookie');
      const read = readAnalyticsCookie(header);
      const consent = read.kind === 'one' ? services.consent.verifyValue(read.value) : null;
      if (!consent || read.kind !== 'one') {
        await discardBody(request);
        return fail(new AppError('analytics_consent_required'));
      }

      const cookieKey = `${ANALYTICS_EVENTS_COOKIE_PREFIX}${rateLimitKeyHash(read.value, env)}`;
      const subject = rateLimitSubject(resolveClientIp(request.headers, env).ip);
      const ipKey = `${ANALYTICS_EVENTS_IP_PREFIX}${rateLimitKeyHash(subject, env)}`;

      const rawText = await readBody(request, ANALYTICS_EVENTS_MAX_BYTES);
      if (rawText === null) {
        if (!await takeEvents(cookieKey, ipKey, 1)) return fail(rateLimited());
        return fail(new AppError('too_large'));
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawText);
      } catch {
        if (!await takeEvents(cookieKey, ipKey, 1)) return fail(rateLimited());
        return fail(new AppError('invalid'));
      }

      const count = analyticsEventsAttemptCount(payload);
      if (!await takeEvents(cookieKey, ipKey, count)) return fail(rateLimited());

      const receipt = AnalyticsReceiptDTOSchema.parse(await services.ingest.accept(payload, consent.browserHash));
      return finish(200, receipt, {});
    } catch (error) {
      if (isDbUnavailable(error)) return fail(new AppError('service_unavailable'));
      const mapped = classifyThrown(error, requestId);
      if (mapped.kind === 'legacy-response') return privateNoStore(mapped.response);
      if (mapped.kind === 'legacy-body') return finish(500, mapped.body, { 'cache-control': 'private, no-store' });
      return finish(mapped.status, mapped.body, mapped.headers);
    }
  };
}

function privateNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rateLimited(): AppError {
  return new AppError('rate_limited', { retryAfterSeconds: ANALYTICS_EVENTS_RETRY_AFTER_SECONDS });
}

async function takeEvents(cookieKey: string, ipKey: string, count: number): Promise<boolean> {
  if (!await takeKey(cookieKey, ANALYTICS_EVENTS_COOKIE_LIMIT, count)) return false;
  if (await takeKey(ipKey, ANALYTICS_EVENTS_IP_LIMIT, count)) return true;
  await refundKey(cookieKey, count);
  return false;
}

async function takeKey(key: string, limit: number, count: number): Promise<boolean> {
  let taken = 0;
  for (let index = 0; index < count; index += 1) {
    const allowed = await hitRateLimit(key, limit, ANALYTICS_EVENTS_WINDOW_MS, { onStoreError: 'closed' });
    if (!allowed) {
      await refundKey(key, taken + 1);
      return false;
    }
    taken += 1;
  }
  return true;
}

async function refundKey(key: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await refundRateLimit(key, ANALYTICS_EVENTS_WINDOW_MS);
}

async function discardBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // 拒绝发生在读正文之前。取消失败也不把正文写进响应。
  }
}
