import { randomUUID } from 'node:crypto';
import { ChatConversationParamsSchema, ChatReadRequestSchema, ReadDTOSchema } from '@/lib/contracts/chat';
import { CHAT_BODY_MAX_BYTES } from '@/lib/chat/rules';
import { assertSameOrigin } from '@/lib/server/admin-guard';
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
import { hitRateLimit, rateLimitKeyHash, readBody } from '@/lib/server/security';

export const runtime = 'nodejs';

const ROUTE_ID = 'POST /api/chat/conversations/[id]/read';
type RouteParams = { params: Promise<{ id: string }> };

/**
 * 访客推进本人会话的读位置（10 节：lastReadSeq 必填；read 采用 MAX，单调推进）。
 *
 * 顺序固定：精确同源 → 16KiB 限体 → strict schema → 必要 cookie → 同步限流 → 会话校验 → 路径 id → 服务。
 * 只有本人的访客 cookie 能读自己的会话；请求越过 lastSeq 只推进到已存在的最大 seq，乱序/重试不回退。
 */
export async function POST(request: Request, { params }: RouteParams) {
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
    if (mapped.kind !== 'mapped') throw new Error('chat read error');
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

    const parsed = ChatReadRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return fail(new AppError('invalid', { fieldErrors: { lastReadSeq: 'Must be a non-negative integer within range.' } }));
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

    const { id } = await params;
    if (!ChatConversationParamsSchema.safeParse({ id }).success) return fail(new AppError('not_found'));

    const outcome = await services.visitorRead.markRead({
      session: resolved.session,
      conversationId: id,
      lastReadSeq: parsed.data.lastReadSeq,
    });
    if (outcome.kind === 'not_found') return fail(new AppError('not_found'));

    return finish(200, ReadDTOSchema.parse(outcome.value), {});
  } catch (error) {
    if (isDatabaseUnavailable(error)) return fail(new AppError('service_unavailable'));
    const mapped = classifyThrown(error, requestId);
    if (mapped.kind === 'legacy-response') return withPrivateNoStore(mapped.response);
    if (mapped.kind === 'legacy-body') return finish(500, mapped.body, {});
    return finish(mapped.status, mapped.body, mapped.headers);
  }
}

async function discardBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // 拒绝发生在读正文之前。取消失败也不把正文写进响应。
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
