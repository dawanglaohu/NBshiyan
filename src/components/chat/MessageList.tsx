'use client';

import { useTranslations } from 'next-intl';
import { Status } from '@/components/ui/Status';
import type { ChatConversationDTO, ChatMessageDTO } from '@/lib/contracts/chat';

export type ChatReceiptBanner = {
  conversationId: string;
  messageId: string;
  seq: number;
  receivedAt: string;
};

type MessageListProps = {
  conversation: ChatConversationDTO | null;
  messages: readonly ChatMessageDTO[];
  receipt: ChatReceiptBanner | null;
  receivedAtByMessageId: ReadonlyMap<string, string>;
  loading: boolean;
  locale: 'en' | 'ru';
};

function formatMessageTime(iso: string, locale: 'en' | 'ru'): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return iso;
  }
}

export default function MessageList({
  conversation,
  messages,
  receipt,
  receivedAtByMessageId,
  loading,
  locale,
}: MessageListProps) {
  const t = useTranslations('Chat');

  return (
    <div className="pj-chat-log-wrap">
      {receipt && (
        <Status
          tone="success"
          prefix={t('receivedPrefix')}
          className="pj-chat-receipt"
          data-testid="chat-receipt"
          data-conversation-id={receipt.conversationId}
          data-message-id={receipt.messageId}
          data-seq={receipt.seq}
          data-received-at={receipt.receivedAt}
        >
          <span>{t('receivedAwaitingHandling')}</span>{' '}
          <span className="pj-chat-receipt-meta">
            #{receipt.seq} · {formatMessageTime(receipt.receivedAt, locale)}
          </span>
        </Status>
      )}

      {messages.length === 0 ? (
        !loading && (
          <p className="pj-chat-empty" data-testid="chat-empty">
            {t('emptyThread')}
          </p>
        )
      ) : (
        <ol
          className="pj-chat-messages"
          data-testid="chat-messages"
          data-conversation-id={conversation?.id ?? ''}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-label={t('messagesLabel')}
        >
          {messages.map((message) => {
            const msgReceivedAt = receivedAtByMessageId.get(message.id) ?? message.createdAt;
            const senderLabel =
              message.sender === 'VISITOR' ? t('senderVisitor') : t('senderOperator');
            return (
              <li
                key={message.id}
                className="pj-chat-message"
                data-testid="chat-message-item"
                data-sender={message.sender}
                data-message-id={message.id}
                data-seq={message.seq}
                data-received-at={msgReceivedAt}
              >
                <div className="pj-chat-message-head">
                  <span className="pj-chat-message-sender">{senderLabel}</span>
                  <span className="pj-chat-message-meta">
                    #{message.seq} ·{' '}
                    <time dateTime={message.createdAt}>
                      {formatMessageTime(message.createdAt, locale)}
                    </time>
                  </span>
                </div>
                <p className="pj-chat-message-body">{message.bodyText}</p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
