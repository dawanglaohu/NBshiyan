/**
 * #74 发信适配器接口（和发信商无关）。实现：smtp.ts（Gmail SMTP，nodemailer）、mock.ts（测试 / 本地）。
 * 适配器只负责“把一封已经组好的信交给发信商”并把结果归类；收件人、限额、状态机都在 send.ts。
 */
export type OutboundMail = {
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  /** <sendKey@REPLY_DOMAIN>，§16 由我们生成，重试不变 */
  messageId: string;
  sendKey: string;
  inReplyTo?: string;
  references?: string;
};

/** 失败原因码（§8.1 表 + §16/§17）。前端不认识的码一律按 unknown 处理 */
export type SendFailReason =
  | 'send_unavailable' // 连接阶段失败，确定没发出：可重试
  | 'provider_throttled' // 421 / 454 / 其他 4xx 临时错误、Gmail 配额：可重试（不自动重发），计 n/5
  | 'send_auth' // 535 认证失败：配置错误，不可重试，发运维告警
  | 'smtp_tls' // TLS 握手 / 证书失败：配置错误，不可重试，发运维告警
  | 'recipient_rejected' // RCPT 阶段 5xx
  | 'message_rejected' // 5xx 拒收内容，或本地校验发现头部注入
  | 'unknown_delivery' // 已进入 DATA 之后超时 / 断开：可能已送达，不自动不手动重试
  | 'unknown';

export type SendOutcome =
  | { ok: true; messageId: string }
  | { ok: false; reason: SendFailReason; retryable: boolean; code: string | null; alert: boolean };

export interface MailSendAdapter {
  readonly kind: 'smtp' | 'mock';
  send(mail: OutboundMail): Promise<SendOutcome>;
}

const HDR_BAD = /[\r\n\0]/;
/** 头部注入：To / Reply-To / Subject（以及线程头）含 CR / LF / NUL 一律拒绝，不做替换 */
export function headerInjection(mail: Pick<OutboundMail, 'to' | 'replyTo' | 'subject'> & Partial<OutboundMail>): string | null {
  for (const k of ['to', 'replyTo', 'subject', 'messageId', 'inReplyTo', 'references'] as const) {
    const v = mail[k];
    if (typeof v === 'string' && HDR_BAD.test(v)) return k;
  }
  return null;
}

/**
 * SMTP / 连接错误 → 只保留可公开的错误码（不带原始响应、命令参数、用户名或密码）。
 * 返回值只含 [A-Z0-9_.] 组成的短码，比如 "535"、"454"、"ECONNECTION"、"ETIMEDOUT"。
 */
export function smtpErrorCode(e: unknown): { responseCode: number | null; code: string | null; command: string | null } {
  const err = (e ?? {}) as { responseCode?: unknown; code?: unknown; command?: unknown };
  const rc = typeof err.responseCode === 'number' && err.responseCode >= 200 && err.responseCode <= 599 ? err.responseCode : null;
  const code = typeof err.code === 'string' ? err.code.replace(/[^A-Z0-9_]/gi, '').toUpperCase().slice(0, 24) || null : null;
  // command 只取动词（AUTH PLAIN 后面可能跟 base64 凭据），并且只认已知值
  const verb = typeof err.command === 'string' ? err.command.trim().split(/\s+/)[0].toUpperCase() : '';
  const command = ['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'API'].includes(verb) ? verb : null;
  return { responseCode: rc, code, command };
}

/** 日志 / 审计里出现的唯一错误表示：只有码 */
export function redactedError(e: unknown): string {
  const { responseCode, code } = smtpErrorCode(e);
  return responseCode ? String(responseCode) : code ?? 'unknown';
}

const TLS_CODES = new Set(['ETLS', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
const CONN_CODES = new Set(['ECONNECTION', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH']);

const PRE_DATA = new Set(['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL', 'RCPT']);

/**
 * SMTP 错误归类（§8.1 / §16 / §17 / 安全审查补充）。
 * 没有 SMTP 响应码的网络错误：只有能确定发生在 DATA 之前（连接 / 问候 / STARTTLS / AUTH / MAIL / RCPT，或连接类错误码）才算
 * send_unavailable（确定没发出、可重试）；其余一律 unknown_delivery（可能已送达，M5）。
 */
export function classifySmtpError(e: unknown): Extract<SendOutcome, { ok: false }> {
  const { responseCode: rc, code, command } = smtpErrorCode(e);
  const err = (e ?? {}) as { response?: unknown };
  const resp = typeof err.response === 'string' ? err.response : '';
  const codeStr = rc ? String(rc) : code;
  const out = (reason: SendFailReason, retryable: boolean, alert = false) => ({ ok: false as const, reason, retryable, code: codeStr, alert });
  // 535 等认证失败是配置问题，不是限流 → 不可重试 + 运维告警
  if (rc === 535 || rc === 534 || rc === 530 || (code === 'EAUTH' && (rc === null || rc >= 500))) return out('send_auth', false, true);
  // Gmail 每日配额（550 5.4.5 Daily user sending limit exceeded）：按限流处理并告警
  if (rc === 550 && /\b5\.4\.5\b/.test(resp)) return out('provider_throttled', true, true);
  // 4xx 临时错误（421 服务不可用 / 454 临时认证失败或登录过多 / 450-452 等）：服务器明确没收下这封信 → 可重试
  if (rc !== null && rc >= 400 && rc < 500) return out('provider_throttled', true, rc === 454);
  if (code && TLS_CODES.has(code)) return out('smtp_tls', false, true);
  if (rc !== null && rc >= 500) return out(command === 'RCPT' ? 'recipient_rejected' : 'message_rejected', false);
  if ((code && CONN_CODES.has(code)) || (command && PRE_DATA.has(command))) return out('send_unavailable', true);
  return out('unknown_delivery', false);
}

const SAFE_KEYS = new Set(['mailId', 'reason', 'code', 'retryable', 'status', 'count', 'cap', 'kind', 'error']);
const SAFE_VAL = /^[A-Za-z0-9_.:-]{0,64}$/;
/**
 * 邮件模块唯一的日志出口：只输出白名单键，值必须是短的安全字符串 / 数字 / 布尔。
 * 不接受 Error 对象、原始响应、地址、主题、正文；凭据永远进不了日志。
 */
export function mailLog(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) {
  const safe: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!SAFE_KEYS.has(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
    else if (typeof v === 'string' && SAFE_VAL.test(v)) safe[k] = v;
    else safe[k] = 'redacted';
  }
  const ev = SAFE_VAL.test(event) ? event : 'mail.event';
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(`[mail] ${ev}`, JSON.stringify(safe));
}
