// #108 行业方案：/solutions/[slug] 只接受本列表里的 slug。页面上的 {industry} 一律取列表项的本地化名称（Products.names），
// 绝不使用 URL 里的原始 slug（全栈安全要求）。名称与海报沿用现有产品类目，不新增说法。
export type Industry = { slug: string; premium: boolean; poster: string };

export const INDUSTRIES: readonly Industry[] = [
  { slug: 'color-boxes', premium: false, poster: '/images/posters/custom-color-boxes.webp' },
  { slug: 'corrugated-boxes', premium: false, poster: '/images/posters/custom-corrugated-boxes.webp' },
  { slug: 'paper-cups', premium: false, poster: '/images/posters/custom-paper-cups.webp' },
  { slug: 'party-supplies', premium: false, poster: '/images/posters/custom-party-supplies.webp' },
  { slug: 'wine-boxes', premium: true, poster: '/images/posters/custom-wine-boxes.webp' },
  { slug: 'gift-boxes', premium: true, poster: '/images/posters/custom-gift-boxes.webp' }
];

export type ResolvedIndustry = Industry & { name: string; title?: string };
type Names = Readonly<Record<string, string>> | undefined;
type IndustryCopy = Readonly<Record<string, { name?: string; title?: string }>> | undefined;
const own = <T,>(m: Readonly<Record<string, T>> | undefined, k: string): T | undefined => (m && Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * {industry} 优先取 Solutions.industries.<slug>.name（SEO），H1 用 .title；没有时回退 Products.names.<slug>。
 * 未知 slug 或没有任何名称 → null（调用方 notFound()）。
 */
export function resolveIndustry(slug: string, fallback: Names, preferred?: IndustryCopy): ResolvedIndustry | null {
  const hit = INDUSTRIES.find((i) => i.slug === slug);
  if (!hit) return null;
  const copy = own(preferred, hit.slug);
  const name = str(copy?.name) ?? str(own(fallback, hit.slug));
  return name ? { ...hit, name, title: str(copy?.title) } : null;
}

export const industryParams = () => INDUSTRIES.map((i) => ({ slug: i.slug }));

/** 页面侧：从 next-intl messages 取名称来源 */
export type IndustryMessages = { Products?: { names?: Record<string, string> }; Solutions?: { industries?: Record<string, { name?: string; title?: string }> } };
export const resolveFromMessages = (slug: string, m: IndustryMessages) => resolveIndustry(slug, m.Products?.names, m.Solutions?.industries);
export const resolvedIndustries = (m: IndustryMessages) => INDUSTRIES.map((i) => resolveFromMessages(i.slug, m)).filter((x): x is ResolvedIndustry => x !== null);
/** 筛选 chips 保留产品类目名（Products.names） */
export const categoryChips = (m: IndustryMessages) => INDUSTRIES.map((i) => resolveIndustry(i.slug, m.Products?.names)).filter((x): x is ResolvedIndustry => x !== null);
