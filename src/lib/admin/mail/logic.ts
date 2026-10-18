// #74 邮件界面的纯逻辑与文案（不依赖 DOM / React，便于单测）。文案依据 ux-spec.md（A/B/C 节）与 backend-plan v4 §8、§15。
import type { MailError, SendStatus, ThreadItem, ThreadPage } from './types';
import { KNOWN_FLAGS } from './types';
import { futureTime } from '@/components/admin/format';

export const BODY_MAX = 20000;
export const BODY_WARN = 19000;
export const SUBJECT_MAX = 200;
export const MAX_RETRIES = 5;
export const POLL_MAX_MS = 2 * 60_000;
export const DEFAULT_POLL_MS = 5000;
export const NO_SUBJECT = '（无主题）';
export const DELETED = '内容已删除';
export const ADMIN_FALLBACK = '管理员';
export const UNVERIFIED = 'ⓘ 发件人未通过验证，请谨慎核对';
export const REMOTE_IMAGES = '已阻止外部图片（保护隐私，防止追踪）';
export const CID_PLACEHOLDER = '[内嵌图片未显示]';
export const MISMATCH = '实际网址与显示文字不同';
export const ANON_THREAD = '该询盘已匿名化，往来邮件内容已删除，不能再回复。';
export const SENDING_DISABLED = '发信功能尚未开通';
export const SENDING_DISABLED_HINT = '管理员开通发信后才能发送。可以先写好内容，用「复制正文」通过其他方式发给客户。';

// —— flags（8.4，未知 flag 不显示）——
export const FLAG_LABEL: Record<string, string> = { too_large: '超大邮件', auto: '自动回复', bounce: '退信', parse_error: '无法解析', attachment_rejected: '附件未保存' };
export const FLAG_HINT: Record<string, string> = {
  too_large: '邮件超过 25 MB，只保存了邮件头，正文和附件未保存。',
  auto: '对方系统自动发出的回信（如休假回复），不会提醒新邮件。',
  bounce: '邮件服务器的退信通知，通常表示我们发出的某封信没送达。第一期不自动对应原信；不计徽标、不提醒。',
  parse_error: '这封邮件格式异常，只保存了原始信息。仍可「归到询盘」或「忽略」。',
  attachment_rejected: '有附件因类型或大小不符合要求没有保存。'
};
export const knownFlags = (flags: readonly string[] | null | undefined) => (flags ?? []).filter((f) => (KNOWN_FLAGS as readonly string[]).includes(f));

// —— 气泡头 ——
/** 主题：redacted 不显示主题（返回 null）；正常信 null/空 → 「（无主题）」占位 */
export const subjectText = (m: { redacted: boolean; subject: string | null }) => (m.redacted ? null : m.subject?.trim() ? m.subject : NO_SUBJECT);
export const authorText = (m: Pick<ThreadItem, 'direction' | 'authorName' | 'from' | 'redacted'>) =>
  m.direction === 'OUTBOUND' ? (m.redacted ? ADMIN_FALLBACK : m.authorName ?? ADMIN_FALLBACK) : m.redacted ? null : m.from;
/** 只有 === false 才提示；null / 缺字段什么都不显示 */
export const showUnverified = (m: { senderVerified?: boolean | null; redacted?: boolean }) => !m.redacted && m.senderVerified === false;

