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

export type ResolvedIndustry = Industry & { name: string };

/** 未知 slug 或缺少本地化名称 → null（调用方 notFound()） */
export function resolveIndustry(slug: string, names: Readonly<Record<string, string>>): ResolvedIndustry | null {
  const hit = INDUSTRIES.find((i) => i.slug === slug);
  if (!hit) return null;
  const name = Object.prototype.hasOwnProperty.call(names, hit.slug) ? names[hit.slug] : undefined;
  return name ? { ...hit, name } : null;
}

export const industryParams = () => INDUSTRIES.map((i) => ({ slug: i.slug }));
