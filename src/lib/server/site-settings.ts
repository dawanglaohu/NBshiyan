import { unstable_cache } from 'next/cache';
import { prisma } from './db';
import { SITE_URL } from '@/lib/site';
import { PUBLISHED_LOCALES, isPublishedLocale, type PublishedLocale } from './published-locales';
import { errorSummary } from './admin/audit';
import {
  ABOUT_ENABLED_KEY, ABOUT_IMAGES_KEY, mediaUrl, parseStoredAboutImages, ORGANIZATION_FALLBACK_NAME, ORGANIZATION_KEY, ORG_TEXT_FIELDS, SITE_SETTINGS_TAG,
  aboutKey, parseStoredAbout, parseStoredEnabled, parseStoredOrganization,
} from './site-settings-model';
import { resolvePublishedAboutLocales } from '@/lib/site-settings/about-rules';

/**
 * #350 前台读取（server only，只在服务端组件 / route / sitemap 里 import）。
 * - 三个函数共用一份缓存（标签 `site-settings`，revalidate 60）：后台保存时 revalidateTag 立即失效，最迟约 1 分钟生效。
 * - 正文 bodyHtml 读出时再用 sanitizeAboutHtml 净化一次（不只依赖入库那次）；纯文本字段同样再清理一次。
 * - 「完整 / 已发布」只用 src/lib/site-settings/about-rules.ts 的 isAboutContentComplete / resolvePublishedAboutLocales：
 *   开关关闭、语言不在 PUBLISHED_LOCALES、内容缺失或不完整 → getAboutContent 返回 null。
 * - 读库失败按「关闭」处理并打日志（不带内容），页面走 404 而不是 500；失败结果不进缓存。
 * - images：`about.images`（PublicAsset，各语言共用的顺序和宽高快照）+ 该语言 imageMeta 里的 alt / 说明。
 *   缺 alt 的图片照样返回（alt 为空串），由 isAboutContentComplete 判为不完整 → 该语言不发布。w / h 是 lg 尺寸。
 */
export type AboutStat = { label: string; value: string };
export type AboutImage = { id: string; w: number; h: number; alt: string; caption: string; src: { sm: string; lg: string } };
export type AboutContent = {
  locale: PublishedLocale; title: string; summary: string; bodyHtml: string; // bodyHtml 已净化
  stats: AboutStat[]; images: AboutImage[];
  home: { title: string; intro: string };
  updatedAt: string;
};
/**
 * 只返回后台实际保存的值：没填的可选字段不出现在对象里。没有默认值（alternateName / description 的初始文案由 SEO 的
 * buildOrganizationJsonLd 补）。name 必填，后台没填时用站点名；url = SITE_URL。address 是单行纯文本。
 */
export type OrganizationSettings = {
  name: string; url: string; logo?: string; description?: string; sameAs: string[];
  alternateName?: string; legalName?: string; email?: string; telephone?: string; address?: string; foundingDate?: string;
};

type RawSettings = Record<string, unknown>;

export function organizationFrom(raw: unknown): OrganizationSettings {
  const s = parseStoredOrganization(raw);
  const out: OrganizationSettings = { name: s?.name ?? ORGANIZATION_FALLBACK_NAME, url: SITE_URL, sameAs: s ? [...s.sameAs] : [] };
  if (s) for (const f of ORG_TEXT_FIELDS) if (f !== 'name' && s[f]) out[f] = s[f];
  return out;
}

/** 纯逻辑（便于测试）：传入一个读取已缓存原始设置的函数 */
export function createSiteSettingsReader(load: () => Promise<RawSettings>) {
  const safeLoad = async (): Promise<RawSettings | null> => {
    try { return await load(); } catch (e) { console.error('[site-settings] read failed', { errorSummary: errorSummary(e) }); return null; }
  };
  /** 只做读取和再净化；完整与否、开关、已发布语言统一交给 about-rules.ts 判断 */
  const contentFrom = (raw: RawSettings, locale: PublishedLocale): AboutContent | null => {
    const s = parseStoredAbout(raw[aboutKey(locale)]);
    if (!s) return null;
    const images: AboutImage[] = parseStoredAboutImages(raw[ABOUT_IMAGES_KEY]).items.map((i) => ({
      id: i.id, w: i.lg.w, h: i.lg.h, alt: s.imageMeta[i.id]?.alt ?? '', caption: s.imageMeta[i.id]?.caption ?? '',
      src: { sm: mediaUrl(i.id, i.sm.w), lg: mediaUrl(i.id, i.lg.w) },
    }));
    return { locale, title: s.title, summary: s.summary, bodyHtml: s.bodyHtml, stats: s.stats, images, home: { ...s.home }, updatedAt: s.updatedAt };
  };
  const published = (raw: RawSettings, contents: Partial<Record<PublishedLocale, AboutContent | null>>) =>
    resolvePublishedAboutLocales({ enabled: parseStoredEnabled(raw[ABOUT_ENABLED_KEY]).enabled, contents });
  return {
    async getAboutContent(locale: PublishedLocale): Promise<AboutContent | null> {
      if (!isPublishedLocale(locale)) return null;
      const raw = await safeLoad();
      if (!raw) return null;
      const c = contentFrom(raw, locale);
      return published(raw, { [locale]: c }).includes(locale) ? c : null;
    },
    async getPublishedAboutLocales(): Promise<PublishedLocale[]> {
      const raw = await safeLoad();
      if (!raw) return [];
      return published(raw, Object.fromEntries(PUBLISHED_LOCALES.map((l) => [l, contentFrom(raw, l)])));
    },
    async getOrganizationSettings(): Promise<OrganizationSettings> {
      const raw = await safeLoad();
      return organizationFrom(raw?.[ORGANIZATION_KEY]);
    },
  };
}

/** 只读已发布语言的键 + 图片列表 + 组织信息：预留语言的草稿不会进前台缓存 */
export const PUBLIC_SETTING_KEYS = [ABOUT_ENABLED_KEY, ABOUT_IMAGES_KEY, ...PUBLISHED_LOCALES.map(aboutKey), ORGANIZATION_KEY];

const loadPublicSettingsCached = unstable_cache(
  async (): Promise<RawSettings> => {
    const rows = await prisma.siteSetting.findMany({ where: { key: { in: PUBLIC_SETTING_KEYS } } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  ['site-settings:public:v3'], { tags: [SITE_SETTINGS_TAG], revalidate: 60 },
);

const reader = createSiteSettingsReader(loadPublicSettingsCached);

export function getAboutContent(locale: PublishedLocale): Promise<AboutContent | null> { return reader.getAboutContent(locale); }
export function getPublishedAboutLocales(): Promise<PublishedLocale[]> { return reader.getPublishedAboutLocales(); }
export function getOrganizationSettings(): Promise<OrganizationSettings> { return reader.getOrganizationSettings(); }
