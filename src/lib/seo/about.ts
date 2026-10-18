import type { Metadata, MetadataRoute } from 'next';
import type { AboutContent, AboutLocaleSetting, OrganizationSettings } from '../server/site-settings';
import { withXDefault } from './hreflang';
import ogVersions from '../../data/og-versions.json';

// /[locale]/about 的 SEO 规则（#350）。全部是纯函数：数据由调用方从 site-settings 读好再传进来，这里不查库。
// 规则和 spec §1 / §2 一致：meta title = 标题；description = 摘要，没填就取正文纯文本前 160 字；
// canonical 和 hreflang 只列出显示中的语言（开关开着 + 内容完整 + 已上线），sitemap 用同一套语言。

export const ABOUT_PATH = '/about';
export const ABOUT_DESCRIPTION_MAX = 160;
const DEFAULT_LOCALE = 'en';
const OG_LOCALE: Record<string, string> = {
  en: 'en_US', ru: 'ru_RU', es: 'es_ES', de: 'de_DE', fr: 'fr_FR', ja: 'ja_JP', hi: 'hi_IN', ar: 'ar_AR'
};
const OG_W = 1200;
const OG_H = 630;

const trimOrigin = (origin: string) => origin.replace(/\/+$/, '');
export const aboutUrl = (origin: string, locale: string) => `${trimOrigin(origin)}/${locale}${ABOUT_PATH}`;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** HTML → 纯文本：块级结束和 <br> 变空格，去掉标签，解常见实体，压缩空白 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/ul|\/ol)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k];
      if (k.startsWith('#x')) return safeCodePoint(parseInt(k.slice(2), 16)) ?? m;
      if (k.startsWith('#')) return safeCodePoint(parseInt(k.slice(1), 10)) ?? m;
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function safeCodePoint(n: number): string | undefined {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
}

/** 按码点截断（不会切开代理对），截断后去掉末尾空白 */
export function truncateCodePoints(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(0, max).join('').trimEnd();
}

export function aboutDescription(content: Pick<AboutLocaleSetting, 'summary' | 'bodyHtml'>): string {
  const summary = content.summary?.replace(/\s+/g, ' ').trim();
  if (summary) return summary;
  return truncateCodePoints(htmlToPlainText(content.bodyHtml ?? ''), ABOUT_DESCRIPTION_MAX);
}

/** spec §1「完成」：标题 2–80 字，正文纯文本 50–6000 字，已上传的图片都有 alt */
export function isAboutComplete(s: AboutLocaleSetting | null | undefined): boolean {
  if (!s) return false;
  const titleLen = Array.from(s.title?.trim() ?? '').length;
  const bodyLen = Array.from(htmlToPlainText(s.bodyHtml ?? '')).length;
  const altsOk = (s.images ?? []).every((i) => (i.alt ?? '').trim().length > 0);
  return titleLen >= 2 && titleLen <= 80 && bodyLen >= 50 && bodyLen <= 6000 && altsOk;
}

/**
 * 显示中的语言：开关开着 + 该语言内容完整 + 已上线，顺序跟 siteLocales（即 PUBLISHED_LOCALES / routing.locales）。
 * 后端的 getPublishedAboutLocales 可以直接复用这条规则。
 */
export function resolvePublishedAboutLocales<L extends string>(opts: {
  enabled: boolean;
  siteLocales: readonly L[];
  settings: Partial<Record<string, AboutLocaleSetting | null>>;
}): L[] {
  if (!opts.enabled) return [];
  return opts.siteLocales.filter((l) => isAboutComplete(opts.settings[l]));
}

/** hreflang：只列显示中的语言；只有一种语言时不输出 x-default，多于一种时按 withXDefault（en 存在才有，指向 en） */
export function aboutLanguages(publishedLocales: readonly string[], origin: string): Record<string, string> {
  const langs: Record<string, string> = {};
  for (const l of publishedLocales) langs[l] = aboutUrl(origin, l);
  return publishedLocales.length > 1 ? withXDefault(langs, DEFAULT_LOCALE) : langs;
}

const OG_VERSIONS: Record<string, string> = ogVersions;
/** 首页分享图（现有 /og/home-<locale>.jpg，没有该语言就用 en），带 ?v= 版本 */
export function homeOgImageUrl(origin: string, locale: string): string {
  const file = OG_VERSIONS[`home-${locale}.jpg`] ? `home-${locale}.jpg` : `home-${DEFAULT_LOCALE}.jpg`;
  const v = OG_VERSIONS[file];
  return `${trimOrigin(origin)}/og/${file}${v ? `?v=${v}` : ''}`;
}

/** 图片公开地址 `/media/<id>-<w>.webp`（#350 §7 答复 4），w 用后台记录的宽度 */
export const aboutImageUrl = (origin: string, img: { id: string; width: number }) =>
  `${trimOrigin(origin)}/media/${encodeURIComponent(img.id)}-${img.width}.webp`;

