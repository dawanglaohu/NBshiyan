import type { Metadata, MetadataRoute } from 'next';
import type { AboutContent, OrganizationSettings } from '../server/site-settings';
import { withXDefault } from './hreflang';
import { articleOgVersion } from './articleOg';
import { ogSafeText } from './og/articleOgLayout';
import { ORGANIZATION_DEFAULTS } from './organization-defaults';
import ogVersions from '../../data/og-versions.json';

// /[locale]/about 的 SEO 规则（#350）。全部是纯函数：数据由调用方从 site-settings 读好再传进来，这里不查库。
// - meta title = 标题；description = 摘要，没填就取正文纯文本前 160 字（spec §2）。
// - 显示中的语言由后端 getPublishedAboutLocales() 决定（规则在后端 about-rules.ts），这里只吃这个列表：
//   canonical / hreflang / sitemap 都只列这些语言；只有一种语言时不出 x-default。

export const ABOUT_PATH = '/about';
export const ABOUT_DESCRIPTION_MAX = 160;
const DEFAULT_LOCALE = 'en';
const OG_W = 1200;
const OG_H = 630;
const OG_LOCALE: Record<string, string> = { en: 'en_US', ru: 'ru_RU' };

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

export function aboutDescription(content: Pick<AboutContent, 'summary' | 'bodyHtml'>): string {
  const summary = content.summary?.replace(/\s+/g, ' ').trim();
  if (summary) return summary;
  return truncateCodePoints(htmlToPlainText(content.bodyHtml ?? ''), ABOUT_DESCRIPTION_MAX);
}

/** hreflang：只列显示中的语言；只有一种语言时不输出 x-default，多于一种时按 withXDefault（en 存在才有，指向 en） */
export function aboutLanguages(publishedLocales: readonly string[], origin: string): Record<string, string> {
  const langs: Record<string, string> = {};
  for (const l of publishedLocales) langs[l] = aboutUrl(origin, l);
  return publishedLocales.length > 1 ? withXDefault(langs, DEFAULT_LOCALE) : langs;
}

const OG_VERSIONS: Record<string, string> = ogVersions;
/** 首页通用分享图 /og/home-<locale>.jpg?v=…（与 pageMeta.ogImageUrl('home', locale) 同一地址，只是 origin 由参数传入） */
export function homeOgImageUrl(origin: string, locale: string): string {
  const file = OG_VERSIONS[`home-${locale}.jpg`] ? `home-${locale}.jpg` : `home-${DEFAULT_LOCALE}.jpg`;
  const v = OG_VERSIONS[file];
  return `${trimOrigin(origin)}/og/${file}${v ? `?v=${v}` : ''}`;
}

/**
 * about 分享图：沿用 #354 的文章 OG 模板（1200×630，标题 + 品牌），地址 /<locale>/about/og?v=<sha8>，
 * v 用 articleOgVersion（模板版本 + 语言 + 标题），标题改了社交平台会重新抓图。不用后台上传的照片。
 * 标题为空或没有字体能画的字符时返回 null，调用方用首页通用图（和文章页同一回退）。
 * 注意：对应的路由 src/app/[locale]/about/og/route.tsx 还不存在，接入 metadata 时要同一个 PR 加上。
 */
export function aboutOgImageUrl(origin: string, locale: 'en' | 'ru', title: string | null | undefined): string | null {
  const t = title?.trim();
  if (!t || !ogSafeText(t)) return null;
  return `${aboutUrl(origin, locale)}/og?v=${articleOgVersion(locale, t)}`;
}

export function buildAboutMetadata(opts: {
  locale: 'en' | 'ru';
  content: AboutContent | null;
  /** getPublishedAboutLocales() 的结果 */
  publishedLocales: readonly string[];
  origin: string;
  /** 回退到首页通用图时的 alt（调用方传 Meta.ogImageAlt）；不传就用标题 */
  fallbackOgAlt?: string;
}): Metadata {
  const { locale, content, origin } = opts;
  // 该语言不显示（页面会 404）：不写 canonical / hreflang，noindex
  if (!content || !opts.publishedLocales.includes(locale)) return { robots: { index: false, follow: false } };

  const title = content.title.trim();
  const description = aboutDescription(content);
  const url = aboutUrl(origin, locale);
  const own = aboutOgImageUrl(origin, locale, title);
  const image = own
    ? { url: own, width: OG_W, height: OG_H, alt: `${title} | PackJoyU` }
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

/** sitemap 条目：语言列表同 buildAboutMetadata；没有显示中的语言时返回 [] */
export function aboutSitemapEntries(opts: {
  publishedLocales: readonly string[];
  origin: string;
  /** 统一时间，或按语言取 AboutContent.updatedAt */
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
 * Organization JSON-LD（输入 = getOrganizationSettings() 的返回值）。
 * - @type 保持 Organization，@id = <origin>/#organization（WebSite.publisher 指向它）。
 * - alternateName / description 为空时用 ORGANIZATION_DEFAULTS；后台填了以后台为准。传入已套过默认值的设置，输出相同。
 * - 其他字段没填就不输出；logo 只收 https 或站内路径，sameAs 只收 https 并去重。
 * - 产能、面积、人数、认证、交期这类数字不在输入里，这里也绝不补。
 */
export function buildOrganizationJsonLd(settings: Partial<OrganizationSettings> | null | undefined, origin: string): Record<string, unknown> {
  const s = settings ?? {};
  const site = trimOrigin(origin);
  const settingsUrl = clean(s.url);
  const out: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${site}/#organization`,
    name: clean(s.name) ?? 'PackJoyU',
    url: settingsUrl && isHttps(settingsUrl) ? settingsUrl.replace(/\/+$/, '') : site,
    alternateName: clean(s.alternateName) ?? ORGANIZATION_DEFAULTS.alternateName,
    description: clean(s.description) ?? ORGANIZATION_DEFAULTS.description
  };
  const put = (k: string, v: unknown) => { if (v !== undefined) out[k] = v; };
  put('legalName', clean(s.legalName));
  put('logo', absUrl(clean(s.logo), site));
  const email = clean(s.email);
  put('email', email && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : undefined);
  put('telephone', clean(s.telephone));
  put('address', clean(s.address));
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
