// Product JSON-LD for category landing pages (Refs #99).
// Only fields backed by real data are emitted. offers / price / aggregateRating /
// review are never output (no inputs exist for them). Spec values come from
// /api/specs (#219); sampleFee / leadTime / tradeTerms are deliberately not mapped.
import { SITE_URL } from '../../site';
import { categoryMeta, type CategoryMeta } from '../categoryMeta';

export type Locale = 'en' | 'ru';

/** Size range in mm per dimension, as returned by /api/specs. */
export type Dims = { l: number; w: number; h: number };

export type ProductRealData = {
  /** Absolute or site-relative image URLs (e.g. /posters/custom-color-boxes.01433ea7.webp). */
  images?: string[];
  sku?: string;
  /** Real, confirmed spec values only (from /api/specs). Empty/missing => omitted. */
  specs?: {
    moq?: { value: number; unit: 'pcs' };
    size?: { min?: Dims; max?: Dims; unit: 'mm' };
    /** Localized material string for the page's locale. */
    material?: string;
  };
  /** Only certs with an https url are output. */
  certifications?: Array<{ name: string; certNo?: string; url?: string }>;
};

const abs = (u: string) => (/^https?:\/\//.test(u) ? u : `${SITE_URL}${u.startsWith('/') ? '' : '/'}${u}`);

export function findCategory(key: string): CategoryMeta | undefined {
  return categoryMeta.find((c) => c.key === key);
}

export function categoryUrl(c: CategoryMeta, locale: Locale) {
  return `${SITE_URL}/${locale}/products/${c[locale].slug}`;
}

const isHttps = (u?: string) => {
  if (!u) return false;
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
};

const DIM_NAMES: Record<keyof Dims, string> = { l: 'Length', w: 'Width', h: 'Height' };

function specProperties(specs: NonNullable<ProductRealData['specs']>) {
  const props: Record<string, unknown>[] = [];
  if (specs.moq && specs.moq.value > 0)
    props.push({
      '@type': 'PropertyValue', name: 'Minimum order quantity', propertyID: 'moq',
      value: { '@type': 'QuantitativeValue', minValue: specs.moq.value, unitCode: 'H87' },
    });
  const s = specs.size;
  if (s && (s.min || s.max))
    for (const d of ['l', 'w', 'h'] as const) {
      const q: Record<string, unknown> = { '@type': 'QuantitativeValue', unitCode: 'MMT' };
      if (s.min) q.minValue = s.min[d];
      if (s.max) q.maxValue = s.max[d];
      props.push({ '@type': 'PropertyValue', name: DIM_NAMES[d], propertyID: `size.${d}`, value: q });
    }
  return props;
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
    brand: { '@type': 'Brand', name: 'PackJoyU' },
  };
  if (data.images?.length) ld.image = data.images.map(abs);
  if (data.sku) ld.sku = data.sku;
  const material = data.specs?.material?.trim();
  if (material) ld.material = material;
  const props = data.specs ? specProperties(data.specs) : [];
  if (props.length) ld.additionalProperty = props;
  const certs = (data.certifications ?? [])
    .filter((x) => x.name?.trim() && isHttps(x.url))
    .map((x) => ({
      '@type': 'Certification', name: x.name.trim(), url: x.url,
      ...(x.certNo?.trim() ? { certificationIdentification: x.certNo.trim() } : {}),
    }));
  if (certs.length) ld.hasCertification = certs;
  return ld;
}
