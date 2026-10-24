// 仅限服务端使用。这一轮不加 server-only 依赖（#350 PM 定），改由 tests/about-client-guard.test.ts 守住：
// 任何 "use client" 文件直接（必须项）或间接（附加项）import 本文件，测试都会失败。
import crypto from 'node:crypto';
import type { Metadata, MetadataRoute } from 'next';
import type { AboutContent, OrganizationSettings } from '../server/site-settings';
import { withXDefault } from './hreflang';
import { ogSafeText } from './og/articleOgLayout';
import { ORGANIZATION_DEFAULTS } from './organization-defaults';
import { SITE_URL } from '../site';
import { ABOUT_LIMITS, aboutBodyText, countChars } from '../site-settings/about-rules';
import { ORG_EMAIL_RE, isValidFoundingDate, safeOrgUrl } from '../server/site-settings-model';
import ogVersions from '../../data/og-versions.json';

// /[locale]/about 的 SEO 规则（#350）。metadata / JSON-LD 不查库：数据由调用方读好再传进来。
// - meta title = 标题；description = 摘要，没填就取正文纯文本前 160 字（spec §2）。
// - 页面 canonical / hreflang 只列调用方传入的已显示语言；只有一种语言时页面不出 x-default。
// - sitemap 也只列 getAboutContent 非 null 的语言。x-default 按 hreflang.ts：en 在列表里就指向 en，只有 en 时也输出。

export const ABOUT_PATH = '/about';
/** = ABOUT_LIMITS.summaryMax（160，spec 字段限制） */
export const ABOUT_DESCRIPTION_MAX = ABOUT_LIMITS.summaryMax;
const DEFAULT_LOCALE = 'en';
const OG_W = 1200;
const OG_H = 630;
const OG_LOCALE: Record<string, string> = { en: 'en_US', ru: 'ru_RU' };

const trimOrigin = (origin: string) => origin.replace(/\/+$/, '');
export const aboutUrl = (origin: string, locale: string) => `${trimOrigin(origin)}/${locale}${ABOUT_PATH}`;

/**
 * meta description 用的纯文本：后端 about-rules.ts 的 aboutBodyText（和完整性计数同一份转换）再把换行、nbsp 等空白压成单个空格。
 * 字数按 Unicode code point（countChars），与后端一致。
 */
export const aboutPlainText = (bodyHtml: string): string => aboutBodyText(bodyHtml).replace(/\s+/g, ' ').trim();

/** 按码点截断（不会切开代理对），截断后去掉末尾空白 */
export function truncateCodePoints(text: string, max: number): string {
  return countChars(text) <= max ? text : [...text].slice(0, max).join('').trimEnd();
}

