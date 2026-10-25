import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConsentDTOSchema, ConsentRequestSchema } from '@/lib/contracts/analytics';
import { CONSENT_VERSION } from '@/lib/consent';
import { FieldErrorSchema, type FieldError } from '@/lib/contracts/errors';
import { rateLimitSubject, resolveClientIp } from '@/lib/edge/client-ip';
import {
  ANALYTICS_COOKIE_MAX_LENGTH,
  CONSENT_BODY_MAX_BYTES,
  CONSENT_COOKIE_RATE_LIMIT,
  CONSENT_IP_RATE_LIMIT,
  CONSENT_RATE_WINDOW_MS,
  CONSENT_RETRY_AFTER_SECONDS,
  analyticsCookieSecure,
  readAnalyticsCookie,
} from '@/lib/server/analytics/consent';
import { assertSameOrigin } from '@/lib/server/admin-guard';
import { createAnalyticsConsentServices, type AnalyticsConsentServices } from '@/lib/server/composition';
import type { ServerConfig } from '@/lib/server/config';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import type { ApiCounterDb, CounterLog } from '@/lib/server/http/metrics';
import { hitRateLimit, rateLimitKeyHash, readBody } from '@/lib/server/security';

const ROUTE_ID = 'POST /api/analytics/consent';

export function createConsentPost(deps: {
  db?: ApiCounterDb;
  config?: ServerConfig;
  clock?: () => Date;
  log?: (event: CounterLog) => void;
  env?: Record<string, string | undefined>;
  secret?: Buffer | null;
  randomId?: () => string;
  services?: AnalyticsConsentServices;
} = {}) {
  return async function POST(request: Request) {
    const requestId = randomUUID();
    const env = deps.env ?? process.env;
    let services: AnalyticsConsentServices | undefined;

    const finish = async (status: number, body: unknown, headers: Record<string, string>, setCookie?: string) => {
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
      const response = Response.json(outBody, {
        status: outStatus,
        headers: { ...headers, 'cache-control': 'private, no-store' },
      });
      if (setCookie) response.headers.append('set-cookie', setCookie);
      return response;
    };

    const fail = (error: AppError) => {
      const mapped = classifyThrown(error, requestId);
      if (mapped.kind !== 'mapped') throw new Error('consent error');
      return finish(mapped.status, mapped.body, mapped.headers);
    };

    try {
      services = deps.services ?? createAnalyticsConsentServices({
        db: deps.db,
        config: deps.config,
        clock: deps.clock,
        log: deps.log,
        env,
        secret: deps.secret,
        randomId: deps.randomId,
      });

      const origin = assertSameOrigin(request, env);
      if (origin) {
        await discardBody(request);
        return fail(new AppError('forbidden_origin'));
      }

      // 先扣已出示 cookie 的桶。这只否决当前请求，不占用同一出口的 IP 桶。
      const presented = cookieRateValue(request.headers.get('cookie'));
      if (presented) {
        const allowed = await hitRateLimit(
          `analytics:consent:cookie:${rateLimitKeyHash(presented, env)}`,
          CONSENT_COOKIE_RATE_LIMIT,
          CONSENT_RATE_WINDOW_MS,
          { onStoreError: 'closed' },
        );
        if (!allowed) {
          await discardBody(request);
          return fail(new AppError('rate_limited', { retryAfterSeconds: CONSENT_RETRY_AFTER_SECONDS }));
        }
      }

      const subject = rateLimitSubject(resolveClientIp(request.headers, env).ip);
      const ipAllowed = await hitRateLimit(
        `analytics:consent:ip:${rateLimitKeyHash(subject, env)}`,
        CONSENT_IP_RATE_LIMIT,
        CONSENT_RATE_WINDOW_MS,
        { onStoreError: 'closed' },
      );
      if (!ipAllowed) {
        await discardBody(request);
        return fail(new AppError('rate_limited', { retryAfterSeconds: CONSENT_RETRY_AFTER_SECONDS }));
      }

      const raw = await readBody(request, CONSENT_BODY_MAX_BYTES);
      if (raw === null) return fail(new AppError('too_large'));

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return fail(new AppError('invalid'));
      }

      const parsed = ConsentRequestSchema.safeParse(payload);
      if (!parsed.success) {
        const fieldErrors = fieldErrorsFrom(parsed.error);
        return fail(new AppError('invalid', fieldErrors ? { fieldErrors } : {}));
      }
      if (parsed.data.consentVersion !== CONSENT_VERSION) {
        return fail(new AppError('invalid', {
          fieldErrors: { consentVersion: 'Must be the current consent version.' },
        }));
      }

      const read = readAnalyticsCookie(request.headers.get('cookie'));
      const outcome = services.consent.apply({
        analytics: parsed.data.analytics,
        consentVersion: parsed.data.consentVersion,
        cookieValue: read.kind === 'one' ? read.value : undefined,
        secure: analyticsCookieSecure(request.url, env),
      });
      if (!outcome.ok) return fail(new AppError(outcome.code));
      return finish(200, ConsentDTOSchema.parse(outcome.body), {}, outcome.setCookie);
    } catch (error) {
      const mapped = classifyThrown(error, requestId);
      if (mapped.kind === 'legacy-response') return mapped.response;
      if (mapped.kind === 'legacy-body') return finish(500, mapped.body, { 'cache-control': 'private, no-store' });
      return finish(mapped.status, mapped.body, mapped.headers);
    }
  };
}

/** 限流只用一张长度受控的 cookie。超长或多张都不进 cookie 桶，避免未验签的值扩大计数键。 */
function cookieRateValue(header: string | null): string | null {
  const read = readAnalyticsCookie(header);
  if (read.kind !== 'one') return null;
  if (read.value.length < 1 || read.value.length > ANALYTICS_COOKIE_MAX_LENGTH) return null;
  return read.value;
}

function fieldErrorsFrom(error: z.ZodError): FieldError | undefined {
  const fields: { analytics?: string; consentVersion?: string } = {};
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') continue;
    const key = issue.path[0];
    if (key === 'analytics' && !fields.analytics) fields.analytics = 'Must be a boolean.';
    if (key === 'consentVersion' && !fields.consentVersion) fields.consentVersion = 'Must be a positive integer.';
  }
  const parsed = FieldErrorSchema.safeParse(fields);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return undefined;
  return parsed.data;
}

async function discardBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // 拒绝发生在读正文之前。取消失败也不把正文写进响应。
  }
}
