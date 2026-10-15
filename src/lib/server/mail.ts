import { headerSafe, renderAlert, renderEmail, safeGreetingName, type EmailVars } from './email/render';
import { hitRateLimit } from './security';

const RESEND_URL = 'https://api.resend.com/emails';
type Mail = { to: string; subject: string; html: string; text?: string; replyTo?: string };

const EMAIL_RE = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+$/;
/** 收件人 / Reply-To：去掉 \r\n 和控制字符，再校验是单个地址 */
function addr(s: string) {
  const v = headerSafe(s);
  if (!EMAIL_RE.test(v)) throw new Error('bad_address');
  return v;
}

/**
 * 通过 Resend 发信。RESEND_API_KEY 只从环境变量读（建议在 Resend 后台建 sending-only 权限的 key），只发给固定的 Resend 地址。
 * 没配 key 时只在控制台记录（开发环境）。失败抛错，调用方决定是否吞掉。
 */
export async function sendMail(m: Mail) {
  const key = process.env.RESEND_API_KEY;
  const to = addr(m.to);
  const replyTo = m.replyTo ? addr(m.replyTo) : undefined;
  const subject = headerSafe(m.subject);
  if (!key) { console.info('[mail:dev]', to, subject); return; }
  const r = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM ?? 'PackJoyU <onboarding@resend.dev>', to, subject, html: m.html, ...(m.text ? { text: m.text } : {}), ...(replyTo ? { reply_to: replyTo } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw Object.assign(new Error(`resend ${r.status}`), { name: 'ResendError', code: `RESEND_${r.status}` });
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

/** 发信失败不影响主流程：记录日志并发后台告警 */
export async function sendSafely(label: string, m: Mail) {
  try { await sendMail(m); return true; } catch (e) {
    console.error(`[mail] ${label} failed`, (e as Error).message);
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