// —— 发送失败原因（8.1 表；v3 smtp_* 旧码保留文案兼容）——
/** #74 UX：send_auth 只说「配置有误、已通知运维」，不显示服务端细节（最多显示错误码） */
export const SEND_AUTH_TEXT = '发信配置有误，已通知运维';
/** #74 UX：服务商限流是暂时的，用黄色提示（不是红色错误）：role=status，不打断读屏 */
const WARN_REASONS = new Set(['provider_throttled']);
const REASON: Record<string, { text: string; retryable: boolean }> = {
  send_unavailable: { text: '邮件服务暂时无法连接，这封信没有发出。内容已保存，可以重试。', retryable: true },
  provider_throttled: { text: '邮件服务暂时繁忙，请稍后重试', retryable: true },
  send_auth: { text: SEND_AUTH_TEXT, retryable: false },
  recipient_rejected: { text: '对方邮箱拒收，地址可能无效或已停用。请通过其他方式联系客户。', retryable: false },
  message_rejected: { text: '邮件内容被服务器拒收（可能被判为垃圾邮件）。请修改内容后重新发送。', retryable: false },
  smtp_timeout: { text: '连接邮件服务器超时。内容已保存，可以重试。', retryable: true },
  smtp_unavailable: { text: '邮件服务器暂时无法连接。内容已保存，可以重试。', retryable: true },
  smtp_auth: { text: SEND_AUTH_TEXT, retryable: false },
  smtp_tls: { text: '与邮件服务器的安全连接失败，请联系管理员。', retryable: false }
};
export const UNKNOWN_FAIL = '发送失败（未知原因）。请稍后重新编写发送；多次失败请联系管理员。';
export const MAYBE_DELIVERED = '可能已送达';
/** v4 §17 daily_cap_deferred：今日配额用完，后端在每日重置后自动发送。按排队中显示：不算失败、不计 n/5、没有重试，轮询不设 2 分钟上限 */
export const DEFERRED_REASON = 'daily_cap_deferred';
/** 下一个 UTC 零点（deferredUntil 缺失时的兜底） */
export const nextUtcMidnight = (now = Date.now()) => { const d = new Date(now); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString(); };
/** #74 UX：每日上限排队的状态标签 + 发送按钮下面的提示；预计时间按管理员本地时区 + 时区缩写（「10/18 00:00 PT」） */
export const QUEUED_TAG = '已排队';
export function deferredHint(until?: string | null, now = Date.now(), timeZone?: string): string {
  const t = until && !Number.isNaN(Date.parse(until)) ? until : nextUtcMidnight(now);
  return `今天发信已达上限，已排队，预计 ${futureTime(t, { now, timeZone })} 发出`;
}
export const isDeferred = (m: { status?: string; errorCode?: string | null }) => m.status !== 'SENT' && m.errorCode === DEFERRED_REASON;
export const MAYBE_DELIVERED_HINT = '发送过程中连接中断，无法确认对方是否收到。为免重复，系统不会自动重发；如需确认，请换其他方式联系客户。';
export const RETRY_LIMIT_HINT = '这封邮件已重试 5 次仍未发出。请复制内容重新编写发送，或联系管理员检查邮箱设置。';
export const NOT_RETRYABLE = '这封邮件不能重试，请重新编写发送。';
export const UNCONFIRMED = '状态未确认，请刷新页面查看。';
export const BACKGROUND_SENDING = '发送较慢，已转到后台继续发送（最多约 2 分钟），完成后这里会更新。';
export const ANON_JUST_NOW = '该询盘刚刚被匿名化，不能再发送。页面已刷新。';

export type OutboundView =
  | { kind: 'sending' } | { kind: 'sent'; at: string | null } | { kind: 'deferred' }
  | { kind: 'maybe_delivered' }
  | { kind: 'failed'; text: string; canRetry: boolean; retryLimit: boolean; retryCount: number; tone: 'warn' | 'error'; code: string | null };

