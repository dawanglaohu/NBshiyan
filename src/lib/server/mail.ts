import { headerSafe, renderAlert, renderEmail, safeGreetingName, type EmailVars } from './email/render';
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { hitRateLimit } from './security';
import { smtpBaseConfig } from './mail/config';
import { smtpTransportOptions, type CreateTransport } from './mail/smtp';
import { redactedError, mailLog } from './mail/adapter';

type Mail = { to: string; subject: string; html: string; text?: string; replyTo?: string };
/** sendMail 结果：sent 带 SMTP 返回的 Message-ID（可能为空）；SMTP 没配（开发环境）时 skipped */
export type SendMailResult = { sent: true; messageId: string | null } | { sent: false; skipped: 'mail_disabled' };

const EMAIL_RE = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+$/;
/** 收件人 / Reply-To：去掉 \r\n 和控制字符，再校验是单个地址 */
function addr(s: string) {
  const v = headerSafe(s);
  if (!EMAIL_RE.test(v)) throw new Error('bad_address');
  return v;
}

let transportFactory: CreateTransport | undefined;
/** 测试用：注入 mock SMTP 传输（不连网络） */
export function setMailTransportFactory(f: CreateTransport | undefined) { transportFactory = f; }

/**
 * 通过 SMTP（§16：免费 Gmail，nodemailer）发信：自动回复、业务通知、后台告警都走这里；询盘回复走 mail/send.ts（带每日上限和状态机）。
 * SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM 只从环境变量读；TLS 强制（465 或 587+STARTTLS），证书校验开启，nodemailer 日志关闭。
 * SMTP_* 都没配时只在控制台记录（开发环境）。失败抛 SmtpError，只带错误码（如 SMTP_535、SMTP_ECONNECTION），不带原始响应或凭据。
 */
export async function sendMail(m: Mail): Promise<SendMailResult> {
  const to = addr(m.to);
  const replyTo = m.replyTo ? addr(m.replyTo) : undefined;
  const subject = headerSafe(m.subject);
  const c = smtpBaseConfig();
  if (!c.ok) {
    // 开发环境：只记一行「已跳过」，不打印收件人和主题
    if (c.error === 'missing') { console.info('[mail:dev]', 'skipped: smtp not configured'); return { sent: false, skipped: 'mail_disabled' }; }
    throw Object.assign(new Error('smtp config invalid'), { name: 'SmtpError', code: `SMTP_CONFIG_${c.error.toUpperCase()}` });
  }
  const create = transportFactory ?? ((o: Parameters<CreateTransport>[0]) => nodemailer.createTransport(o));
  const t = create(smtpTransportOptions(c.cfg));
  try {
    const info = await t.sendMail({
      from: { name: c.cfg.from.name, address: c.cfg.from.address }, to, subject, html: m.html,
      ...(m.text ? { text: m.text } : {}), ...(replyTo ? { replyTo } : {}),
      disableFileAccess: true, disableUrlAccess: true,
    });
    const id = (info as { messageId?: unknown } | undefined)?.messageId;
    return { sent: true, messageId: typeof id === 'string' && id ? id : null };
  } catch (e) {
    throw Object.assign(new Error('smtp send failed'), { name: 'SmtpError', code: `SMTP_${redactedError(e)}` });
  } finally {
    (t as { close?: () => void }).close?.();
  }
}

/** 后台告警：发给 ADMIN_ALERT_EMAIL（没配则 INQUIRY_NOTIFY_EMAIL）。同类告警 30 分钟最多 1 封；告警自身失败只记日志，不再告警。 */
export async function sendAdminAlert(kind: string, lines: Record<string, string | number>, dedupeKey = kind) {
  const to = process.env.ADMIN_ALERT_EMAIL || process.env.INQUIRY_NOTIFY_EMAIL;
  if (!to) { console.error('[alert] no recipient', kind); return; }
  if (!(await hitRateLimit(`alert:${dedupeKey}`, 1, 30 * 60_000))) return;
  try { await sendMail({ to, ...renderAlert(kind, lines) }); } catch (e) { console.error('[alert] send failed', kind, (e as Error).message); }
}

/** 业务通知（中文），后台链接只用 SITE_URL + 内部 id，不带 token */
export function inquiryNotifyMail(v: EmailVars & { adminId: string; score: number }) {
  return renderEmail('inquiry-notify.zh', v);
}
/** 客户确认：询盘或样品申请，按语言。主题只含对外编号；不回显留言 */
export function customerAckMail(kind: 'inquiry' | 'sample', v: EmailVars) {
  // 客户邮件不带公司名；名字不合适时模板用通用问候（防止把攻击者填的链接发到别人邮箱）
  v = { ...v, company: undefined, name: safeGreetingName(v.name) ?? '' };
  return renderEmail(`${kind === 'sample' ? 'sample-ack' : 'inquiry-ack'}.${v.locale}`, v);
}

/** 询盘业务通知（发给销售）和客户自动确认信 */
export type NotificationType = 'notify' | 'auto_receipt';
/** 跳过原因分类（只有这几种固定值） */
export type NotificationSkip = 'mail_disabled' | 'no_recipient' | 'low_trust' | 'rate_limited' | 'already_sent_24h';
export type NotificationLog = { ref: string; type: NotificationType };

/** SMTP Message-ID 的 sha256 十六进制前 16 位：可以和发信商后台 / 收件箱里的原信头对账，日志里不出现原值 */
export const messageIdHash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 16);

/**
 * 每次通知信尝试一行结构化日志（运维排查 PJ-2610-JES8VU 这类「没有日志」的情况）：
 * `[mail] mail.notification {"inquiry":"PJ-2610-XXXXXX","type":"notify","ok":true,"msgIdHash":"…"}`
 * 只有询盘对外编号、类型、结果、Message-ID 哈希前缀、跳过原因、错误码；不记收件人、主题、正文、sendKey。
 */
export function logNotification(n: NotificationLog, r: { ok: true; messageId: string | null } | { ok: false; code: string } | { skipped: NotificationSkip }) {
  const base = { inquiry: n.ref, type: n.type };
  if ('skipped' in r) return mailLog('info', 'mail.notification', { ...base, ok: false, skipped: r.skipped });
  if (r.ok) return mailLog('info', 'mail.notification', { ...base, ok: true, msgIdHash: r.messageId ? messageIdHash(r.messageId) : 'none' });
  return mailLog('error', 'mail.notification', { ...base, ok: false, code: r.code });
}

/** 发信失败不影响主流程：记录日志并发后台告警。带 log 时每次尝试都写一行 mail.notification */
export async function sendSafely(label: string, m: Mail, log?: NotificationLog) {
  try {
    const r = await sendMail(m);
    if (log) logNotification(log, r.sent ? { ok: true, messageId: r.messageId } : { skipped: r.skipped });
    return r.sent;
  } catch (e) {
    console.error(`[mail] ${label} failed`, (e as Error).message);
    if (log) logNotification(log, { ok: false, code: errorSummary(e).错误码 });
    await sendAdminAlert('邮件发送失败', { 类型: label, ...errorSummary(e) }, `mail-fail:${label}`);
    return false;
  }
}

/** 告警里只放错误名和错误码，不放 message（可能含连接串、SQL、用户数据） */
export function errorSummary(e: unknown): Record<string, string> {
  const err = (e ?? {}) as { name?: unknown; code?: unknown };
  const clean = (v: unknown) => String(v).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'unknown';
  return { 错误类型: clean(typeof err.name === 'string' ? err.name : 'Error'), 错误码: err.code === undefined ? '无' : clean(err.code) };
}
