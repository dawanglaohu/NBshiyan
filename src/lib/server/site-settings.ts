// 仅限服务端使用（读 SiteSetting 表）。仓库没有 `server-only` 依赖，所以这里不 import，只靠目录约定 src/lib/server。
// TODO(后端接入): stub until backend PR —— 签名按后端在群里贴的版本（#350），函数体由后端 PR 替换。
// 完整性 / 已发布规则在后端的 src/lib/site-settings/about-rules.ts，这里不复制。
import type { PublishedLocale } from './published-locales';
import { SITE_URL } from '../site';

/** 三个读取函数共用的缓存标签；保存后刷新它和 sitemap，页面 revalidate 60 兜底 */
export const SITE_SETTINGS_CACHE_TAG = 'site-settings';

export type AboutStat = { label: string; value: string };
export type AboutImage = { id: string; w: number; h: number; alt: string; caption: string; src: { sm: string; lg: string } };
export type AboutContent = {
  locale: PublishedLocale;
  title: string;
  summary: string;
  /** 已经 sanitizeAboutHtml 净化过 */
  bodyHtml: string;
  stats: AboutStat[];
  images: AboutImage[];
  home: { title: string; intro: string };
  updatedAt: string;
};

export type OrganizationAddress = {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
};

/** 产能、面积、人数、认证、交期不在这里，也不能由代码补默认值 */
export type OrganizationSettings = {
  name: string;
  url: string;
  logo?: string;
  description?: string;
  sameAs: string[];
  alternateName?: string;
  legalName?: string;
  email?: string;
  telephone?: string;
  /** 后端还没定是一行文字还是分字段，两种都接受 */
  address?: string | OrganizationAddress;
  foundingDate?: string;
};

/** 开关关闭或该语言没有内容时返回 null */
export async function getAboutContent(locale: PublishedLocale): Promise<AboutContent | null> {
  void locale;
  return null; // TODO(后端接入)
}

export async function getPublishedAboutLocales(): Promise<PublishedLocale[]> {
  return []; // TODO(后端接入)
}

export async function getOrganizationSettings(): Promise<OrganizationSettings> {
  return { name: 'PackJoyU', url: SITE_URL, sameAs: [] }; // TODO(后端接入)
}
