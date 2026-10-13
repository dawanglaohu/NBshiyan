import { categoryMeta } from './categoryMeta';

export type CategorySlugs = { en: string; ru: string };

const BY_KEY = new Map<string, CategorySlugs>(categoryMeta.map((c) => [c.key, { en: c.en.slug, ru: c.ru.slug }]));

/** 按内部分类 key 取各语言 slug；未知 key 返回 null（前端回退到 key）。ru slug 仍是草稿。 */
export function categorySlugs(key: string): CategorySlugs | null {
  return BY_KEY.get(key) ?? null;
}
