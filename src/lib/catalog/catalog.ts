import type { Product } from '@/data/products';
import { ProductSlugSchema } from '@/lib/contracts/common';
import { categoryMeta } from '@/lib/seo/categoryMeta';

/** 与 /api/models 的条目同形（只取 3D 页用到的字段），这里不引 prisma，便于单测 */
export type CatalogModel = {
  productSlug: string;
  category: string;
  /** 缺省时不算已上架。listPublishedModels 只返回已上架行，调用方用 withPublishedReady 补上这两项。 */
  published: boolean;
  status: string;
  animated: boolean;
  slugs: { en: string; ru: string } | null;
  glbUrl: string;
  posterUrl: string | null;
};
export type Locale = 'en' | 'ru';
export type Catalog = { source: 'api' | 'fallback' | 'empty'; products: Product[] };
export type CatalogCard = Product & { name: string; desc?: string; specs?: string[]; alt: string };

const PLACEHOLDER = '/images/placeholder.svg';
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * 私有存储不发公开源站地址（storage.ts）。模型与公开图片只走这两条站内路径，
 * 它们本身也是「单个 / 开头」的本站路径，渲染前和其它站内路径走同一套校验。
 */
export const CATALOG_STORAGE_PATH_PREFIXES = ['/api/models/', '/media/'] as const;

/** categoryMeta 的内部 key。3D 页额外品类和分析白名单共用这一份。 */
export const CATALOG_CATEGORY_KEYS: ReadonlySet<string> = new Set(categoryMeta.map((c) => c.key));

/**
 * 分析接口的 productSlug 规则（ProductSlugSchema）加上「必须在 categoryMeta」。
 * 3D 页把库里多出来的品类接进来、以及 publishedSlugs() 放行，都走这个函数。
 * products.ts 里已有的 key 不经过它：那些品类本来就在目录上。
 */
export function isListedCatalogKey(key: string, keys: ReadonlySet<string> = CATALOG_CATEGORY_KEYS): boolean {
  return ProductSlugSchema.safeParse(key).success && keys.has(key);
}

function isCatalogSlug(key: string): boolean {
  return ProductSlugSchema.safeParse(key).success;
}

/** 品类落地页地址。slugs 为 null 或 slug 不合法时返回 undefined：不显示链接，绝不拼出 /products/null */
export function landingFor(slugs: CatalogModel['slugs'], locale: Locale): string | undefined {
  const s = slugs?.[locale];
  return typeof s === 'string' && SAFE_SLUG.test(s) ? `/products/${s}` : undefined;
}

/**
 * 库里的 glb / 海报在进页面之前先过白名单。
 * 只留下单个 / 开头的站内路径（含 /api/models/ 与 /media/）。
 * javascript:、data:、协议相对 //、反斜杠、外部域名一律丢掉。
 */
export function catalogAssetUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length < 2 || raw.length > 2048) return undefined;
  if (raw !== raw.trim()) return undefined;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw[1] === '\\') return undefined;
  if (/[\s\\\u0000-\u001f\u007f]/.test(raw) || raw.includes('://') || raw.includes('#') || raw.includes('\\')) return undefined;
  const lower = raw.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:') || lower.startsWith('file:')) return undefined;
  const path = raw.split('?', 1)[0];
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return undefined; }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\') || decoded.includes('//')) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return undefined;
  if (decoded.split('/').some((part) => part === '.' || part === '..')) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded.slice(1))) return undefined;
  try {
    const url = new URL(raw, 'https://catalog.invalid');
    if (url.origin !== 'https://catalog.invalid' || url.username || url.password) return undefined;
  } catch { return undefined; }
  return raw;
}

function ready(model: CatalogModel): boolean {
  return model.published === true && model.status === 'READY';
}

/** 海报仍是 products.ts 那张时用逐图 alt；换成库里的海报后用 Products.alt 模板。结果不会是空字符串。 */
export function catalogPosterAlt(args: {
  slug: string;
  poster: string;
  local?: Product;
  locale: Locale;
  categoryName: string;
  fallbackAlt: string;
}): string {
  const name = args.categoryName.trim() || args.slug.replace(/-/g, ' ');
  const local = args.local;
  if (local?.posterAlt && local.poster === args.poster) {
    const specific = (args.locale === 'ru' ? local.posterAlt.ru : local.posterAlt.en).trim();
    if (specific) return specific;
  }
  const alt = args.fallbackAlt.trim();
  if (alt && name && alt.includes(name)) return alt;
  return args.locale === 'ru' ? `${name}: упаковка на заказ от PackJoyU` : `${name}: custom packaging by PackJoyU`;
}

export type CatalogText = {
  hasName: (slug: string) => boolean;
  name: (slug: string) => string;
  desc: (slug: string) => string;
  specs: (slug: string) => string[];
  alt: (name: string) => string;
};

/** 3D 页卡片文案。alt 与目录合并用同一套规则，页面和测试都走这里。 */
export function decorateCatalogProducts(rows: readonly Product[], locale: Locale, fallback: readonly Product[], text: CatalogText): CatalogCard[] {
  const locals = new Map(fallback.map((product) => [product.slug, product]));
  return rows.map((product) => {
    const known = text.hasName(product.slug);
    const name = known ? text.name(product.slug) : product.slug.replace(/-/g, ' ');
    return {
      ...product,
      name,
      desc: known ? text.desc(product.slug) : undefined,
      specs: known ? text.specs(product.slug) : undefined,
      alt: catalogPosterAlt({
        slug: product.slug,
        poster: product.poster,
        local: locals.get(product.slug),
        locale,
        categoryName: name,
        fallbackAlt: text.alt(name),
      }),
    };
  });
}

