import { randomUUID } from 'node:crypto';
import { ChatConversationParamsSchema, ChatMessageRequestSchema, MessageReceivedDTOSchema } from '@/lib/contracts/chat';
import type { FieldError } from '@/lib/contracts/errors';
import {
  CHAT_BODY_MAX_BYTES,
  CHAT_WRITE_COOKIE_LIMIT,
  CHAT_WRITE_RATE_PREFIX,
  CHAT_WRITE_RETRY_AFTER_SECONDS,
  CHAT_WRITE_WINDOW_MS,
} from '@/lib/chat/rules';
import { assertSameOrigin } from '@/lib/server/admin-guard';
import { ChatSessionNoLongerValid, ChatTransactionBudgetExceeded, isDatabaseUnavailable } from '@/lib/server/chat/repo';
import { chatVisitorCookieSecure, clearChatVisitorCookie, readChatVisitorCookie } from '@/lib/server/chat/visitor-session';
import { createChatServices, type ChatServices } from '@/lib/server/composition';
import { AppError, isAppError, mapAppError, mapUnknownFailure } from '@/lib/server/http/errors';
import { hitRateLimit, rateLimitKeyHash, readBody } from '@/lib/server/security';

export const runtime = 'nodejs';

const ROUTE_ID = 'POST /api/chat/conversations/[id]/messages';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const env = process.env;
  let services: ChatServices | undefined;
  let clearCookie = false;

  async function finish(status: number, body: unknown, headers: Record<string, string> = {}) {
    const recorded = await services?.apiCounter.recordFinalResponse({ routeId: ROUTE_ID, status, body })
      .catch(() => undefined);
    const response = Response.json(recorded?.body ?? body, {
      status: recorded?.status ?? status,
      headers: { ...headers, 'cache-control': 'private, no-store' },
    });
    if (clearCookie) {
      response.headers.append('set-cookie', clearChatVisitorCookie(chatVisitorCookieSecure(request.url, env)));
    }
    return response;
  }

  try {
    services = createChatServices();
    if (assertSameOrigin(request, env)) {
      await request.body?.cancel().catch(() => undefined);
      throw new AppError('forbidden_origin');
    }

    const raw = await readBody(request, CHAT_BODY_MAX_BYTES);
    if (raw === null) throw new AppError('too_large');
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new AppError('invalid');
    }
    const parsed = ChatMessageRequestSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: FieldError = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'clientMessageId') fieldErrors.clientMessageId = 'Must be a UUID.';
        if (issue.path[0] === 'bodyText') fieldErrors.bodyText = 'Enter plain text between 1 and 4000 characters.';
      }
      throw new AppError('invalid', { fieldErrors });
    }

    const cookie = readChatVisitorCookie(request.headers.get('cookie'));
    if (cookie.kind !== 'one') {
      clearCookie = cookie.kind === 'ambiguous';
      throw new AppError('unauthorized');
    }

    const allowed = await hitRateLimit(
      `${CHAT_WRITE_RATE_PREFIX}${rateLimitKeyHash(cookie.value, env)}`,
      CHAT_WRITE_COOKIE_LIMIT,
      CHAT_WRITE_WINDOW_MS,
      { onStoreError: 'closed' },
    );
    if (!allowed) throw new AppError('rate_limited', { retryAfterSeconds: CHAT_WRITE_RETRY_AFTER_SECONDS });

    const resolved = await services.visitorSessions.resolve(cookie.value);
    if (resolved.kind === 'rejected') throw new ChatSessionNoLongerValid();

    const path = ChatConversationParamsSchema.safeParse(await params);
    if (!path.success) throw new AppError('not_found');
    const received = await services.messages.appendVisitorMessage({
      session: resolved.session,
      conversationId: path.data.id,
      payload: parsed.data,
    });
    return finish(200, MessageReceivedDTOSchema.parse(received));
  } catch (error) {
    if (error instanceof ChatSessionNoLongerValid) {
      clearCookie = true;
      error = new AppError('unauthorized');
    } else if (error instanceof ChatTransactionBudgetExceeded || isDatabaseUnavailable(error)) {
      error = new AppError('service_unavailable');
    }
    const mapped = isAppError(error) ? mapAppError(error, requestId) : mapUnknownFailure(error, requestId);
    return finish(mapped.status, mapped.body, mapped.headers);
  }
}
