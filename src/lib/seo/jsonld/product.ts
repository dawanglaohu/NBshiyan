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
  /** Absolute or site-relative image URLs (e.g. /posters/custom-color-boxes.8f12372d.webp). */
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

export function findCategory(key: string): CategoryMeta | undefined {
  return categoryMeta.find((c) => c.key === key);
}

export function categoryUrl(c: CategoryMeta, locale: Locale) {
  return `${SITE_URL}/${locale}/products/${c[locale].slug}`;
}

/**
 * Certificate links may point at any issuer domain, but must parse as an absolute
 * https URL with no username/password. Returns the normalized href, or undefined.
 * Note: WHATWG parsing normalizes 'https:evil.com' to 'https://evil.com/' (accepted, normalized).
 */
export function safeCertUrl(u?: string): string | undefined {
  if (!u || typeof u !== 'string') return undefined;
  let r: URL;
  try { r = new URL(u.trim()); } catch { return undefined; }
  if (r.protocol !== 'https:' || r.username || r.password || !r.hostname) return undefined;
  return r.href;
}

const SITE_ORIGIN = new URL(SITE_URL).origin;
const IMAGE_CDN_ORIGIN = 'https://cdn.sanity.io';

/**
 * Absolute image URL allow-list. Rejects other hosts, userinfo tricks
 * such as 'https://packjoyu.com@evil.com/x', and non-https schemes. Returns the normalized href.
 * (The site origin is also accepted as-is so local http://localhost dev builds keep working.)
 */
export function safeAbsoluteImage(u: string): string[] {
  let r: URL;
  try { r = new URL(u); } catch { return []; }
  if (r.username || r.password) return [];
  if (r.origin === SITE_ORIGIN) return [r.href];
  if (r.protocol === 'https:' && r.origin === IMAGE_CDN_ORIGIN) return [r.href];
  return [];
}

// NOTE: buildProductJsonLd is not wired into any page yet. When it is, render the result ONLY via
// the <JsonLd> component (src/components/seo/JsonLd.tsx), which escapes '<' etc. Never use a raw
// dangerouslySetInnerHTML with JSON.stringify.
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
  // Site-relative paths resolve against SITE_URL; absolute URLs are parsed and kept only when they
  // point at the site origin or the HTTPS image CDN (cdn.sanity.io), with no credentials.
  const images = (data.images ?? []).flatMap((u) => {
    if (u.startsWith('/') || u.startsWith('\\')) {
      // Resolve with the WHATWG URL parser and require the same origin: '//evil.com/x' and '/\\evil.com/x'
      // (backslash is treated as '/') would otherwise escape to another host.
      try {
        const r = new URL(u, SITE_URL);
        return r.origin === SITE_ORIGIN && !r.username && !r.password ? [r.href] : [];
      } catch { return []; }
    }
    return safeAbsoluteImage(u);
  });
  if (images.length) ld.image = images;
  if (data.sku) ld.sku = data.sku;
  const material = data.specs?.material?.trim();
  if (material) ld.material = material;
  const props = data.specs ? specProperties(data.specs) : [];
  if (props.length) ld.additionalProperty = props;
  const certs = (data.certifications ?? [])
    .map((x) => ({ x, url: safeCertUrl(x.url) }))
    .filter(({ x, url }) => x.name?.trim() && url)
    .map(({ x, url }) => ({
      '@type': 'Certification', name: x.name.trim(), url,
      ...(x.certNo?.trim() ? { certificationIdentification: x.certNo.trim() } : {}),
    }));
  if (certs.length) ld.hasCertification = certs;
  return ld;
}
