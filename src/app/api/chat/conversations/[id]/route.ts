import { randomUUID } from 'node:crypto';
import {
  ChatConversationParamsSchema,
  ChatMessagesQuerySchema,
  ChatSyncDTOSchema,
} from '@/lib/contracts/chat';
import {
  chatVisitorCookieSecure,
  clearChatVisitorCookie,
  readChatVisitorCookie,
} from '@/lib/server/chat/visitor-session';
import {
  CHAT_SYNC_COOKIE_LIMIT,
  CHAT_SYNC_RATE_PREFIX,
  CHAT_SYNC_RETRY_AFTER_SECONDS,
  CHAT_SYNC_WINDOW_MS,
} from '@/lib/server/chat/visitor-read';
import { isDatabaseUnavailable } from '@/lib/server/chat/repo';
import { createChatServices, type ChatServices } from '@/lib/server/composition';
import { AppError, classifyThrown } from '@/lib/server/http/errors';
import { hitRateLimit, rateLimitKeyHash } from '@/lib/server/security';

export const runtime = 'nodejs';

const ROUTE_ID = 'GET /api/chat/conversations/[id]';
type RouteParams = { params: Promise<{ id: string }> };

/**
 * 访客读取本人会话的一页消息（10 节：afterSeq 默认 0、limit 默认 50、上限 100）。
 *
 * 顺序固定：路径 id 校验 → 查询串 strict 校验 → 必要 cookie → 同步限流 → 会话校验 → 只读服务。
 * 身份只来自 HttpOnly 访客 cookie；不属于该会话的 id 一律 404，不区分「不存在」与「不是你的」。
 * GET 不写库：不 touch 会话、不推进读位置（E-79）。
 */
export async function GET(request: Request, { params }: RouteParams) {
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
    if (mapped.kind !== 'mapped') throw new Error('chat sync error');
    const response = Response.json(mapped.body, {
      status: mapped.status,
      headers: { ...mapped.headers, 'cache-control': 'private, no-store' },
    });
    if (setCookie) response.headers.append('set-cookie', setCookie);
    return response;
  };

  try {
    services = createChatServices();

    const { id } = await params;
    if (!ChatConversationParamsSchema.safeParse({ id }).success) return fail(new AppError('not_found'));

    let query;
    try {
      query = ChatMessagesQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    } catch {
      return fail(new AppError('invalid'));
    }

    const read = readChatVisitorCookie(request.headers.get('cookie'));
    if (read.kind !== 'one') {
      return fail(new AppError('unauthorized'), read.kind === 'ambiguous' ? clearChatVisitorCookie(secure) : undefined);
    }

    const allowed = await hitRateLimit(
      `${CHAT_SYNC_RATE_PREFIX}${rateLimitKeyHash(read.value, env)}`,
      CHAT_SYNC_COOKIE_LIMIT,
      CHAT_SYNC_WINDOW_MS,
      { onStoreError: 'closed' },
    );
    if (!allowed) return fail(new AppError('rate_limited', { retryAfterSeconds: CHAT_SYNC_RETRY_AFTER_SECONDS }));

    const resolved = await services.visitorSessions.resolve(read.value);
    if (resolved.kind === 'rejected') return fail(new AppError('unauthorized'), clearChatVisitorCookie(secure));

    const outcome = await services.visitorRead.getSync({
      session: resolved.session,
      conversationId: id,
      afterSeq: query.afterSeq,
      limit: query.limit,
    });
    if (outcome.kind === 'not_found') return fail(new AppError('not_found'));

    return finish(200, ChatSyncDTOSchema.parse(outcome.value), {});
  } catch (error) {
    if (isDatabaseUnavailable(error)) return fail(new AppError('service_unavailable'));
    const mapped = classifyThrown(error, requestId);
    if (mapped.kind === 'legacy-response') return withPrivateNoStore(mapped.response);
    if (mapped.kind === 'legacy-body') return finish(500, mapped.body, {});
    return finish(mapped.status, mapped.body, mapped.headers);
  }
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
