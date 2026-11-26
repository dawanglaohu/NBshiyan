'use client';

import { products } from '@/data/products';
import {
  AnalyticsEventDTOSchema,
  type AnalyticsEventDTO,
} from '@/lib/contracts/analytics';
import {
  ChatMessageRequestSchema,
  ChatMessagesQuerySchema,
  ChatReadRequestSchema,
  ChatSessionDTOSchema,
  ChatSessionRequestSchema,
  ChatSyncDTOSchema,
  ConversationCreateRequestSchema,
  ConversationReceivedDTOSchema,
  MessageReceivedDTOSchema,
  ReadDTOSchema,
  type ChatAuthorReferenceDTO,
  type ChatConversationDTO,
  type ChatMessageDTO,
  type ChatSessionDTO,
  type ChatSyncDTO,
  type ConversationReceivedDTO,
  type MessageReceivedDTO,
  type ReadDTO,
} from '@/lib/contracts/chat';
import {
  BodyTextSchema,
  IdSchema,
  ProductSlugSchema,
  SitePathSchema,
} from '@/lib/contracts/common';
import {
  canCollectAnalytics,
  currentNavigation,
  currentPageVisitSeq,
  enqueueAnalyticsEvents,
  sitePath,
} from './analytics';
import {
  requestApi,
  type ClientApiFailure,
  type ClientApiResult,
  type ClientTransport,
} from './api';
import type { ClientLocale } from './api-errors';

export const CHAT_BODY_MAX_POINTS = 4_000;
export const CHAT_EMAIL_MAX_LENGTH = 254;
const CHAT_SYNC_MAX_PAGES = 50;

const PUBLISHED_PRODUCT_SLUGS = new Set(products.map((item) => item.slug));

export type ChatFieldErrorCode =
  | 'body_required'
  | 'body_too_long'
  | 'body_html_disallowed'
  | 'body_invalid'
  | 'email_too_long'
  | 'email_invalid';

export type ChatComposerValidationErrors = {
  bodyText?: ChatFieldErrorCode;
  email?: ChatFieldErrorCode;
};

export type ChatComposerValidationResult =
  | { valid: true; bodyText: string; email?: string }
  | { valid: false; errors: ChatComposerValidationErrors };

export type ChatTerminalReason = 'expired' | 'not_found' | 'closed' | 'anonymized';

export type ChatRequestOptions = {
  signal?: AbortSignal;
  transport?: ClientTransport;
};

export type CreateChatConversationInput = {
  clientConversationId: string;
  clientMessageId: string;
  locale: ClientLocale;
  bodyText: string;
  email?: string;
  productSlug?: string;
  sourcePath?: string;
};

export type AppendChatMessageInput = {
  conversationId: string;
  clientMessageId: string;
  locale: ClientLocale;
  bodyText: string;
};

export type ChatUpdatesSnapshot = {
  conversation: ChatConversationDTO;
  messages: ChatMessageDTO[];
  authors: ChatAuthorReferenceDTO[];
  lastSeq: number;
  nextAfterSeq: number;
  read: ReadDTO;
};

export type ChatStartEvent = Extract<AnalyticsEventDTO, { kind: 'chat_start' }>;

export type ChatStartAttemptContext = {
  navigationId: string;
  path: string;
  locale: ClientLocale;
  pageVisitSeq: number;
};

export type ChatStartDeps = {
  canCollect: () => boolean;
  getNavigation: () => { navigationId: string; path: string; locale: ClientLocale } | null;
  getPageVisitSeq: () => number;
  enqueue: (events: AnalyticsEventDTO[]) => void;
  makeUuid: () => string;
  nowIso: () => string;
};

export type EmitChatStartInput = {
  context: ChatStartAttemptContext | null;
  clientConversationId: string;
  productSlug?: string;
};

export type EmitChatStartResult =
  | { status: 'skipped' }
  | { status: 'emitted'; event: ChatStartEvent }
  | { status: 'reused'; event: ChatStartEvent };

export function randomChatUuid(): string {
  return crypto.randomUUID();
}

export function isPublishedProductSlug(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !PUBLISHED_PRODUCT_SLUGS.has(value)) return false;
  return ProductSlugSchema.safeParse(value).success;
}

export function resolveChatProductSlug(
  search: string,
  quoteSlugs: readonly string[] = [],
): string | undefined {
  const params = new URLSearchParams(search);
  if (params.get('from') === 'quote') {
    if (quoteSlugs.length === 1 && isPublishedProductSlug(quoteSlugs[0])) {
      return quoteSlugs[0];
    }
    return undefined;
  }
  if (params.has('product')) {
    const raw = params.get('product');
    return isPublishedProductSlug(raw) ? raw : undefined;
  }
  return undefined;
}

