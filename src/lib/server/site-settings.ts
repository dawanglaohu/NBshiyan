import { unstable_cache } from 'next/cache';
import { prisma } from './db';
import { SITE_URL } from '@/lib/site';
import { PUBLISHED_LOCALES, isPublishedLocale, type PublishedLocale } from './published-locales';
import { errorSummary } from './admin/audit';
import { ABOUT_ENABLED_KEY, SITE_SETTINGS_TAG, aboutKey, isAboutComplete, parseStoredAbout, parseStoredEnabled } from './site-settings-model';

/**
 * #350 前台读取（server only，只在服务端组件 / route / sitemap 里 import）。
 * - 三个函数共用缓存标签 `site-settings`，revalidate 60：后台保存时 revalidateTag 立即失效，最迟约 1 分钟生效。
 * - 正文 bodyHtml 读出时再用 sanitizeAboutHtml 净化一次（不只依赖入库那次）；纯文本字段同样再清理一次。
 * - 只返回已发布语言（PUBLISHED_LOCALES）；开关关闭或该语言内容不完整（标题 ≥2 字 + 正文 ≥50 字）返回 null。
 * - 读库失败按「关闭」处理并打日志（不带内容），页面走 404 而不是 500；失败结果不进缓存。
 * - images 本 PR 固定 []，图片上传（PublicAsset）另开 PR。
 */
export type AboutStat = { label: string; value: string };
export type AboutImage = { id: string; w: number; h: number; alt: string; caption: string; src: { sm: string; lg: string } };
export type AboutContent = {
  locale: PublishedLocale; title: string; summary: string; bodyHtml: string; // bodyHtml 已净化
  stats: AboutStat[]; images: AboutImage[];
  home: { title: string; intro: string };
  updatedAt: string;
};
export type OrganizationSettings = { name: string; url: string; logo?: string; description?: string; sameAs: string[] };

/** 目前 Organization JSON-LD（components/seo/OrganizationJsonLd.tsx）写死的值；后台还没有对应设置，原样返回，不编任何数字 */
export const DEFAULT_ORGANIZATION: OrganizationSettings = {
  name: 'PackJoyU',
  url: SITE_URL,
  description: 'Custom packaging supplier: corrugated boxes, gift boxes, color boxes, molded pulp, paper cups and printing.',
  sameAs: [],
};

type RawSettings = Record<string, unknown>;

/** 纯逻辑（便于测试）：传入一个读取已缓存原始设置的函数 */
export function createSiteSettingsReader(load: () => Promise<RawSettings>, loadOrganization: () => Promise<OrganizationSettings> = async () => DEFAULT_ORGANIZATION) {
  const safeLoad = async (): Promise<RawSettings> => {
    try { return await load(); } catch (e) { console.error('[site-settings] read failed', { errorSummary: errorSummary(e) }); return {}; }
  };
  const contentFrom = (raw: RawSettings, locale: PublishedLocale): AboutContent | null => {
    if (!parseStoredEnabled(raw[ABOUT_ENABLED_KEY]).enabled) return null;
    const s = parseStoredAbout(raw[aboutKey(locale)]);
    if (!s || !isAboutComplete(s)) return null;
    return { locale, title: s.title, summary: s.summary, bodyHtml: s.bodyHtml, stats: s.stats, images: [], home: { ...s.home }, updatedAt: s.updatedAt };
  };
  return {
    async getAboutContent(locale: PublishedLocale): Promise<AboutContent | null> {
      if (!isPublishedLocale(locale)) return null;
      return contentFrom(await safeLoad(), locale);
    },
    async getPublishedAboutLocales(): Promise<PublishedLocale[]> {
      const raw = await safeLoad();
      return PUBLISHED_LOCALES.filter((l) => contentFrom(raw, l) !== null);
    },
    async getOrganizationSettings(): Promise<OrganizationSettings> {
      try { return await loadOrganization(); } catch (e) { console.error('[site-settings] organization read failed', { errorSummary: errorSummary(e) }); return DEFAULT_ORGANIZATION; }
    },
  };
}

/** 只读已发布语言的键：预留语言的草稿不会进前台缓存 */
export const PUBLIC_SETTING_KEYS = [ABOUT_ENABLED_KEY, ...PUBLISHED_LOCALES.map(aboutKey)];

const loadPublicSettingsCached = unstable_cache(
  async (): Promise<RawSettings> => {
    const rows = await prisma.siteSetting.findMany({ where: { key: { in: PUBLIC_SETTING_KEYS } } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  ['site-settings:public:v1'], { tags: [SITE_SETTINGS_TAG], revalidate: 60 },
);
const loadOrganizationCached = unstable_cache(
  async (): Promise<OrganizationSettings> => ({ ...DEFAULT_ORGANIZATION, sameAs: [...DEFAULT_ORGANIZATION.sameAs] }),
  ['site-settings:organization:v1'], { tags: [SITE_SETTINGS_TAG], revalidate: 60 },
);

const reader = createSiteSettingsReader(loadPublicSettingsCached, loadOrganizationCached);

export function getAboutContent(locale: PublishedLocale): Promise<AboutContent | null> { return reader.getAboutContent(locale); }
export function getPublishedAboutLocales(): Promise<PublishedLocale[]> { return reader.getPublishedAboutLocales(); }
export function getOrganizationSettings(): Promise<OrganizationSettings> { return reader.getOrganizationSettings(); }
