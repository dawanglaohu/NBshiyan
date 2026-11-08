import { createHash } from 'node:crypto';
import type { ConversationCreateRequest } from '../contracts/chat';

/** 请求体上限：先按字节限体，再做字段校验（E-39 / 10 节接口约定）。 */
export const CHAT_BODY_MAX_BYTES = 16 * 1024;
/** 正文按 code point 计：1..4000，纯文本。 */
export const CHAT_BODY_MIN_POINTS = 1;
export const CHAT_BODY_MAX_POINTS = 4_000;
/** email 可省略；填写时 trim 后不超过 254 个字符。 */
export const CHAT_EMAIL_MAX_LENGTH = 254;
/** 咨询与附件保留：最后一条成功保存的访客消息或人工回复之后 90 天（E-86）。 */
export const CHAT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** 稳定 Message-ID 的域名部分。M4-T4 发送时再包上尖括号，重试复用同一个值。 */
export const CHAT_STABLE_MESSAGE_ID_DOMAIN = 'chat.packjoyu';
/** 10 节：聊天写每会话 20 条/分钟。创建首消息也落在同一个会话（cookie）桶里。 */
export const CHAT_WRITE_COOKIE_LIMIT = 20;
export const CHAT_WRITE_WINDOW_MS = 60_000;
export const CHAT_WRITE_RETRY_AFTER_SECONDS = 60;
export const CHAT_WRITE_RATE_PREFIX = 'chat:conversations:cookie:';

/**
 * 创建载荷的规范化字符串。只收契约字段，按固定键序序列化，
 * 保证同一份输入在任何进程、任何重试里得到同一个哈希。
 * email、productSlug、sourcePath 缺省统一成 null，避免 undefined 与 null 产生两个哈希。
 */
function canonicalCreatePayload(input: ConversationCreateRequest): string {
  return JSON.stringify({
    clientConversationId: input.clientConversationId,
    clientMessageId: input.clientMessageId,
    locale: input.locale,
    bodyText: input.bodyText,
    email: input.email ?? null,
    productSlug: input.productSlug ?? null,
    sourcePath: input.sourcePath ?? null,
  });
}

/** 整个创建载荷的哈希：同 clientConversationId 异哈希即 409（10 节幂等约定）。 */
export function conversationCreatePayloadHash(input: ConversationCreateRequest): string {
  return createHash('sha256').update(canonicalCreatePayload(input)).digest('hex');
}

/** 单条消息的哈希：会话已存在时用它判断同 clientMessageId 是否同内容。 */
export function firstMessagePayloadHash(input: ConversationCreateRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ clientMessageId: input.clientMessageId, bodyText: input.bodyText }))
    .digest('hex');
}

/** 稳定 Message-ID：同一 messageId 永远得到同一个值，重试和重启后都复用（E-90/E-92）。 */
export function stableNotificationMessageId(messageId: string): string {
  return `${messageId}@${CHAT_STABLE_MESSAGE_ID_DOMAIN}`;
}

/** 咨询保留截止：最后一条成功保存的消息时间 + 90 天。 */
export function chatRetainUntil(now: Date): Date {
  return new Date(now.getTime() + CHAT_RETENTION_MS);
}
