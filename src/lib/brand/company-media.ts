/**
 * Exact image-component releases for the company plate.
 * The list is the six derived files the pages reference. Callers get a web path, pixel size and alt text
 * only when the path matches one entry. Private source paths are not in this module.
 */

export type CompanyMediaAlt = { readonly en: string; readonly ru: string };

export type CompanyMediaRelease = {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly alt: CompanyMediaAlt;
};

const ART_ALT: CompanyMediaAlt = {
  en: 'PackJoyU conceptual illustrations of custom packaging and printed products',
  ru: 'Условные иллюстрации PackJoyU: упаковка и печатная продукция на заказ',
};

const CROP_FRAMES = [
  { src: '/brand/company/company-introduction-v3-en-crop-480.5094aa86.webp', width: 480, height: 429 },
  { src: '/brand/company/company-introduction-v3-en-crop-960.ee4a5713.webp', width: 960, height: 858 },
  { src: '/brand/company/company-introduction-v3-en-crop-1440.972e7f35.webp', width: 1440, height: 1287 },
] as const;

const FULL_FRAMES = [
  { src: '/brand/company/company-introduction-v3-en-w800.77f0c95d.webp', width: 800, height: 928 },
  { src: '/brand/company/company-introduction-v3-en-w1600.7033e7eb.webp', width: 1600, height: 1856 },
  { src: '/brand/company/company-introduction-v3-en-w2400.fdff20de.webp', width: 2400, height: 2784 },
] as const;

const RELEASED: readonly CompanyMediaRelease[] = [...CROP_FRAMES, ...FULL_FRAMES].map((frame) => ({
  src: frame.src,
  width: frame.width,
  height: frame.height,
  alt: ART_ALT,
}));

function isExactWebPath(src: string): boolean {
  if (typeof src !== 'string' || src.length === 0 || src.length > 240) return false;
  if (!src.startsWith('/') || src.startsWith('//')) return false;
  if (src.includes('\\') || src.includes(':') || src.includes('?') || src.includes('#') || src.includes('\0')) return false;
  const parts = src.split('/');
  if (parts[0] !== '') return false;
  return parts.slice(1).every((part) => part !== '' && part !== '.' && part !== '..');
}

function usable(item: CompanyMediaRelease): boolean {
  return Number.isInteger(item.width) && item.width > 0
    && Number.isInteger(item.height) && item.height > 0
    && item.alt.en.trim().length > 0
    && item.alt.ru.trim().length > 0;
}

/** Returns the release for an exact web path, or null for anything outside the list. */
export function releaseCompanyMedia(src: string): CompanyMediaRelease | null {
  if (!isExactWebPath(src)) return null;
  const item = RELEASED.find((entry) => entry.src === src);
  if (!item || !usable(item)) return null;
  return { src: item.src, width: item.width, height: item.height, alt: { en: item.alt.en, ru: item.alt.ru } };
}

export function releasedCompanyMedia(): CompanyMediaRelease[] {
  return RELEASED.map((item) => releaseCompanyMedia(item.src)).filter((item): item is CompanyMediaRelease => item !== null);
}

export type CompanyArtworkVariant = {
  src: string;
  srcSet: string;
  width: number;
  height: number;
};

function variant(frames: readonly { src: string; width: number; height: number }[], width: number, height: number): CompanyArtworkVariant {
  return {
    src: frames[frames.length - 1].src,
    srcSet: frames.map((frame) => `${frame.src} ${frame.width}w`).join(', '),
    width,
    height,
  };
}

/** Crop and full plate for one locale. An unknown locale does not fall back to the other language. */
export function companyArtwork(locale: string): { alt: string; crop: CompanyArtworkVariant; full: CompanyArtworkVariant } | null {
  if (locale !== 'en' && locale !== 'ru') return null;
  return {
    alt: ART_ALT[locale],
    crop: variant(CROP_FRAMES, 1440, 1287),
    full: variant(FULL_FRAMES, 5000, 5800),
  };
}
