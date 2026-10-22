import { z } from 'zod';
import type { Locale } from '@prisma/client';
import { PUBLISHED_LOCALES, DEFAULT_PUBLISHED_LOCALE, isPublishedLocale, type PublishedLocale } from '@/i18n/published-locales';

/**
 * 已对外发布的语言：公开接口（询盘、定制方案、品类规格）只接受这里列出的值。
 * 清单本身只有一份，在 src/i18n/published-locales.ts（前后端共用，不依赖 zod）；这里只 re-export，再加服务端用的 zod 校验。
 * Prisma `enum Locale` 已为多语言第 0 期预留 es/de/fr/ja/hi/ar，但预留 ≠ 发布：
 * 未发布语言一律按参数错误返回 400，不能因为 DB 枚举里有就放行。
 */
export { PUBLISHED_LOCALES, DEFAULT_PUBLISHED_LOCALE, isPublishedLocale };
export type { PublishedLocale };

/** zod 校验用：只接受已发布语言 */
export const PublishedLocaleSchema = z.enum(PUBLISHED_LOCALES);

/** 从 DB 读出的 Locale（可能是预留值）收窄到已发布语言；未发布的回落到默认语言，用于拼链接等展示场景 */
export const toPublishedLocale = (v: Locale | string | null | undefined): PublishedLocale =>
  isPublishedLocale(v) ? v : DEFAULT_PUBLISHED_LOCALE;