export function aboutDescription(content: Pick<AboutContent, 'summary' | 'bodyHtml'>): string {
  const summary = content.summary?.replace(/\s+/g, ' ').trim();
  if (summary) return summary;
  return truncateCodePoints(aboutPlainText(content.bodyHtml ?? ''), ABOUT_DESCRIPTION_MAX);
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

/** about 分享图模板版本：about 版去掉了文章模板的「Article」角标等改动时只改这里，不影响 articleOgVersion 和任何文章 OG 地址 */
export const ABOUT_OG_TEMPLATE_VERSION = 'about-1';

/**
 * about 分享图的 v：sha256(about 模板版本 + 语言 + 标题 + 角标) 前 8 位，和 articleOgVersion 同一种算法但版本号独立。
 * 角标 = 导航 About 的文案（i18n `Nav.about`，en「About」/ ru «О компании»），改了导航文案图片也会刷新。
 */
export function aboutOgVersion(locale: 'en' | 'ru', title: string, badge?: string): string {
  return crypto
    .createHash('sha256')
    .update(`${ABOUT_OG_TEMPLATE_VERSION}\n${locale}\n${title.trim()}\n${badge?.trim() ?? ''}`)
    .digest('hex')
    .slice(0, 8);
}

/**
 * about 分享图：基于 #354 的文章 OG 模板（1200×630，标题 + 品牌），地址 /<locale>/about/og?v=<sha8>，
 * v 用 aboutOgVersion（about 模板版本 + 语言 + 标题 + 角标），标题或导航文案改了社交平台会重新抓图。不用后台上传的照片。
 * 标题为空或没有字体能画的字符时返回 null，调用方用首页通用图（和文章页同一回退）。
 * 注意：对应的路由 src/app/[locale]/about/og/route.tsx 还不存在，接入 metadata 时要同一个 PR 加上。
 */
export function aboutOgImageUrl(origin: string, locale: 'en' | 'ru', title: string | null | undefined, badge?: string): string | null {
  const t = title?.trim();
  if (!t || !ogSafeText(t)) return null;
  return `${aboutUrl(origin, locale)}/og?v=${aboutOgVersion(locale, t, badge)}`;
}

export function buildAboutMetadata(opts: {
  locale: 'en' | 'ru';
  content: AboutContent | null;
  /** getPublishedAboutLocales() 的结果 */
  publishedLocales: readonly string[];
  origin: string;
  /** 分享图角标：传 t('Nav.about')，进 v 的哈希 */
  ogBadge?: string;
  /** 回退到首页通用图时的 alt（调用方传 Meta.ogImageAlt）；不传就用标题 */
  fallbackOgAlt?: string;
}): Metadata {
  const { locale, content, origin } = opts;
  // 该语言不显示（页面会 404）：不写 canonical / hreflang，noindex
  if (!content || !opts.publishedLocales.includes(locale)) return { robots: { index: false, follow: false } };

  const title = content.title.trim();
  const description = aboutDescription(content);
  const url = aboutUrl(origin, locale);
  const own = aboutOgImageUrl(origin, locale, title, opts.ogBadge);
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

/** sitemap <image:loc>。src.lg 是站内路径（/media/<id>-1600.webp）；绝对地址只用 origin，不用请求 Host。 */
function aboutSitemapImageUrl(origin: string, srcLg: string): string {
  if (/^https?:\/\//i.test(srcLg)) return srcLg;
  const base = trimOrigin(origin);
  return `${base}${srcLg.startsWith('/') ? srcLg : `/${srcLg}`}`;
}

/** sitemap 条目。没有语言时返回 []。x-default 仅在 en 在列表中时指向 en。 */
export function aboutSitemapEntries(opts: {
  publishedLocales: readonly string[];
  origin: string;
  /** 统一时间，或按语言取 AboutContent.updatedAt */
  lastModified?: Date | Partial<Record<string, Date | string | undefined>>;
  /** 按语言列出 AboutImage.src.lg。空则不写 images。 */
  imagePaths?: Partial<Record<string, readonly string[] | undefined>>;
}): MetadataRoute.Sitemap {
  if (opts.publishedLocales.length === 0) return [];
  const languages = withXDefault(
    Object.fromEntries(opts.publishedLocales.map((l) => [l, aboutUrl(opts.origin, l)])),
    DEFAULT_LOCALE
  );
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
    const images = (opts.imagePaths?.[l] ?? []).filter((p) => p.length > 0).map((p) => aboutSitemapImageUrl(opts.origin, p));
    return {
      url: aboutUrl(opts.origin, l),
      ...(lastModified ? { lastModified } : {}),
      ...(images.length ? { images } : {}),
      changeFrequency: 'monthly' as const,
      priority: 0.5,
      alternates: { languages }
    };
  });
}

/**
 * load 与页面同一条件：返回 null 的语言不收录。
 * 任一语言抛错则整段 /about 不输出，调用方已经生成的其他条目保持原样。
 */
export async function aboutSitemapFromLoader<L extends string>(opts: {
  locales: readonly L[];
  origin: string;
  load: (locale: L) => Promise<AboutContent | null>;
}): Promise<MetadataRoute.Sitemap> {
  try {
    const rows = await Promise.all(opts.locales.map(async (locale) => {
      const content = await opts.load(locale);
      return content ? { locale, content } : null;
    }));
    const published = rows.filter((row): row is { locale: L; content: AboutContent } => row != null);
    return aboutSitemapEntries({
      publishedLocales: published.map((row) => row.locale),
      origin: opts.origin,
      lastModified: Object.fromEntries(published.map((row) => [row.locale, row.content.updatedAt])),
      imagePaths: Object.fromEntries(published.map((row) => [row.locale, row.content.images.map((img) => img.src.lg)]))
    });
  } catch (e) {
    // 单测直接调用 sitemap() 时没有 Next 的 incremental cache，会抛这句。生产和 next build 里缓存存在。
    // 只记错误名，不记 message（可能含连接信息）。
    if (!(e instanceof Error) || !e.message.includes('incrementalCache missing')) {
      console.error('[sitemap] about entries skipped', e instanceof Error ? e.name : 'Error');
    }
    return [];
  }
}

const clean = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const isHttps = (u: string) => {
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
};
/** logo：用后端的 safeOrgUrl(raw, true)（与入库、读出同一校验，存进去的值不会在这里被丢掉）；站内路径补成绝对地址 */
function logoUrl(u: string | undefined, origin: string): string | undefined {
  const ok = u ? safeOrgUrl(u, true) : null;
  if (!ok) return undefined;
  return ok.startsWith('/') ? `${trimOrigin(origin)}${ok}` : ok;
}

/**
 * Organization JSON-LD（输入 = getOrganizationSettings() 的返回值）。
 * - @type 保持 Organization，@id = <origin>/#organization（WebSite.publisher 指向它）。origin 默认 SITE_URL（NEXT_PUBLIC_SITE_URL），
 *   与 OrganizationJsonLd.tsx 和后端 getOrganizationSettings().url 同一来源；只在测试里显式传别的值。
 * - alternateName / description 为空时用 ORGANIZATION_DEFAULTS；后台填了以后台为准。传入已套过默认值的设置，输出相同。
 * - 其他字段没填就不输出；email 用后端 ORG_EMAIL_RE，foundingDate 用后端 isValidFoundingDate，logo / sameAs 用后端 safeOrgUrl（site-settings-model.ts），sameAs 去重。
 * - 产能、面积、人数、认证、交期这类数字不在输入里，这里也绝不补。
 * - 只返回普通对象；输出到页面和 '<' 转义只由现有的 JsonLd.tsx / OrganizationJsonLd.tsx 负责（安全审要求）。
 */
export function buildOrganizationJsonLd(settings: Partial<OrganizationSettings> | null | undefined, origin: string = SITE_URL): Record<string, unknown> {
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
  put('logo', logoUrl(clean(s.logo), site));
  const email = clean(s.email);
  put('email', email && ORG_EMAIL_RE.test(email) ? email : undefined);
  put('telephone', clean(s.telephone));
  put('address', clean(s.address));
  const sameAs = [...new Set((s.sameAs ?? []).map((u) => (typeof u === 'string' ? safeOrgUrl(u) : null)).filter((u): u is string => !!u))];
  if (sameAs.length) out.sameAs = sameAs;
  const fd = clean(s.foundingDate);
  put('foundingDate', fd && isValidFoundingDate(fd) ? fd : undefined);
  return out;
}
