import { TEMPLATES, type TemplateKey } from './templates.generated';
import type { PublishedLocale } from '@/i18n/published-locales';
import { SITE_URL } from '@/lib/site';
import { categoryMeta } from '@/lib/seo/categoryMeta';
import enMessages from '../../../../messages/en.json';
import ruMessages from '../../../../messages/ru.json';

export type EmailVars = {
  name: string; company?: string; product: string; quantity: string; inquiryId: string; locale: PublishedLocale;
  adminId?: string; score?: number;
};

const CTRL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
/** 文本版：去掉控制字符和双向控制符（保留 \t \n 以外的都去掉），并压成单行 */
export const cleanText = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(CTRL, '').trim();
export const escapeHtml = (s: string) => cleanText(s).replace(/[&<>"'`={}]/g, (c) => `&#${c.charCodeAt(0)};`);
/** 主题和 Reply-To：去掉 \r\n 和控制字符 */
export const headerSafe = (s: string) => cleanText(s).slice(0, 250);

/** CONTACT_REPLY_TIME 写小时数（如 24 或 24h，1–720）。未设置或无效时返回 null：邮件里不写回复时长（未确认的承诺不默认 24 小时） */
export function replyHours(v?: string): number | null {
  const m = /^(\d{1,3})\s*h?$/i.exec((v ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n <= 720 ? n : null;
}
/** 按语言写回复时间：en "24 hours"，ru "24 часа" */
export function replyTimeText(hours: number, locale: string) {
  if (locale === 'ru') {
    const m10 = hours % 10, m100 = hours % 100;
    const w = m10 === 1 && m100 !== 11 ? 'час' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'часа' : 'часов';
    return `${hours} ${w}`;
  }
  if (locale === 'zh') return `${hours} 小时`;
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** 站点配置：只来自环境变量，绝不取请求的 Host */
export function siteConfig() {
  const env = process.env;
  return {
    siteUrl: SITE_URL,
    replyHours: replyHours(env.CONTACT_REPLY_TIME),
    contactEmail: env.CONTACT_EMAIL?.trim() || '',
    whatsapp: env.CONTACT_WHATSAPP?.trim() || '',
  };
}

function fill(tpl: string, vals: Record<string, string>, flags: Record<string, boolean>, esc: (s: string) => string) {
  let s = tpl.replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, op: string, k: string, body: string) => ((op === '#') === !!flags[k] ? body : ''));
  // 单次替换：填入的值里即使含 {{x}} 也不会被再次展开
  s = s.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vals ? esc(vals[k]) : m));
  return s;
}

// 各种“点”的写法：. 。 ． ｡ [.] (.) {.} [dot] (dot) 以及前后空白，统一折成 "."
const DOTS = /\s*(?:\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\{\s*(?:\.|dot)\s*\}|\s(?:dot|точка)\s|[.。．｡])\s*/giu;
// 域名：标签至少 2 个字符（避免把 “J. Smith” 这类缩写当域名），支持任意文字（пример.рф）和 xn--
const LINKY = /(https?:|\/\/|www\.|@|xn--|(?<![\p{L}\p{N}-])[\p{L}\p{N}-]{2,}\.\p{L}{2,24}(?![\p{L}\p{N}]))/iu;
/** 名字是否像链接 / 域名 / 邮箱：先 NFKC（全角转半角、＠→@），再把各种点的写法折成 "." */
export function looksLinky(name: string): boolean {
  const n = name.replace(CTRL, '').normalize('NFKC').replace(DOTS, '.');
  return LINKY.test(n);
}
/** 客户邮件里的称呼：≤ 40 字且不像链接/域名/邮箱才用，否则返回 null（用通用问候） */
export function safeGreetingName(name: string): string | null {
  const n = cleanText(name);
  if (!n || n.length > 40 || looksLinky(n)) return null;
  return n;
}

export function renderEmail(key: TemplateKey, v: EmailVars) {
  const t = TEMPLATES[key];
  const cfg = siteConfig();
  const vals: Record<string, string> = {
    name: v.name, company: v.company || '—', product: v.product, quantity: v.quantity, inquiryId: v.inquiryId, locale: v.locale,
    adminId: v.adminId ?? '', score: v.score === undefined ? '' : String(v.score),
    siteUrl: cfg.siteUrl, replyTime: cfg.replyHours === null ? '' : replyTimeText(cfg.replyHours, key.endsWith('.ru') ? 'ru' : key.endsWith('.zh') ? 'zh' : 'en'), contactEmail: cfg.contactEmail, whatsapp: cfg.whatsapp,
  };
  const flags = { risk: v.score !== undefined && v.score < 40, contact: !!(cfg.contactEmail && cfg.whatsapp), named: safeGreetingName(v.name) !== null, reply: cfg.replyHours !== null };
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

/** 产品名：按 categoryMeta 的 key / 英文 slug / 去掉复数的 key 匹配，给当前语言的关键词；匹配不上就把 slug 转成可读文字 */
/** 不在 categoryMeta 里的卡片（已并入纸杯的 eco-paper-cups）：邮件里用卡片名 Products.names.<slug>，不把 slug（含 eco）原样露给客户 */
const CARD_SLUG: Record<string, string> = { 'eco-paper-cups': 'eco-paper-cups', 'eco-paper-cup': 'eco-paper-cups' };
const CARD_NAMES: Record<'en' | 'ru', Record<string, string>> = { en: enMessages.Products.names, ru: ruMessages.Products.names };
export function productName(slug: string, locale: PublishedLocale | 'zh') {
  // 只查自身属性，原型键（constructor / __proto__ / toString）不命中
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const names = CARD_NAMES[locale === 'ru' ? 'ru' : 'en'];
  const card = own(CARD_SLUG, slug) ? CARD_SLUG[slug] : undefined;
  if (card && own(names, card)) { const n = names[card]; if (typeof n === 'string' && n) return n; }
  const m = categoryMeta.find((c) => c.key === slug || c.en.slug === slug || c.key.replace(/s$/, '') === slug || c.key === `${slug}s` || c.key === `${slug}es`);
  const kw = m ? (locale === 'ru' ? m.ru.keyword : m.en.keyword) : null;
  const text = kw ?? slug.replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 产品、数量摘要：最多列 3 个产品，其余用 +N；数量按产品顺序，用 / 分隔。客户邮件按语言给产品名，内部通知用 slug */
export function summarizeItems(items: { productSlug: string; quantity?: number }[], locale?: PublishedLocale) {
  if (!items.length) return { product: '—', quantity: '—' };
  const shown = items.slice(0, 3);
  const more = items.length > 3 ? ` +${items.length - 3}` : '';
  const product = shown.map((i) => (locale ? productName(i.productSlug, locale) : i.productSlug)).join(', ') + more;
  // 数量按语言格式化：en 1,000；ru 1 000（ru-RU 的千位分隔是不换行空格，统一成普通空格便于纯文本显示）
  const fmt = new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US');
  const qs = shown.map((i) => (i.quantity ? fmt.format(i.quantity).replace(/[\u00a0\u202f]/g, ' ') : '—'));
  const quantity = qs.every((q) => q === '—') ? '—' : qs.join(' / ') + more;
  return { product, quantity };
}
