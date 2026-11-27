'use client';

import type { ClientApiFailure, ClientAudience } from './api';
import {
  classifyChatFailureTerminal,
  type AppendChatMessageInput,
  type ChatTerminalReason,
  type CreateChatConversationInput,
} from './chat';

export type MessageSubmission = CreateChatConversationInput | AppendChatMessageInput;

export type ChatRetryNoticeKind =
  | 'unconfirmed'
  | 'offline_retryable'
  | 'retryable'
  | 'idempotency_conflict';

export type ChatSendFailureResolution =
  | {
      kind: 'terminal';
      terminalReason: ChatTerminalReason;
      preserveDraft: true;
      clearPendingRetry: true;
    }
  | {
      kind: 'field_errors';
      fieldErrors: { bodyText?: string; email?: string };
      preserveDraft: true;
      clearPendingRetry: true;
    }
  | {
      kind: 'retry_pending';
      notice: ChatRetryNoticeKind;
      pendingSubmission: MessageSubmission | null;
      lockInputs: boolean;
      preserveDraft: true;
      preserveKeys: true;
    };

export function isNavigatorOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * 统一判定提交/重试失败后的状态转移（E-18、E-37、E-38、E-78、E-85）。
 * - 失权/关闭/匿名化/不存在：立即停发、清待确认重试、保留当前标签页内存草稿、不自动换 UUID。
 * - 幂等冲突（409）：绝不自动更换 UUID 或跨线程重发，保留草稿并停止盲目复用旧键。
 * - 状态未知（截断/超时/5xx/多次尝试）：冻结原 payload 与 UUID、锁定只读待确认并允许原 key 重试。
 * - 确定离线未落库：保留当前标签页内存中的可编辑草稿与原 UUID，允许恢复联网后重试或转用邮箱入口。
 */
export function resolveChatSendFailure(input: {
  failure: ClientApiFailure;
  submission: MessageSubmission;
  hadPendingRetry: boolean;
  audience?: ClientAudience;
  offline?: boolean;
}): ChatSendFailureResolution {
  const { failure, submission, hadPendingRetry, audience = 'visitor' } = input;
  const offline = input.offline ?? isNavigatorOffline();

  const terminalReason = classifyChatFailureTerminal(failure, { audience });
  if (terminalReason !== null) {
    return {
      kind: 'terminal',
      terminalReason,
      preserveDraft: true,
      clearPendingRetry: true,
    };
  }

  if (failure.status === 409 || failure.code === 'idempotency_conflict') {
    return {
      kind: 'retry_pending',
      notice: 'idempotency_conflict',
      pendingSubmission: null,
      lockInputs: false,
      preserveDraft: true,
      preserveKeys: true,
    };
  }

  const fieldErrors: { bodyText?: string; email?: string } = {};
  if (failure.fieldErrors?.email) {
    fieldErrors.email = failure.fieldErrors.email;
  }
  if (failure.fieldErrors?.bodyText) {
    fieldErrors.bodyText = failure.fieldErrors.bodyText;
  }
  if (fieldErrors.email || fieldErrors.bodyText) {
    return {
      kind: 'field_errors',
      fieldErrors,
      preserveDraft: true,
      clearPendingRetry: true,
    };
  }

  const status = failure.status;
  if (!hadPendingRetry && offline && status === undefined) {
    return {
      kind: 'retry_pending',
      notice: 'offline_retryable',
      pendingSubmission: null,
      lockInputs: false,
      preserveDraft: true,
      preserveKeys: true,
    };
  }

  // A missing receipt after attempt(s), 408/5xx, or later rate limit can follow a committed write.
  const unknownOutcome =
    hadPendingRetry ||
    failure.attempts > 1 ||
    (failure.attempts > 0 && (status === undefined || status < 400 || status === 408 || status >= 500));

  if (unknownOutcome) {
    return {
      kind: 'retry_pending',
      notice: 'unconfirmed',
      pendingSubmission: submission,
      lockInputs: true,
      preserveDraft: true,
      preserveKeys: true,
    };
  }

  return {
    kind: 'retry_pending',
    notice: 'retryable',
    pendingSubmission: null,
    lockInputs: false,
    preserveDraft: true,
    preserveKeys: true,
  };
}

/**
 * 构建下一次发信/重试载荷；待确认状态强制返回冻结的原载荷以保证原 UUID 与原内容幂等重放。
 */
export function selectChatSubmissionPayload(input: {
  pendingRetry: MessageSubmission | null;
  conversationId: string | null;
  clientConversationId: string;
  clientMessageId: string;
  locale: 'en' | 'ru';
  bodyText: string;
  email?: string;
  productSlug?: string;
  sourcePath?: string;
}): MessageSubmission {
  if (input.pendingRetry !== null) {
    return input.pendingRetry;
  }
  if (input.conversationId === null) {
    return {
      clientConversationId: input.clientConversationId,
      clientMessageId: input.clientMessageId,
      locale: input.locale,
      bodyText: input.bodyText,
      email: input.email,
      productSlug: input.productSlug,
      sourcePath: input.sourcePath,
    };
  }
  return {
    conversationId: input.conversationId,
    clientMessageId: input.clientMessageId,
    locale: input.locale,
    bodyText: input.bodyText,
  };
}
