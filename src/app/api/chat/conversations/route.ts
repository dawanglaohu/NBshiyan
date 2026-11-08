import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConversationCreateRequestSchema, ConversationReceivedDTOSchema } from '@/lib/contracts/chat';
import { FieldErrorSchema, type FieldError } from '@/lib/contracts/errors';
import { rateLimitSubject, resolveClientIp } from '@/lib/edge/client-ip';
import {
  CHAT_BODY_MAX_BYTES,
  CHAT_NEW_SESSION_COOKIE_LIMIT,
  CHAT_NEW_SESSION_COOKIE_PREFIX,
  CHAT_NEW_SESSION_IP_LIMIT,
  CHAT_NEW_SESSION_IP_PREFIX,
  CHAT_NEW_SESSION_RETRY_AFTER_SECONDS,
  CHAT_NEW_SESSION_WINDOW_MS,
  CHAT_WRITE_COOKIE_LIMIT,
  CHAT_WRITE_RATE_PREFIX,
  CHAT_WRITE_RETRY_AFTER_SECONDS,
  CHAT_WRITE_WINDOW_MS,
} from '@/lib/chat/rules';
import { assertSameOrigin } from '@/lib/server/admin-guard';
import { ChatIdempotencyConflict, ChatUnpublishedProduct } from '@/lib/server/chat/conversation-service';
import { isDatabaseUnavailable } from '@/lib/server/chat/repo';
import {
  chatVisitorCookieSecure,
  clearChatVisitorCookie,
  readChatVisitorCookie,
} from '@/lib/server/chat/visitor-session';
import { createChatServices, type ChatServices } from '@/lib/server/composition';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import { hitRateLimit, rateLimitKeyHash, readBody } from '@/lib/server/security';

export const runtime = 'nodejs';

const ROUTE_ID = 'POST /api/chat/conversations';
const FIELD_NAMES = new Set([
  'clientConversationId', 'clientMessageId', 'locale', 'bodyText', 'email', 'productSlug', 'sourcePath',
]);
const CONFLICT_MESSAGE = 'This identifier was used for different content.';

/**
 * 访客建立咨询并保存首条消息。
 *
 * 顺序固定：同源校验 → 16KiB 限体 → strict schema → 必要 cookie → 会话服务。
 * 身份只来自 HttpOnly 访客 cookie，不接受请求体里自报的会话或邮箱代替身份（E-39/E-40）。
 * 成功才返回已持久化的 conversationId、message 与 receivedAt；重复提交返回同一份结果并标 duplicate。
 */
