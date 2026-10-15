import type { Product } from '@/data/products';

/** 与 /api/models 的条目同形（只取 3D 页用到的字段），这里不引 prisma，便于单测 */
export type CatalogModel = {
  productSlug: string; category: string; animated: boolean;
  slugs: { en: string; ru: string } | null; glbUrl: string; posterUrl: string | null;
};
export type Locale = 'en' | 'ru';
export type Catalog = { source: 'api' | 'fallback' | 'empty'; products: Product[] };

const PLACEHOLDER = '/images/placeholder.svg';
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 品类落地页地址。slugs 为 null 或 slug 不合法时返回 undefined：不显示链接，绝不拼出 /products/null */
export function landingFor(slugs: CatalogModel['slugs'], locale: Locale): string | undefined {
  const s = slugs?.[locale];
  return typeof s === 'string' && SAFE_SLUG.test(s) ? `/products/${s}` : undefined;
}

/** 接口模型 → 3D 页卡片。卡片 key 用内部 category（翻译和视图切换按它查），同一品类只取排序最前的一个 */
export function modelsToProducts(models: CatalogModel[], locale: Locale, fallback: readonly Product[]): Product[] {
  const byKey = new Map(fallback.map((p) => [p.slug, p]));
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const m of models) {
    const key = SAFE_SLUG.test(m.category) ? m.category : SAFE_SLUG.test(m.productSlug) ? m.productSlug : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const local = byKey.get(key);
    out.push({
      slug: key,
      model: m.glbUrl,
      poster: m.posterUrl ?? local?.poster ?? PLACEHOLDER,
      animated: m.animated,
      ...(m.animated ? { animationClips: { open: 'Open' } } : {}),
      landing: landingFor(m.slugs, locale),
    });
  }
  return out;
}

/**
 * 读取失败（数据库未配置、连接出错等）回退到本地 src/data/products.ts。
 * 成功但没有已上架模型：默认也用本地目录（上线初期后台还没上架模型，页面不能空）；
 * strictEmpty=true（环境变量 CATALOG_STRICT_API=1）时显示空状态。本地目录本身为空时同样显示空状态。
 */
export async function loadCatalog(load: () => Promise<CatalogModel[]>, locale: Locale, fallback: readonly Product[], opts: { strictEmpty?: boolean } = {}): Promise<Catalog> {
  try {
    const models = await load();
    const products = modelsToProducts(models, locale, fallback);
    if (products.length) return { source: 'api', products };
    if (!opts.strictEmpty && fallback.length) return { source: 'fallback', products: [...fallback] };
    return { source: 'empty', products: [] };
  } catch (err) {
    console.error('[products] model list unavailable, using local fallback:', err instanceof Error ? err.name : 'error');
    return { source: 'fallback', products: [...fallback] };
  }
}