/** 产品页 ItemList。只收已经合并好的卡片，不在目录里的 key 不会进 JSON-LD。 */
export function catalogItemList(items: readonly { slug: string; name: string; desc?: string }[], pageUrl: string) {
  return items.map((item, index) => ({
    '@type': 'ListItem' as const,
    position: index + 1,
    name: item.name,
    description: item.desc,
    url: `${pageUrl}#${item.slug}`,
  }));
}

/** listPublishedModels 已经按 published + READY 过滤。补上标记后，合并函数才能和草稿行用同一套判断。 */
export function withPublishedReady<T extends Omit<CatalogModel, 'published' | 'status'>>(rows: readonly T[]): CatalogModel[] {
  return rows.map((row) => ({
    productSlug: row.productSlug,
    category: row.category,
    animated: row.animated,
    slugs: row.slugs,
    glbUrl: row.glbUrl,
    posterUrl: row.posterUrl,
    published: true,
    status: 'READY',
  }));
}

function cardFrom(local: Product | undefined, model: CatalogModel, key: string): Product | null {
  const glb = catalogAssetUrl(model.glbUrl);
  const posterGiven = model.posterUrl != null;
  const poster = posterGiven ? catalogAssetUrl(model.posterUrl) : undefined;
  if (!local) {
    if (!glb || (posterGiven && !poster)) return null;
    return { slug: key, model: glb, poster: poster ?? PLACEHOLDER };
  }
  const next: Product = {
    slug: local.slug,
    model: glb ?? local.model,
    poster: poster ?? local.poster,
  };
  if (local.animated) next.animated = local.animated;
  if (local.animationClips) next.animationClips = local.animationClips;
  if (local.landing) next.landing = local.landing;
  if (local.posterAlt && next.poster === local.poster) next.posterAlt = local.posterAlt;
  return next;
}

export type MergedCatalog = { products: Product[]; applied: boolean };

/**
 * 按 Model3D.category 逐条合并，不再因为库里有 1 条就把 products.ts 整表换成接口结果。
 * category 不合法时不替换、不显示，也不退回 productSlug。
 * 只有 published 且 READY 的行能替换。顺序沿 products.ts，原位替换；
 * 库里有、products.ts 没有、但 categoryMeta 有的 key 按模型列表的顺序接在最后。
 * 不在 categoryMeta 里的额外 key 整卡丢掉。
 * animated、animationClips、landing 沿用 products.ts 同 key 的值；没有同 key 时留空。
 * 不用库里的 animated，也不再合成 animationClips。
 */
export function mergeCatalog(models: readonly CatalogModel[], locale: Locale, fallback: readonly Product[], categoryKeys: ReadonlySet<string> = CATALOG_CATEGORY_KEYS): MergedCatalog {
  void locale;
  const locals = new Map(fallback.map((product) => [product.slug, product]));
  const replaced = new Map<string, Product>();
  const extras: Product[] = [];
  const seen = new Set<string>();
  let applied = false;
  for (const model of models) {
    if (!ready(model) || !isCatalogSlug(model.category) || seen.has(model.category)) continue;
    const local = locals.get(model.category);
    if (!local && !isListedCatalogKey(model.category, categoryKeys)) continue;
    seen.add(model.category);
    const card = cardFrom(local, model, model.category);
    if (!card) continue;
    applied = true;
    if (local) replaced.set(model.category, card);
    else extras.push(card);
  }
  return { products: [...fallback.map((product) => replaced.get(product.slug) ?? { ...product }), ...extras], applied };
}

/** 接口模型 → 3D 页卡片。同一 category 只取列表里最前的一条。 */
export function modelsToProducts(models: readonly CatalogModel[], locale: Locale, fallback: readonly Product[], categoryKeys?: ReadonlySet<string>): Product[] {
  return mergeCatalog(models, locale, fallback, categoryKeys).products;
}

/**
 * 读取失败（数据库未配置、连接出错等）回退到本地 src/data/products.ts。
 * 成功但没有可合并的已上架模型：默认也用本地目录；
 * strictEmpty=true（环境变量 CATALOG_STRICT_API=1）时显示空状态。本地目录本身为空时同样显示空状态。
 * 有可合并行时原位合并，其余品类仍在。
 */
export async function loadCatalog(load: () => Promise<CatalogModel[]>, locale: Locale, fallback: readonly Product[], opts: { strictEmpty?: boolean; categoryKeys?: ReadonlySet<string> } = {}): Promise<Catalog> {
  try {
    const merged = mergeCatalog(await load(), locale, fallback, opts.categoryKeys);
    if (merged.applied) return { source: 'api', products: merged.products };
    if (!opts.strictEmpty && fallback.length) return { source: 'fallback', products: [...fallback] };
    return { source: 'empty', products: [] };
  } catch (err) {
    console.error('[products] model list unavailable, using local fallback:', err instanceof Error ? err.name : 'error');
    return { source: 'fallback', products: [...fallback] };
  }
}

/**
 * 分析接口会接受的内部 key：products.ts 全部，再加上已上架且 READY、并且 isListedCatalogKey 为真的 category。
 * 不读 productSlug 列。和 mergeCatalog 的可见 key 用同一判定。
 */
export function acceptedCatalogSlugs(catalogSlugs: readonly string[], rows: readonly { category: string; published: boolean; status: string }[], categoryKeys: ReadonlySet<string> = CATALOG_CATEGORY_KEYS): Set<string> {
  const accepted = new Set(catalogSlugs);
  for (const row of rows) {
    if (row.published === true && row.status === 'READY' && isListedCatalogKey(row.category, categoryKeys)) accepted.add(row.category);
  }
  return accepted;
}