/** 出站条目 / 8.3a 状态 → 界面状态。不认识的 reason 一律当 unknown：不可重试（忽略接口给的 retryable）。 */
export function outboundView(m: { status: SendStatus['status'] | 'RECEIVED' | 'QUEUED' } & Pick<SendStatus, 'errorCode' | 'retryable' | 'retryCount' | 'sentAt'> & { maxRetries?: number }): OutboundView {
  if (isDeferred(m)) return { kind: 'deferred' };
  if (m.status === 'SENDING' || m.status === 'QUEUED') return { kind: 'sending' };
  if (m.status === 'SENT' || m.status === 'RECEIVED') return { kind: 'sent', at: m.sentAt };
  if (m.errorCode === 'unknown_delivery') return { kind: 'maybe_delivered' };
  const r = m.errorCode ? REASON[m.errorCode] : undefined;
  const max = m.maxRetries ?? MAX_RETRIES;
  const retryableReason = !!r?.retryable && m.retryable;
  const retryLimit = retryableReason && m.retryCount >= max;
  const tone = !retryLimit && m.errorCode && WARN_REASONS.has(m.errorCode) ? 'warn' : 'error';
  return { kind: 'failed', text: r?.text ?? UNKNOWN_FAIL, canRetry: retryableReason && !retryLimit, retryLimit, retryCount: m.retryCount, tone, code: r ? m.errorCode : null };
}
/** 「已重试 n/5」：n≥1 才显示，n=4 加剩余次数 */
export function retryCountText(n: number, max = MAX_RETRIES): { text: string; last: boolean } | null {
  if (n < 1) return null;
  if (n === max - 1) return { text: `已重试 ${n}/${max} · 还能重试 1 次`, last: true };
  return { text: `已重试 ${Math.min(n, max)}/${max}`, last: false };
}

