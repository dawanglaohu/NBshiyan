/**
 * 已发布语言的字面清单。没有其它 import，公开契约（src/lib/contracts）可以直接引用，
 * 不必带上 next-intl 或 Prisma。改发布清单只改这一处；src/i18n/published-locales.ts 再核对它仍是路由语言和数据库枚举的子集。
 */
export const PUBLISHED_LOCALES = ['en', 'ru'] as const;
export type PublishedLocale = (typeof PUBLISHED_LOCALES)[number];

export const isPublishedLocale = (v: unknown): v is PublishedLocale =>
  typeof v === 'string' && (PUBLISHED_LOCALES as readonly string[]).includes(v);
