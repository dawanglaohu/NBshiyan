// #74 第 1 阶段：后台域名邮箱接口类型。与 backend-plan v4 §8（8.0–8.10）和 §15「接口兼容性」逐字段对齐。
// 页面只依赖 MailApi；mock（mock.ts）和真实接口（http.ts）实现同一个接口，切换见 api.ts。

export type MailFlag = 'too_large' | 'auto' | 'bounce' | 'attachment_rejected' | 'parse_error';
export const KNOWN_FLAGS: readonly MailFlag[] = ['too_large', 'auto', 'bounce', 'attachment_rejected', 'parse_error'];

/** 8.3 / 8.9 附件：downloadUrl 为 5 分钟签名链接 */
export type MailAttachment = { id: string; filename: string; sniffedType: string; size: number; downloadUrl: string; expiresAt: string };

/** 8.3 往来记录条目（新表 source:"mail"，旧 InquiryMessage source:"legacy"） */
export type ThreadItem = {
  id: string; source: 'mail' | 'legacy'; direction: 'INBOUND' | 'OUTBOUND';
  status: 'SENDING' | 'SENT' | 'FAILED' | 'RECEIVED' | 'QUEUED';
  /** 第 1 阶段恒为 unknown；第 2 阶段才可能 bounced（前端第 1 阶段不显示投递失败） */
  deliveryStatus: 'unknown' | 'bounced'; bouncedAt: string | null;
  retryCount: number; maxRetries: number;
  redacted: boolean;
  from: string | null; to: string | null; authorName: string | null;
  subject: string | null; bodyHtml: string | null; bodyText: string | null;
  hasRemoteImages: boolean;
  senderVerified: boolean | null;
  /** 可能含后端以后新增的值：未知 flag 不显示 */
  flags: string[];
  errorCode: string | null; retryable: boolean;
  /** v4 §17：daily_cap_deferred 时的预计发送时间（ISO UTC） */
  deferredUntil?: string | null;
  createdAt: string; sentAt: string | null; receivedAt: string | null;
  attachments: MailAttachment[];
};
export type ThreadPage = { anonymizedAt: string | null; items: ThreadItem[]; nextCursor: string | null; linksExpireAt?: string | null };

/** 8.3a 单条状态 */
/** v4 §17：daily_cap_deferred 时可能是 QUEUED，带 deferredUntil（ISO UTC），不带 pollAfterMs */
export type SendStatus = { id: string; status: 'SENDING' | 'SENT' | 'FAILED' | 'QUEUED'; deferredUntil?: string | null; errorCode: string | null; retryable: boolean; retryCount: number; maxRetries: number; deliveryStatus: 'unknown' | 'bounced'; sentAt: string | null };

/** §15 补充：GET /api/admin/mail/config */
export type MailConfig = { sendingEnabled: boolean };

/** 8.4 未归类列表 */
export type UnassignedRow = {
  id: string; redacted: boolean; from: string | null; subject: string | null; receivedAt: string; snippet: string | null;
  attachmentCount: number; flags: string[]; senderVerified: boolean | null; suggestedInquiryRef: string | null; expiresAt: string;
};
export type UnassignedPage = { items: UnassignedRow[]; nextCursor: string | null; counts: { unassigned: number; ignored: number } };
/** 8.9 未归类详情 */
export type UnassignedDetail = {
  id: string; status: 'UNASSIGNED' | 'IGNORED'; redacted: boolean; from: string | null; to: string | null; subject: string | null;
  bodyHtml: string | null; bodyText: string | null; hasRemoteImages: boolean; senderVerified: boolean | null; flags: string[];
  receivedAt: string; expiresAt: string; suggestedInquiryRef: string | null; attachments: MailAttachment[];
};
/** 8.10 归档预检 */
export type AssignLookup = { inquiryId: string; ref: string; customer: { name: string; emailMasked: string; company: string | null }; status: string; createdAt: string };

/** 8.1 / 8.2 发信结果（成功类） */
export type SendResult =
  | { kind: 'sent'; id: string; sentAt: string | null; retryCount: number; maxRetries: number }
  | { kind: 'sending'; id: string; pollAfterMs: number; deferred?: boolean; deferredUntil?: string | null };

/**
 * 所有失败统一抛 MailError：http.ts 按状态码 + 错误体 `error` 字段分支（8.0），UI 只看 code。
 * - 409：anonymized | retry_limit | not_retryable | sending_disabled | not_unassigned，其他 409 一律 unknown
 * - 502：mail_failed（带 id / reason / retryable）
 */
export type MailErrorBody = {
  fields?: Record<string, string>; limits?: Record<string, number>;
  field?: 'body' | 'request'; limit?: number; unit?: 'chars' | 'bytes';
  scope?: 'admin' | 'global'; retryAfterSec?: number; windowSec?: number;
  id?: string; reason?: string; retryable?: boolean; deferredUntil?: string;
};
export class MailError extends Error {
  constructor(public code: string, public status: number, public body: MailErrorBody = {}) { super(code); this.name = 'MailError'; }
}

export interface MailApi {
  getConfig(): Promise<MailConfig>;
  getThread(inquiryId: string, cursor?: string): Promise<ThreadPage>;
  send(inquiryId: string, body: { subject: string; body: string; inReplyToId?: string }, idempotencyKey: string): Promise<SendResult>;
  retry(messageId: string, idempotencyKey: string): Promise<SendResult>;
  status(messageId: string): Promise<SendStatus>;
  refreshLinks(ids: string[]): Promise<{ links: { id: string; downloadUrl: string; expiresAt: string }[]; missing: string[] }>;
  /** 拿到附件内容；403 expired 抛 MailError('expired')，410 抛 'deleted' */
  download(url: string): Promise<Blob>;
  unassignedCount(): Promise<{ unassigned: number }>;
  listUnassigned(status: 'UNASSIGNED' | 'IGNORED', cursor?: string): Promise<UnassignedPage>;
  getUnassigned(id: string): Promise<UnassignedDetail>;
  assignLookup(ref: string): Promise<AssignLookup>;
  assign(id: string, inquiryRef: string): Promise<{ id: string; inquiryId: string; status: 'RECEIVED' }>;
  ignore(id: string): Promise<{ id: string; status: 'IGNORED' }>;
  unignore(id: string): Promise<{ id: string; status: 'UNASSIGNED' }>;
}