// —— 回复框 ——
export function bodyCounter(len: number): { text: string; level: 'ok' | 'near' | 'over' } {
  if (len > BODY_MAX) return { text: `${len} / ${BODY_MAX} · 已超出 ${len - BODY_MAX} 字`, level: 'over' };
  if (len >= BODY_WARN) return { text: `${len} / ${BODY_MAX} · 接近上限`, level: 'near' };
  return { text: `${len} / ${BODY_MAX}`, level: 'ok' };
}
/** 主题换行替换为空格 */
export const oneLineSubject = (s: string) => s.replace(/[\r\n]+/g, ' ');
/** 默认回复主题：无主题时留空（提示必填），不带入「Re: （无主题）」 */
export function replySubject(subject: string | null | undefined): string {
  const s = subject?.trim();
  if (!s) return '';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
/** 400 invalid 的逐字段文案；未知字段 / 未知码 → null（显示在表单顶部通用文案） */
export function invalidFieldText(field: string, code: string, limits?: Record<string, number>): string | null {
  const name = field === 'subject' ? '主题' : field === 'body' ? '正文' : null;
  if (!name) return null;
  switch (code) {
    case 'required': return `请填写${name}`;
    case 'too_long': return `${name}不能超过 ${limits?.[field] ?? (field === 'subject' ? SUBJECT_MAX : BODY_MAX)} 字`;
    case 'too_short': return `${name}太短`;
    case 'newline': return field === 'subject' ? '主题不能换行' : null;
    default: return null;
  }
}
export const FORM_UNKNOWN = '内容格式有误（未知），请刷新后重试';

/** 发信 / 重试失败 → 回复框里的提示。返回 null 表示由调用方单独处理（invalid 按字段、rate_limited 倒计时）。 */
export function sendErrorText(e: Pick<MailError, 'code' | 'body'>): { text: string; tone: 'neutral' | 'error'; at: 'form' | 'body' } | null {
  switch (e.code) {
    case 'invalid': case 'rate_limited': return null;
    case 'too_large':
      return e.body.field === 'body'
        ? { text: `正文不能超过 ${e.body.limit ?? BODY_MAX} 字`, tone: 'error', at: 'body' }
        : { text: `内容过大（上限 ${Math.floor((e.body.limit ?? 51200) / 1024)} KB），请删减后再发`, tone: 'error', at: 'form' };
    case 'anonymized': return { text: ANON_JUST_NOW, tone: 'neutral', at: 'form' };
    case 'sending_disabled': return { text: `${SENDING_DISABLED}。${SENDING_DISABLED_HINT}`, tone: 'neutral', at: 'form' };
    case 'retry_limit': return { text: RETRY_LIMIT_HINT, tone: 'error', at: 'form' };
    case 'not_retryable': return { text: NOT_RETRYABLE, tone: 'error', at: 'form' };
    case 'mail_not_configured': return { text: '发送失败：邮箱功能还没配置好，请联系管理员。', tone: 'error', at: 'form' };
    case 'rate_limiter_unavailable': return { text: '发送失败：发信限流服务暂时不可用，为安全起见暂停发送，请稍后再试。', tone: 'error', at: 'form' };
    case 'unauthorized': return { text: '登录已过期，请重新登录。', tone: 'error', at: 'form' };
    case 'forbidden_origin': return { text: '请求被拒绝：来源校验失败，请刷新页面后重试。', tone: 'error', at: 'form' };
    case 'not_found': return { text: '询盘不存在，或不在你的权限范围内。', tone: 'error', at: 'form' };
    default: return { text: `发送失败：${UNKNOWN_FAIL}`, tone: 'error', at: 'form' };
  }
}

// —— 限流（429，windowSec 固定 3600 → 「本小时」）——
export const fmtCountdown = (sec: number) => { const s = Math.max(0, Math.ceil(sec)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
/** kept：回复框里现在确实有内容才说「内容已保留在输入框里」（#340：不能在空输入框旁边说已保留） */
export function rateLimitText(scope: string | undefined, limit: number | undefined, countdown: string, kept = true): string {
  if (scope === 'global') return `全站本小时的发信量已达上限（${limit ?? '—'} 封），为保护域名信誉暂停发送。${countdown} 后可以再发。`;
  return `你本小时已发 ${limit ?? '—'} 封，达到上限。${countdown} 后可以再发。${kept ? DRAFT_KEPT : ''}`;
}
export const DRAFT_KEPT = '内容已保留在输入框里。';

/**
 * #340 UX 定稿：重试卡片上的 429。重试卡片没有输入框（服务端按已存的原文重发），所以不说「内容已保留在输入框里」。
 * 时间按 #322 规则（futureTime：MM/DD HH:mm + 时区缩写，跨年补年份）；向上取整到分钟，免得显示的时间早于真正可重试的时间。
 */
export function retryRateText(until: number, now = Date.now(), timeZone?: string): string {
  const at = futureTime(new Date(Math.ceil(until / 60_000) * 60_000).toISOString(), { now, timeZone }) ?? '稍后';
  return `发送太频繁，${at} 后可重试；重试会重新发送原邮件，无需重填。`;
}

/** #340 UX：往来邮件加载失败（404 以外的任何错误）时的错误条 */
export const THREAD_LOAD_FAILED = '邮件记录加载失败';

/**
 * #340：后端这一轮会返回 source:'legacy' 的旧记录、内容为空的 redacted 行，字段可能缺省。
 * 统一补默认值，组件里不用到处判断（不改接口调用，只整理返回的数据）。
 */
type WireItem = Partial<ThreadItem> & { id: string };
export function normalizeThread(raw: { anonymizedAt?: string | null; items?: WireItem[] | null; nextCursor?: string | null; linksExpireAt?: string | null }): ThreadPage {
  return {
    anonymizedAt: raw.anonymizedAt ?? null,
    nextCursor: raw.nextCursor ?? null,
    ...(raw.linksExpireAt !== undefined ? { linksExpireAt: raw.linksExpireAt } : {}),
    items: (raw.items ?? []).map((m) => ({
      direction: 'INBOUND', status: m.direction === 'OUTBOUND' ? 'SENT' : 'RECEIVED', deliveryStatus: 'unknown', bouncedAt: null, retryCount: 0, maxRetries: 5,
      from: null, to: null, authorName: null, subject: null, bodyHtml: null, bodyText: null, hasRemoteImages: false, senderVerified: null,
      errorCode: null, retryable: false, createdAt: m.receivedAt ?? m.sentAt ?? new Date(0).toISOString(), sentAt: null, receivedAt: null,
      ...m,
      source: m.source === 'legacy' ? 'legacy' : 'mail',
      redacted: m.redacted === true,
      flags: Array.isArray(m.flags) ? m.flags : [],
      attachments: Array.isArray(m.attachments) ? m.attachments : []
    }) as ThreadItem)
  };
}

/**
 * #340：发信失败后回复框的主题 / 正文怎么处理（纯函数）。
 * 只有服务端已经接受（201 / 202，或 502 mail_failed 但已排队 daily_cap_deferred）才清空；
 * 其他一切失败（429、provider_throttled 等 mail_failed、409、5xx、网络错误……）都保留，并恢复成发送前的快照。
 */
export function draftAfterSendError(e: Pick<MailError, 'code' | 'body'>): 'keep' | 'clear' {
  return e.code === 'mail_failed' && e.body.reason === DEFERRED_REASON && !!e.body.id ? 'clear' : 'keep';
}

// —— 429 倒计时：按钮在 Retry-After 之前禁用，到点重新可用 ——
type Clock = { now: () => number; setInterval: (f: () => void, ms: number) => unknown; clearInterval: (t: never) => void };
const realClock: Clock = { now: () => Date.now(), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) };
export const secondsLeft = (until: number | undefined, now: number) => (until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0);
/** 每秒回调剩余秒数，到 0 回调一次 0 并停止；返回停止函数 */
export function startCountdown(until: number, onTick: (left: number) => void, clock: Clock = realClock): () => void {
  let t: unknown;
  const stop = () => { if (t !== undefined) { clock.clearInterval(t as never); t = undefined; } };
  const tick = () => { const left = secondsLeft(until, clock.now()); onTick(left); if (left <= 0) stop(); };
  tick();
  if (secondsLeft(until, clock.now()) > 0) t = clock.setInterval(tick, 1000);
  return stop;
}
/** 失败卡片上的「重试」按钮：能重试才显示；限流倒计时中、正在重试、发信未开通时禁用 */
export function retryButton(o: { canRetry: boolean; rateLeft: number; retrying: boolean; canSend: boolean }): { show: boolean; disabled: boolean } {
  return { show: o.canRetry, disabled: o.rateLeft > 0 || o.retrying || !o.canSend };
}

// —— 未归类 ——
export const badgeText = (n: number | undefined) => (!n || n < 1 ? null : n > 99 ? '99+' : String(n));
const DAY = 86_400_000;
export function expiresText(expiresAt: string, now = Date.now()): { text: string; soon: boolean } {
  const days = Math.ceil((new Date(expiresAt).getTime() - now) / DAY);
  if (days <= 0) return { text: '今天删除', soon: true };
  if (days === 1) return { text: '明天删除', soon: true };
  return { text: `还剩 ${days} 天删除`, soon: days <= 14 };
}
export const REF_RE = /^PJ-\d{4}-[0-9A-Z]{4,8}$/;
export const ASSIGN_HINT = '提示仅根据发件人推测，请核对后再归档';
export function assignErrorText(code: string, ref: string): string {
  switch (code) {
    case 'invalid': return '编号格式应为 PJ-2026-0001';
    case 'not_found': return `没有找到询盘 ${ref}，请检查编号。`;
    case 'anonymized': return `询盘 ${ref} 已匿名化，不能归档到它。`;
    case 'not_unassigned': return '这封信已被其他人处理，列表已刷新。';
    default: return '操作失败，请稍后再试。';
  }
}
export const ALREADY_HANDLED = '这封信已被其他人处理，列表已刷新。';

// —— 附件 ——
export const fmtSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
export const linkExpired = (expiresAt: string, now = Date.now()) => new Date(expiresAt).getTime() <= now;
const TYPE_BADGE: [RegExp, string][] = [[/pdf/, 'PDF'], [/postscript|illustrator/, 'AI'], [/spreadsheet|excel|csv/, 'XLSX'], [/wordprocessing|msword/, 'DOCX'], [/presentation|powerpoint/, 'PPTX'], [/zip/, 'ZIP'], [/svg/, 'SVG'], [/png/, 'PNG'], [/jpe?g/, 'JPG'], [/webp/, 'WEBP'], [/gif/, 'GIF'], [/text\/plain/, 'TXT']];
export const typeBadge = (t: string) => TYPE_BADGE.find(([re]) => re.test(t.toLowerCase()))?.[1] ?? 'FILE';

// —— 正文 iframe（§6 M2 方案 A）——
export const IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
export const SRCDOC_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * 把服务端净化后的 HTML 包成 srcdoc：
 * - `<img src="cid:…">` → 行内占位「[内嵌图片未显示]」（第 1 阶段不显示内嵌图）
 * - 剩余 `<img>`（外链已被服务端改成 data-remote-src）→ 去掉，外链只靠横幅说明
 * - `<a data-mismatch="1">` 后面紧跟「实际网址与显示文字不同」，title 为真实 URL
 * - 外层 CSP meta 只允许 data: 图片和内联样式，不允许脚本 / 外链
 * 这里只做展示层改写，不替代服务端净化。
 */
export function buildSrcdoc(html: string): string {
  let out = html.replace(/<img\b[^>]*>/gi, (tag) => (/\ssrc\s*=\s*["']?\s*cid:/i.test(tag) ? `<span class="cidph">${CID_PLACEHOLDER}</span>` : ''));
  out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs: string) => {
    if (!/\sdata-mismatch\s*=\s*["']?1["']?/i.test(` ${attrs}`)) return whole;
    const href = /\shref\s*=\s*"([^"]*)"/i.exec(` ${attrs}`)?.[1] ?? '';
    return `${whole}<span class="mm" title="${esc(href.replace(/&amp;/g, '&'))}">${MISMATCH}</span>`;
  });
  const style = 'body{margin:0;font:14px/1.6 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;color:#1C1C1C;overflow-wrap:anywhere}a{color:#C2381A}img{max-width:100%}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #E8E2D8;color:#5A5650}'
    + '.cidph,.mm{display:inline-block;background:#F3EFE8;border:1px solid #8A8378;color:#5A5650;font-size:13px;border-radius:6px;padding:0 8px;margin:0 4px}';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SRCDOC_CSP}"><meta name="referrer" content="no-referrer"><style>${style}</style></head><body>${out}</body></html>`;
}
/** iframe 没有 allow-same-origin 读不到内容高度：按纯文本行数估算，超出部分在 iframe 内滚动 */
export const FRAME_MIN = 240;
/** 最大高度 70vh（无窗口时按 900 计） */
export const frameMax = (vh = typeof window === 'undefined' ? 900 : window.innerHeight) => Math.round(vh * 0.7);
export const clampHeight = (h: number, max = frameMax()) => Math.max(FRAME_MIN, Math.min(Math.max(FRAME_MIN, max), Math.round(h)));
export function estimateHeight(text: string | null | undefined, max = frameMax()): number {
  const lines = (text ?? '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 70)), 0);
  return clampHeight(lines * 22 + 12, max);
}
/** 调整高度把手的键盘步长：↑/↓ 每次 40px，PageUp/PageDown 160px，Home/End 到最小/最大 */
export function resizeByKey(key: string, h: number, max = frameMax()): number | null {
  const step: Record<string, number> = { ArrowUp: -40, ArrowDown: 40, PageUp: -160, PageDown: 160 };
  if (key === 'Home') return FRAME_MIN;
  if (key === 'End') return clampHeight(max, max);
  return key in step ? clampHeight(h + step[key], max) : null;
}
