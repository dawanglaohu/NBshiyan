// Product JSON-LD for category landing pages (Refs #99).
// Only fields backed by real data are emitted. offers / aggregateRating / review /
// additionalProperty are NOT generated unless explicitly supplied by the caller
// with real data — never fabricate them.
import { SITE_URL } from '../../site';
import { categoryMeta, type CategoryMeta } from '../categoryMeta';

export type Locale = 'en' | 'ru';

export type ProductRealData = {
  /** Absolute or site-relative image URLs (e.g. /posters/custom-color-boxes.webp). */
  images?: string[];
  sku?: string;
  /** Only pass when real commercial terms exist. */
  offers?: { price: string; priceCurrency: string; availability?: string; url?: string };
  /** Only pass with genuine, verifiable reviews. */
  aggregateRating?: { ratingValue: number; reviewCount: number };
  review?: Array<{ author: string; reviewBody: string; ratingValue?: number }>;
  /** Real, confirmed spec values only (e.g. MOQ once Ryan provides it). */
  specs?: Array<{ name: string; value: string }>;
};

const abs = (u: string) => (/^https?:\/\//.test(u) ? u : `${SITE_URL}${u.startsWith('/') ? '' : '/'}${u}`);

export function findCategory(key: string): CategoryMeta | undefined {
  return categoryMeta.find((c) => c.key === key);
}

export function categoryUrl(c: CategoryMeta, locale: Locale) {
  return `${SITE_URL}/${locale}/products/${c[locale].slug}`;
}

export function buildProductJsonLd(key: string, locale: Locale, data: ProductRealData = {}) {
  const c = findCategory(key);
  if (!c) throw new Error(`Unknown category key: ${key}`);
  const m = c[locale];
  const url = categoryUrl(c, locale);
  const name = m.title.split('|')[0].replace(/\s+[—-]\s+.*$/, '').trim();
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': `${url}#product`,
    name,
    description: m.description,
    url,
    category: m.keyword,
    inLanguage: locale,
    brand: { '@type': 'Brand', name: 'PackJoyU' },
    manufacturer: { '@type': 'Organization', name: 'PackJoyU', url: SITE_URL },
  };
  if (data.images?.length) ld.image = data.images.map(abs);
  if (data.sku) ld.sku = data.sku;
  if (data.specs?.length)
    ld.additionalProperty = data.specs.map((s) => ({ '@type': 'PropertyValue', name: s.name, value: s.value }));
  if (data.offers)
    ld.offers = { '@type': 'Offer', url, availability: 'https://schema.org/InStock', ...data.offers };
  if (data.aggregateRating) ld.aggregateRating = { '@type': 'AggregateRating', ...data.aggregateRating };
  if (data.review?.length)
    ld.review = data.review.map((r) => ({
      '@type': 'Review',
      author: { '@type': 'Person', name: r.author },
      reviewBody: r.reviewBody,
      ...(r.ratingValue != null ? { reviewRating: { '@type': 'Rating', ratingValue: r.ratingValue } } : {}),
    }));
  return ld;
}
