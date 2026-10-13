import { TEMPLATES, type TemplateKey } from './templates.generated';
import { SITE_URL } from '@/lib/site';

export type EmailVars = {
  name: string; company?: string; product: string; quantity: string; inquiryId: string; locale: 'en' | 'ru';
  adminId?: string; score?: number;
};

const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
/** 文本版：去掉控制字符和双向控制符（保留 \t \n 以外的都去掉），并压成单行 */
export const cleanText = (s: string) => s.replace(CTRL, '').replace(/[\r\n\t]+/g, ' ').trim();
export const escapeHtml = (s: string) => cleanText(s).replace(/[&<>"'`={}]/g, (c) => `&#${c.charCodeAt(0)};`);
/** 主题和 Reply-To：去掉 \r\n 和控制字符 */
export const headerSafe = (s: string) => cleanText(s).slice(0, 250);

/** 站点配置：只来自环境变量，绝不取请求的 Host */
export function siteConfig() {
  const env = process.env;
  return {
    siteUrl: SITE_URL,
    replyTime: env.CONTACT_REPLY_TIME?.trim() || '24h',
    contactEmail: env.CONTACT_EMAIL?.trim() || '',
    whatsapp: env.CONTACT_WHATSAPP?.trim() || '',
  };
}

function fill(tpl: string, vals: Record<string, string>, flags: Record<string, boolean>, esc: (s: string) => string) {
  let s = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k: string, body: string) => (flags[k] ? body : ''));
  // 单次替换：填入的值里即使含 {{x}} 也不会被再次展开
  s = s.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vals ? esc(vals[k]) : m));
  return s;
}

export function renderEmail(key: TemplateKey, v: EmailVars) {
  const t = TEMPLATES[key];
  const cfg = siteConfig();
  const vals: Record<string, string> = {
    name: v.name, company: v.company || '—', product: v.product, quantity: v.quantity, inquiryId: v.inquiryId, locale: v.locale,
    adminId: v.adminId ?? '', score: v.score === undefined ? '' : String(v.score),
    siteUrl: cfg.siteUrl, replyTime: cfg.replyTime, contactEmail: cfg.contactEmail, whatsapp: cfg.whatsapp,
  };
  const flags = { risk: v.score !== undefined && v.score < 40, contact: !!(cfg.contactEmail && cfg.whatsapp) };
  return {
    subject: headerSafe(fill(t.subject, vals, flags, cleanText)),
    html: fill(t.html, vals, flags, escapeHtml),
    text: fill(t.text, vals, flags, cleanText),
  };
}

/** 后台告警（中文，纯文本 + 简单 HTML），内容只有类型、时间和固定字段，不含用户输入 */
export function renderAlert(kind: string, lines: Record<string, string | number>) {
  const at = new Date().toISOString();
  const rows = Object.entries(lines).map(([k, val]) => [cleanText(k), cleanText(String(val))]);
  const text = [`PackJoyU 后台告警：${cleanText(kind)}`, `时间（UTC）：${at}`, ...rows.map(([k, val]) => `${k}：${val}`), '', `后台：${SITE_URL}/admin`].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1C1C1C"><h2 style="font-size:18px;margin:0 0 12px">后台告警：${escapeHtml(kind)}</h2><p style="margin:0 0 8px;color:#5A5650">时间（UTC）：${escapeHtml(at)}</p><table cellpadding="4">${rows.map(([k, val]) => `<tr><td style="color:#5A5650">${escapeHtml(k)}</td><td><b>${escapeHtml(val)}</b></td></tr>`).join('')}</table><p><a href="${escapeHtml(SITE_URL)}/admin">打开后台</a></p></div>`;
  return { subject: headerSafe(`[PackJoyU 告警] ${kind}`), html, text };
}

/** 产品、数量摘要：最多列 3 个产品，其余用 +N；数量按产品顺序，用 / 分隔 */
export function summarizeItems(items: { productSlug: string; quantity?: number }[]) {
  if (!items.length) return { product: '—', quantity: '—' };
  const shown = items.slice(0, 3);
  const more = items.length > 3 ? ` +${items.length - 3}` : '';
  const product = shown.map((i) => i.productSlug).join(', ') + more;
  const qs = shown.map((i) => (i.quantity ? i.quantity.toLocaleString('en-US') : '—'));
  const quantity = qs.every((q) => q === '—') ? '—' : qs.join(' / ') + more;
  return { product, quantity };
}
