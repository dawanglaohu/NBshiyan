import { categoryMeta } from '@/lib/seo/categoryMeta';
import { ogImageUrl, OG_WIDTH, OG_HEIGHT } from '@/lib/seo/pageMeta';

// 品类落地页分享图：public/og/category-<该语言 slug>-<locale>.jpg（render-og-categories.mjs 生成）。
// categoryMeta 是数组，按 [locale].slug 严格相等查找，不走对象属性/原型链（constructor、__proto__ 等查不到）；
// 文件名只用查到的条目里的 slug，绝不拼 URL 参数。查不到返回 undefined（不输出 og:image）。
export type CategoryOgImage = { url: string; width: number; height: number; alt: string };

export function categoryOgImage(locale: 'en' | 'ru', slug: string): CategoryOgImage | undefined {
  const c = categoryMeta.find((m) => m[locale].slug === slug);
  if (!c) return undefined;
  const meta = c[locale];
  return { url: ogImageUrl(`category-${meta.slug}`, locale), width: OG_WIDTH, height: OG_HEIGHT, alt: `${meta.keyword} | PackJoyU` };
}
