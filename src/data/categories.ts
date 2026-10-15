import { products, type Product } from './products';

/**
 * 已下线的品类（#195）：环保纸杯并入纸杯，slug `eco-paper-cups` / `ekologichnye-stakany` 删除。
 * products.ts 里的卡片由后端迁走；在那之前，导航、入口和卡片统一从这里过滤。
 */
export const RETIRED_CATEGORIES: ReadonlySet<string> = new Set(['eco-paper-cups']);

export const isActiveCategory = (slug: string) => !RETIRED_CATEGORIES.has(slug);

/** 前台展示用的品类列表（11 个） */
export const categoryProducts: readonly Product[] = products.filter((p) => isActiveCategory(p.slug));
