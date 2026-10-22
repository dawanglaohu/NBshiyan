import type { Locale as DbLocale } from '@prisma/client';
import { routing } from './routing';

/**
 * 已对外发布的语言（唯一来源）。页面路由、sitemap、hreflang、IndexNow、og:locale:alternate、
 * generateStaticParams、语言切换下拉和公开接口的校验（src/lib/server/published-locales.ts re-export）都读这一份。
 * 不依赖 zod，可以在 middleware（edge）、客户端组件和服务端共用；Prisma 只用 import type，不进任何包。
 * 开放新语言：先加进 routing.locales（src/i18n/routing.ts），翻译和母语审核通过后再加进这里。
 */
export type AppLocale = (typeof routing.locales)[number];
export const PUBLISHED_LOCALES = ['en', 'ru'] as const satisfies readonly AppLocale[] & readonly DbLocale[];
export type PublishedLocale = (typeof PUBLISHED_LOCALES)[number];
export const DEFAULT_PUBLISHED_LOCALE: PublishedLocale = 'en';

export const isPublishedLocale = (v: unknown): v is PublishedLocale =>
  typeof v === 'string' && (PUBLISHED_LOCALES as readonly string[]).includes(v);