export function sanitizeChatSourcePath(locale: ClientLocale, pathname: string): string | undefined {
  const candidate = sitePath(locale, pathname);
  const parsed = SitePathSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export function validateVisitorComposer(input: {
  bodyText: string;
  email?: string;
  includeEmail: boolean;
}): ChatComposerValidationResult {
  const errors: ChatComposerValidationErrors = {};

  const bodyWithoutNewlines = input.bodyText.replace(/[\r\n]/g, '');
  const trimmedBody = input.bodyText.trim();
  const bodyPoints = Array.from(trimmedBody).length;

  let validBody: string | undefined;
  if (/[\p{Cc}\p{Cf}]/u.test(bodyWithoutNewlines)) {
    errors.bodyText = 'body_invalid';
  } else if (bodyPoints === 0) {
    errors.bodyText = 'body_required';
  } else if (bodyPoints > CHAT_BODY_MAX_POINTS) {
    errors.bodyText = 'body_too_long';
  } else if (/<\/?[a-z!][^>]*>/i.test(trimmedBody)) {
    errors.bodyText = 'body_html_disallowed';
  } else {
    const parsedBody = BodyTextSchema.safeParse(input.bodyText);
    if (!parsedBody.success) {
      errors.bodyText = 'body_invalid';
    } else {
      validBody = parsedBody.data;
    }
  }

  let validEmail: string | undefined;
  if (input.includeEmail) {
    const parsedEmail = ConversationCreateRequestSchema.shape.email.safeParse(input.email);
    if (!parsedEmail.success) {
      const rawEmail = typeof input.email === 'string' ? input.email : '';
      if (/[\r\n<>]/.test(rawEmail)) {
        errors.email = 'email_invalid';
      } else if (rawEmail.trim().length > CHAT_EMAIL_MAX_LENGTH) {
        errors.email = 'email_too_long';
      } else {
        errors.email = 'email_invalid';
      }
    } else {
      validEmail = parsedEmail.data;
    }
  }

  if (errors.bodyText || errors.email || validBody === undefined) {
    return { valid: false, errors };
  }

  return validEmail !== undefined
    ? { valid: true, bodyText: validBody, email: validEmail }
    : { valid: true, bodyText: validBody };
}

export function classifyChatFailureTerminal(failure: ClientApiFailure): ChatTerminalReason | null {
  if (failure.status === 401 || failure.code === 'unauthorized') return 'expired';
  if (failure.status === 404 || failure.code === 'not_found') return 'not_found';
  if (failure.code === 'conversation_anonymized') return 'anonymized';
  if (failure.code === 'conversation_closed') return 'closed';
  return null;
}

export function isConversationTerminalStatus(conversation: Pick<ChatConversationDTO, 'status' | 'anonymizedAt'>): boolean {
  return conversation.status === 'CLOSED' || conversation.anonymizedAt !== null;
}

/**
 * 仅推进到从 1 起连续取齐的最大消息序号；中间存在未拉取的缺口时不得跳过，
 * 避免本地追加 seq=3 后跳过服务端尚未拉取的客服 seq=2。
 */
export function contiguousMessageSeq(messages: readonly Pick<ChatMessageDTO, 'seq'>[]): number {
  const seqs = Array.from(new Set(messages.map((item) => item.seq))).sort((a, b) => a - b);
  let cursor = 0;
  for (const seq of seqs) {
    if (seq === cursor + 1) {
      cursor += 1;
    } else if (seq > cursor + 1) {
      break;
    }
  }
  return cursor;
}

export function mergeConversationSnapshot(
  current: ChatConversationDTO | null,
  incoming: ChatConversationDTO,
): ChatConversationDTO {
  if (!current || current.id !== incoming.id) return incoming;
  const latest = incoming.version >= current.version ? incoming : current;
  const closed = current.status === 'CLOSED' || incoming.status === 'CLOSED' ? 'CLOSED' : latest.status;
  const anonymizedAt = current.anonymizedAt ?? incoming.anonymizedAt;
  return {
    ...latest,
    status: closed,
    anonymizedAt,
  };
}

export function mergeChatMessages(
  existing: readonly ChatMessageDTO[],
  incoming: readonly ChatMessageDTO[],
): ChatMessageDTO[] {
  const bySeq = new Map<number, ChatMessageDTO>();
  for (const item of existing) {
    bySeq.set(item.seq, item);
  }
  for (const item of incoming) {
    bySeq.set(item.seq, item);
  }
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

export function mergeChatAuthors(
  existing: readonly ChatAuthorReferenceDTO[],
  incoming: readonly ChatAuthorReferenceDTO[],
): ChatAuthorReferenceDTO[] {
  const byMessageId = new Map<string, ChatAuthorReferenceDTO>();
  for (const item of existing) {
    byMessageId.set(item.messageId, item);
  }
  for (const item of incoming) {
    byMessageId.set(item.messageId, item);
  }
  return Array.from(byMessageId.values());
}

export async function openChatSession(
  locale: ClientLocale,
  options?: ChatRequestOptions,
): Promise<ClientApiResult<ChatSessionDTO>> {
  const body = ChatSessionRequestSchema.parse({ locale });
  return requestApi({
    path: '/api/chat/session',
    method: 'POST',
    body,
    schema: ChatSessionDTOSchema,
    audience: 'visitor',
    locale,
    signal: options?.signal,
    transport: options?.transport,
  });
}

export async function createChatConversation(
  input: CreateChatConversationInput,
  options?: ChatRequestOptions,
): Promise<ClientApiResult<ConversationReceivedDTO>> {
  const payload: Record<string, unknown> = {
    clientConversationId: input.clientConversationId,
    clientMessageId: input.clientMessageId,
    locale: input.locale,
    bodyText: input.bodyText,
  };
  if (input.email !== undefined) {
    payload.email = input.email;
  }
  if (isPublishedProductSlug(input.productSlug)) {
    payload.productSlug = input.productSlug;
  }
  if (input.sourcePath !== undefined) {
    const parsedPath = SitePathSchema.safeParse(input.sourcePath);
    if (parsedPath.success) {
      payload.sourcePath = parsedPath.data;
    }
  }

  const parsed = ConversationCreateRequestSchema.parse(payload);
  const body = { ...parsed };
  if (body.email === undefined) {
    delete body.email;
  }
  return requestApi({
    path: '/api/chat/conversations',
    method: 'POST',
    body,
    schema: ConversationReceivedDTOSchema,
    audience: 'visitor',
    locale: input.locale,
    signal: options?.signal,
    transport: options?.transport,
  });
}

export async function appendChatMessage(
  input: AppendChatMessageInput,
  options?: ChatRequestOptions,
): Promise<ClientApiResult<MessageReceivedDTO>> {
  const conversationId = IdSchema.parse(input.conversationId);
  const body = ChatMessageRequestSchema.parse({
    clientMessageId: input.clientMessageId,
    bodyText: input.bodyText,
  });
  return requestApi({
    path: `/api/chat/conversations/${conversationId}/messages`,
    method: 'POST',
    body,
    schema: MessageReceivedDTOSchema,
    audience: 'visitor',
    locale: input.locale,
    signal: options?.signal,
    transport: options?.transport,
  });
}

export async function fetchChatSyncPage(
  conversationId: string,
  query: { afterSeq?: number; limit?: number },
  locale: ClientLocale,
  options?: ChatRequestOptions,
): Promise<ClientApiResult<ChatSyncDTO>> {
  const safeId = IdSchema.parse(conversationId);
  const parsedQuery = ChatMessagesQuerySchema.parse(query);
  const search = new URLSearchParams({
    afterSeq: String(parsedQuery.afterSeq),
    limit: String(parsedQuery.limit),
  });
  return requestApi({
    path: `/api/chat/conversations/${safeId}?${search.toString()}`,
    method: 'GET',
    schema: ChatSyncDTOSchema,
    audience: 'visitor',
    locale,
    signal: options?.signal,
    transport: options?.transport,
  });
}

export async function fetchChatConversationUpdates(
  conversationId: string,
  afterSeq: number,
  locale: ClientLocale,
  options?: ChatRequestOptions & { limit?: number },
): Promise<ClientApiResult<ChatUpdatesSnapshot>> {
  const limit = options?.limit ?? 50;
  let cursor = Math.max(0, Math.trunc(afterSeq));
  let mergedMessages: ChatMessageDTO[] = [];
  let mergedAuthors: ChatAuthorReferenceDTO[] = [];

  for (let page = 1; ; page += 1) {
    const res = await fetchChatSyncPage(conversationId, { afterSeq: cursor, limit }, locale, options);
    if (!res.ok) return res;
    const latest = res.data;
    if (latest.hasMore && latest.nextAfterSeq <= cursor) {
      return {
        ok: false,
        text: 'Conversation sync cursor did not advance.',
        action: 'retry',
        envelope: 'unavailable',
        retryable: true,
        attempts: res.attempts,
        transient: true,
      };
    }
    mergedMessages = mergeChatMessages(mergedMessages, latest.messages);
    mergedAuthors = mergeChatAuthors(mergedAuthors, latest.authors);
    // At the request budget, commit the received prefix so the next refresh can resume.
    if (!latest.hasMore || page === CHAT_SYNC_MAX_PAGES) {
      return {
        ok: true,
        attempts: res.attempts,
        data: {
          conversation: latest.conversation,
          messages: mergedMessages,
          authors: mergedAuthors,
          lastSeq: latest.lastSeq,
          nextAfterSeq: latest.nextAfterSeq,
          read: latest.read,
        },
      };
    }
    cursor = latest.nextAfterSeq;
  }
}

export async function markChatRead(
  conversationId: string,
  lastReadSeq: number,
  locale: ClientLocale,
  options?: ChatRequestOptions,
): Promise<ClientApiResult<ReadDTO>> {
  const safeId = IdSchema.parse(conversationId);
  const body = ChatReadRequestSchema.parse({ lastReadSeq });
  return requestApi({
    path: `/api/chat/conversations/${safeId}/read`,
    method: 'POST',
    body,
    schema: ReadDTOSchema,
    audience: 'visitor',
    locale,
    signal: options?.signal,
    transport: options?.transport,
  });
}

const DEFAULT_ANALYTICS_DEPS: ChatStartDeps = {
  canCollect: canCollectAnalytics,
  getNavigation: currentNavigation,
  getPageVisitSeq: currentPageVisitSeq,
  enqueue: enqueueAnalyticsEvents,
  makeUuid: randomChatUuid,
  nowIso: () => new Date().toISOString(),
};

export function createChatStartTracker(deps: ChatStartDeps = DEFAULT_ANALYTICS_DEPS) {
  const emittedByNav = new Map<string, { clientConversationId: string; event: ChatStartEvent }>();
  const attemptByConversation = new Map<string, ChatStartAttemptContext | null>();

  function sampleContext(): ChatStartAttemptContext | null {
    if (!deps.canCollect()) return null;
    const nav = deps.getNavigation();
    if (!nav) return null;
    return {
      navigationId: nav.navigationId,
      path: nav.path,
      locale: nav.locale,
      pageVisitSeq: deps.getPageVisitSeq(),
    };
  }

  /**
   * 首次真正发起建会提交时将当时的同意与导航上下文绑定到 `clientConversationId`；
   * 同键手动重试继续沿用原提交的绑定结果，防止响应丢失后因“后补同意”补发历史 chat_start。
   */
  function bindAttemptContext(clientConversationId: string): ChatStartAttemptContext | null {
    if (attemptByConversation.has(clientConversationId)) {
      return attemptByConversation.get(clientConversationId) ?? null;
    }
    const sampled = sampleContext();
    attemptByConversation.set(clientConversationId, sampled);
    return sampled;
  }

  function captureAttemptContext(clientConversationId?: string): ChatStartAttemptContext | null {
    if (clientConversationId) return bindAttemptContext(clientConversationId);
    return sampleContext();
  }

  function emitOnCreateSuccess(input: EmitChatStartInput): EmitChatStartResult {
    const { clientConversationId, productSlug } = input;
    const bound = attemptByConversation.has(clientConversationId)
      ? attemptByConversation.get(clientConversationId) ?? null
      : input.context;

    if (!bound) return { status: 'skipped' };
    if (!deps.canCollect()) return { status: 'skipped' };

    const activeNav = deps.getNavigation();
    if (!activeNav) return { status: 'skipped' };
    if (deps.getPageVisitSeq() !== bound.pageVisitSeq) return { status: 'skipped' };
    if (activeNav.navigationId !== bound.navigationId) return { status: 'skipped' };

    const existing = emittedByNav.get(bound.navigationId);
    if (existing) {
      if (existing.clientConversationId === clientConversationId) {
        return { status: 'reused', event: existing.event };
      }
      return { status: 'skipped' };
    }

    const parsedPath = SitePathSchema.safeParse(bound.path);
    const candidate: Record<string, unknown> = {
      kind: 'chat_start',
      eventId: deps.makeUuid(),
      occurredAt: deps.nowIso(),
      locale: bound.locale,
      navigationId: bound.navigationId,
    };
    if (parsedPath.success) {
      candidate.path = parsedPath.data;
    }
    if (isPublishedProductSlug(productSlug)) {
      candidate.productSlug = productSlug;
    }

    const parsedEvent = AnalyticsEventDTOSchema.safeParse(candidate);
    if (!parsedEvent.success || parsedEvent.data.kind !== 'chat_start') {
      return { status: 'skipped' };
    }

    emittedByNav.set(bound.navigationId, {
      clientConversationId,
      event: parsedEvent.data,
    });
    deps.enqueue([parsedEvent.data]);
    return { status: 'emitted', event: parsedEvent.data };
  }

  return {
    bindAttemptContext,
    captureAttemptContext,
    emitOnCreateSuccess,
  };
}

export const chatStartTracker = createChatStartTracker();