export async function POST(request: Request) {
  const requestId = randomUUID();
  const env = process.env;
  const secure = chatVisitorCookieSecure(request.url, env);
  let services: ChatServices | undefined;

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

  const fail = (error: AppError, setCookie?: string) => {
    const mapped = classifyThrown(error, requestId);
    if (mapped.kind !== 'mapped') throw new Error('chat conversations error');
    const response = Response.json(mapped.body, {
      status: mapped.status,
      headers: { ...mapped.headers, 'cache-control': 'private, no-store' },
    });
    if (setCookie) response.headers.append('set-cookie', setCookie);
    return response;
  };

  try {
    services = createChatServices();

    const origin = assertSameOrigin(request, env);
    if (origin) {
      await discardBody(request);
      return fail(new AppError('forbidden_origin'));
    }

    const raw = await readBody(request, CHAT_BODY_MAX_BYTES);
    if (raw === null) return fail(new AppError('too_large'));

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return fail(new AppError('invalid'));
    }

    const parsed = ConversationCreateRequestSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors = fieldErrorsFrom(parsed.error);
      return fail(new AppError('invalid', fieldErrors ? { fieldErrors } : {}));
    }

    const read = readChatVisitorCookie(request.headers.get('cookie'));
    if (read.kind !== 'one') {
      return fail(new AppError('unauthorized'), read.kind === 'ambiguous' ? clearChatVisitorCookie(secure) : undefined);
    }

    // 10 节:121 新会话两桶：匿名 cookie 10 次/10 分钟、可信边缘 IP 派生 HMAC 20 次/10 分钟。
    // 两桶都计数（不是二选一），先返回 cookie 桶结果；不保存原始 IP，key 只含派生值。
    const ip = resolveClientIp(request.headers, env).ip;
    const [cookieAllowed, ipAllowed] = await Promise.all([
      hitRateLimit(
        `${CHAT_NEW_SESSION_COOKIE_PREFIX}${rateLimitKeyHash(read.value, env)}`,
        CHAT_NEW_SESSION_COOKIE_LIMIT,
        CHAT_NEW_SESSION_WINDOW_MS,
        { onStoreError: 'closed' },
      ),
      hitRateLimit(
        `${CHAT_NEW_SESSION_IP_PREFIX}${rateLimitSubject(ip)}`,
        CHAT_NEW_SESSION_IP_LIMIT,
        CHAT_NEW_SESSION_WINDOW_MS,
        { onStoreError: 'closed' },
      ),
    ]);
    if (!cookieAllowed || !ipAllowed) {
      return fail(new AppError('rate_limited', { retryAfterSeconds: CHAT_NEW_SESSION_RETRY_AFTER_SECONDS }));
    }

    // 10 节：聊天写每会话 20 条/分钟；创建首消息同样落在这个 cookie 桶里。
    const allowed = await hitRateLimit(
      `${CHAT_WRITE_RATE_PREFIX}${rateLimitKeyHash(read.value, env)}`,
      CHAT_WRITE_COOKIE_LIMIT,
      CHAT_WRITE_WINDOW_MS,
      { onStoreError: 'closed' },
    );
    if (!allowed) {
      return fail(new AppError('rate_limited', { retryAfterSeconds: CHAT_WRITE_RETRY_AFTER_SECONDS }));
    }

    const session = await services.visitorSessions.establish(read.value);
    if (session.kind === 'rejected') return fail(new AppError('unauthorized'), clearChatVisitorCookie(secure));

    let received;
    try {
      received = await services.conversations.createFirstMessage({
        visitorSessionId: session.id,
        payload: parsed.data,
      });
    } catch (error) {
      if (error instanceof ChatUnpublishedProduct) {
        return fail(new AppError('invalid', { fieldErrors: { productSlug: 'Must be a published product.' } }));
      }
      if (error instanceof ChatIdempotencyConflict) {
        const fieldErrors = { [error.field]: CONFLICT_MESSAGE } as FieldError;
        return fail(new AppError('idempotency_conflict', { fieldErrors }));
      }
      // 10 节:122：可识别的数据库不可用/超时 → 503；其余未知编程错误仍走 500。
      if (isDatabaseUnavailable(error)) {
        return fail(new AppError('service_unavailable'));
      }
      throw error;
    }

    return finish(200, ConversationReceivedDTOSchema.parse(received), {});
  } catch (error) {
    const mapped = classifyThrown(error, requestId);
    if (mapped.kind === 'legacy-response') return withPrivateNoStore(mapped.response);
    if (mapped.kind === 'legacy-body') return finish(500, mapped.body, {});
    return finish(mapped.status, mapped.body, mapped.headers);
  }
}

function fieldErrorsFrom(error: z.ZodError): FieldError | undefined {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? '');
    if (!FIELD_NAMES.has(field) || fields[field]) continue;
    fields[field] = fieldMessage(field, issue.code);
  }
  const parsed = FieldErrorSchema.safeParse(fields);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return undefined;
  return parsed.data;
}

function fieldMessage(field: string, code: string): string {
  if (field === 'email') return 'Enter a single valid email address without a display name or line breaks.';
  if (field === 'bodyText') return `Enter plain text between 1 and ${4_000} characters.`;
  if (field === 'locale') return 'Must be a published locale.';
  if (field === 'clientConversationId' || field === 'clientMessageId') return 'Must be a UUID.';
  if (field === 'productSlug') return 'Must be a published product key.';
  if (field === 'sourcePath') return 'Must be a site path without a query string.';
  return code === 'unrecognized_keys' ? 'This field is not accepted.' : 'Invalid value.';
}

/** 已经构造好的响应原样交还，只补上不缓存。头不可变时复制一份，状态、正文和其余头保持不变。 */
function withPrivateNoStore(response: Response): Response {
  try {
    response.headers.set('cache-control', 'private, no-store');
    return response;
  } catch {
    const headers = new Headers();
    response.headers.forEach((value, key) => {
      if (key === 'set-cookie') return;
      headers.set(key, value);
    });
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    headers.set('cache-control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

async function discardBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // 拒绝发生在读正文之前。取消失败也不把正文写进响应。
  }
}