export function buildAboutMetadata(opts: {
  locale: string;
  content: AboutContent | null;
  publishedLocales: readonly string[];
  origin: string;
  /** 没有 about 图片时首页分享图的 alt（调用方传 Meta.ogImageAlt）；不传就用标题 */
  fallbackOgAlt?: string;
}): Metadata {
  const { locale, content, origin } = opts;
  // 该语言不显示（页面会 404）：不写 canonical / hreflang，noindex
  if (!content || !opts.publishedLocales.includes(locale)) return { robots: { index: false, follow: false } };

  const title = content.title.trim();
  const description = aboutDescription(content);
  const url = aboutUrl(origin, locale);
  const first = content.images?.[0];
  const image = first
    ? { url: aboutImageUrl(origin, first), width: first.width, height: first.height, alt: first.alt }
    : { url: homeOgImageUrl(origin, locale), width: OG_W, height: OG_H, alt: opts.fallbackOgAlt ?? title };
  const ogLocale = (l: string) => OG_LOCALE[l] ?? l;

  return {
    metadataBase: new URL(trimOrigin(origin)),
    title: { absolute: title },
    description,
    alternates: { canonical: url, languages: aboutLanguages(opts.publishedLocales, origin) },
    openGraph: {
      type: 'website',
      siteName: 'PackJoyU',
      url,
      title,
      description,
      locale: ogLocale(locale),
      alternateLocale: opts.publishedLocales.filter((l) => l !== locale).map(ogLocale),
      images: [image]
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] }
  };
}

/** sitemap 条目：规则同 buildAboutMetadata；没有显示中的语言时返回 [] */
export function aboutSitemapEntries(opts: {
  publishedLocales: readonly string[];
  origin: string;
  /** 统一时间，或按语言取 about.<locale> 的 updatedAt */
  lastModified?: Date | Partial<Record<string, Date | string | undefined>>;
}): MetadataRoute.Sitemap {
  if (opts.publishedLocales.length === 0) return [];
  const languages = aboutLanguages(opts.publishedLocales, opts.origin);
  const lmFor = (l: string): Date | undefined => {
    const lm = opts.lastModified;
    if (!lm) return undefined;
    if (lm instanceof Date) return lm;
    const v = lm[l];
    if (!v) return undefined;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  return opts.publishedLocales.map((l) => {
    const lastModified = lmFor(l);
    return {
      url: aboutUrl(opts.origin, l),
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: 'monthly' as const,
      priority: 0.5,
      alternates: { languages }
    };
  });
}

const clean = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const isHttps = (u: string) => {
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
};
/** https 绝对地址原样；以 / 开头（不是 // 或 /\）的站内路径补成绝对地址；其他丢弃 */
function absUrl(u: string | undefined, origin: string): string | undefined {
  if (!u) return undefined;
  if (isHttps(u)) return u;
  if (u.startsWith('/') && !u.startsWith('//') && !u.startsWith('/\\')) return `${trimOrigin(origin)}${u}`;
  return undefined;
}

/**
 * Organization JSON-LD：@type 保持 Organization，只输出后台填了的字段。
 * 没有任何字段时退回 { name: 'PackJoyU', url: origin }。
 * 产能、面积、人数、认证、交期这类数字不在输入里，这里也绝不补默认值。
 */
export function buildOrganizationJsonLd(settings: OrganizationSettings | null | undefined, origin: string): Record<string, unknown> {
  const s = settings ?? {};
  const site = trimOrigin(origin);
  const out: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${site}/#organization`,
    name: clean(s.name) ?? 'PackJoyU',
    url: site
  };
  const put = (k: string, v: unknown) => { if (v !== undefined) out[k] = v; };
  put('alternateName', clean(s.alternateName));
  put('legalName', clean(s.legalName));
  put('description', clean(s.description));
  put('logo', absUrl(clean(s.logo), site));
  const email = clean(s.email);
  put('email', email && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : undefined);
  put('telephone', clean(s.telephone));
  if (s.address) {
    const addr: Record<string, string> = {};
    for (const k of ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'] as const) {
      const v = clean(s.address[k]);
      if (v) addr[k] = v;
    }
    if (Object.keys(addr).length) out.address = { '@type': 'PostalAddress', ...addr };
  }
  const sameAs = [...new Set((s.sameAs ?? []).map(clean).filter((u): u is string => !!u && isHttps(u)))];
  if (sameAs.length) out.sameAs = sameAs;
  const fd = clean(s.foundingDate);
  put('foundingDate', fd && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(fd) ? fd : undefined);
  return out;
}

/** <script type="application/ld+json"> 的内容：'<' 转成 \u003c，防止提前闭合 script；U+2028/2029 也转义 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
