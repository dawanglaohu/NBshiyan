import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ChatSessionDTOSchema, ChatSessionRequestSchema } from '@/lib/contracts/chat';
import { FieldErrorSchema, type FieldError } from '@/lib/contracts/errors';
import { rateLimitSubject, resolveClientIp } from '@/lib/edge/client-ip';
import { assertSameOrigin } from '@/lib/server/admin-guard';
import {
  CHAT_SESSION_BODY_MAX_BYTES,
  CHAT_SESSION_COOKIE_LIMIT,
  CHAT_SESSION_COOKIE_RATE_PREFIX,
  CHAT_SESSION_IP_LIMIT,
  CHAT_SESSION_IP_RATE_PREFIX,
  CHAT_SESSION_RATE_WINDOW_MS,
  CHAT_SESSION_RETRY_AFTER_SECONDS,
  chatVisitorCookieSecure,
  chatVisitorRateToken,
  chatVisitorSetCookie,
  clearChatVisitorCookie,
  readChatVisitorCookie,
  sessionDto,
} from '@/lib/server/chat/visitor-session';
import { createChatServices, type ChatServices } from '@/lib/server/composition';
import type { ServerConfig } from '@/lib/server/config';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import type { ApiCounterDb, CounterLog } from '@/lib/server/http/metrics';
import type { VisitorSessionStore } from '@/lib/server/chat/visitor-session-repo';
import { hitRateLimit, rateLimitKeyHash, readBody } from '@/lib/server/security';

const ROUTE_ID = 'POST /api/chat/session';

export function createChatSessionPost(deps: {
  db?: ApiCounterDb & VisitorSessionStore;
  config?: ServerConfig;
  clock?: () => Date;
  log?: (event: CounterLog) => void;
  env?: Record<string, string | undefined>;
  services?: ChatServices;
} = {}) {
  return async function POST(request: Request) {
    const requestId = randomUUID();
    const env = deps.env ?? process.env;
    let services: ChatServices | undefined;
    const secure = chatVisitorCookieSecure(request.url, env);

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

    const fail = (error: AppError, setCookie?: string) => {
      const mapped = classifyThrown(error, requestId);
      if (mapped.kind !== 'mapped') throw new Error('chat session error');
      return finish(mapped.status, mapped.body, mapped.headers, setCookie);
    };

    try {
      const now = (deps.clock ?? (() => new Date()))();
      services = deps.services ?? createChatServices({
        db: deps.db,
        config: deps.config,
        clock: () => now,
        log: deps.log,
      });

      const origin = assertSameOrigin(request, env);
      if (origin) {
        await discardBody(request);
        return fail(new AppError('forbidden_origin'));
      }

      // 先扣已出示的一张格式正确的 cookie。这只否决当前请求，不占用同一出口的 IP 桶。
      const presented = chatVisitorRateToken(request.headers.get('cookie'));
      if (presented) {
        const allowed = await hitRateLimit(
          `${CHAT_SESSION_COOKIE_RATE_PREFIX}${rateLimitKeyHash(presented, env)}`,
          CHAT_SESSION_COOKIE_LIMIT,
          CHAT_SESSION_RATE_WINDOW_MS,
          { onStoreError: 'closed' },
        );
        if (!allowed) {
          await discardBody(request);
          return fail(new AppError('rate_limited', { retryAfterSeconds: CHAT_SESSION_RETRY_AFTER_SECONDS }));
        }
      }

      const subject = rateLimitSubject(resolveClientIp(request.headers, env).ip);
      const ipAllowed = await hitRateLimit(
        `${CHAT_SESSION_IP_RATE_PREFIX}${rateLimitKeyHash(subject, env)}`,
        CHAT_SESSION_IP_LIMIT,
        CHAT_SESSION_RATE_WINDOW_MS,
        { onStoreError: 'closed' },
      );
      if (!ipAllowed) {
        await discardBody(request);
        return fail(new AppError('rate_limited', { retryAfterSeconds: CHAT_SESSION_RETRY_AFTER_SECONDS }));
      }

      const raw = await readBody(request, CHAT_SESSION_BODY_MAX_BYTES);
      if (raw === null) return fail(new AppError('too_large'));

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return fail(new AppError('invalid'));
      }

      const parsed = ChatSessionRequestSchema.safeParse(payload);
      if (!parsed.success) {
        const fieldErrors = fieldErrorsFrom(parsed.error);
        return fail(new AppError('invalid', fieldErrors ? { fieldErrors } : {}));
      }

      const read = readChatVisitorCookie(request.headers.get('cookie'));
      if (read.kind === 'ambiguous') return fail(new AppError('unauthorized'), clearChatVisitorCookie(secure));

      const outcome = await services.visitorSessions.establish(read.kind === 'one' ? read.value : null);
      if (outcome.kind === 'rejected') return fail(new AppError('unauthorized'), clearChatVisitorCookie(secure));

      // available 只表示必要会话通道可用，不表示有人在线。locale 只校验，不写入会话行。
      return finish(
        200,
        ChatSessionDTOSchema.parse(sessionDto(outcome.expiresAt)),
        {},
        chatVisitorSetCookie(outcome.token, outcome.expiresAt, now, secure),
      );
    } catch (error) {
      const mapped = classifyThrown(error, requestId);
      if (mapped.kind === 'legacy-response') return mapped.response;
      if (mapped.kind === 'legacy-body') return finish(500, mapped.body, { 'cache-control': 'private, no-store' });
      return finish(mapped.status, mapped.body, mapped.headers);
    }
  };
}

function fieldErrorsFrom(error: z.ZodError): FieldError | undefined {
  const fields: { locale?: string; email?: string } = {};
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      const keys = 'keys' in issue && Array.isArray(issue.keys) ? issue.keys : [];
      if (keys.includes('email') && !fields.email) fields.email = 'Email is not accepted on this request.';
      continue;
    }
    if (issue.path[0] === 'locale' && !fields.locale) fields.locale = 'Must be en or ru.';
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
