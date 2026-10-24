import type { Locale as DbLocale } from '@prisma/client';
import { routing } from './routing';
import {
  isPublishedLocale,
  PUBLISHED_LOCALES as PUBLISHED_LOCALE_LIST,
  type PublishedLocale,
} from './published-locale-list';

/**
 * 已对外发布的语言。字面清单在 published-locale-list.ts（无依赖，契约层也能引用）。
 * 页面路由、sitemap、hreflang、IndexNow、og:locale:alternate、
 * generateStaticParams、语言切换下拉和公开接口的校验（src/lib/server/published-locales.ts re-export）都读这一份。
 * 不依赖 zod，可以在 middleware（edge）、客户端组件和服务端共用；Prisma 只用 import type，不进任何包。
 * 开放新语言：先加进 routing.locales（src/i18n/routing.ts），翻译和母语审核通过后再改 published-locale-list.ts。
 */
export type AppLocale = (typeof routing.locales)[number];
export const PUBLISHED_LOCALES = PUBLISHED_LOCALE_LIST satisfies readonly AppLocale[] & readonly DbLocale[];
export type { PublishedLocale };
export const DEFAULT_PUBLISHED_LOCALE: PublishedLocale = 'en';
export { isPublishedLocale };
