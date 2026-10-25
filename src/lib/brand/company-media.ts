/**
 * Exact image-component releases for company pages.
 * The list is the files, not a /brand prefix. Video, posters, the logo master, and named GIF
 * copies that are not in the public tree stay out. Callers get a web path, pixel size and alt text.
 * Private source paths are not in this module. Confirmed pixels do not stand in for the editable
 * source or the attested facts.
 */

export type CompanyMediaAlt = { readonly en: string; readonly ru: string };

export type CompanyMediaRelease = {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly alt: CompanyMediaAlt;
};

const CITY_STILL: CompanyMediaAlt = {
  en: 'PackJoyU industrial illustration with an airship, packaging factory, river, cargo ship and workers.',
  ru: 'Промышленная иллюстрация PackJoyU: дирижабль, упаковочная фабрика, река, грузовое судно и рабочие.',
};

const CITY_PAUSE: CompanyMediaAlt = {
  en: 'Still frame of the PackJoyU industrial illustration with an airship, packaging factory, river, cargo ship and workers.',
  ru: 'Неподвижный кадр промышленной иллюстрации PackJoyU: дирижабль, упаковочная фабрика, река, грузовое судно и рабочие.',
};

const COMPANY_PLATE: CompanyMediaAlt = {
  en: 'English PackJoyU company introduction with the official wordmark, conceptual packaging illustrations, company capabilities, a design-to-quality-control sequence, and a twelve-category product portfolio.',
  ru: 'Англоязычное представление PackJoyU: официальный логотип, условные иллюстрации упаковки, возможности компании, последовательность от дизайна до контроля качества и ассортимент из двенадцати категорий.',
};

const RELEASED: readonly CompanyMediaRelease[] = [
  { src: '/brand/packjoyu-industrial-city-v3.png', width: 1737, height: 905, alt: CITY_STILL },
  { src: '/brand/packjoyu-industrial-city-v3-loop-poster.png', width: 1384, height: 720, alt: CITY_PAUSE },
  { src: '/brand/company/company-introduction-v3-en.png', width: 5000, height: 5800, alt: COMPANY_PLATE },
];

/** The one company plate. Home summary and about both use this path. */
export const COMPANY_ARTWORK_SRC = '/brand/company/company-introduction-v3-en.png';

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

/** One locale's alt. An unknown locale does not fall back to the other language. */
export function companyArtwork(locale: string): { src: string; width: number; height: number; alt: string } | null {
  if (locale !== 'en' && locale !== 'ru') return null;
  const item = releaseCompanyMedia(COMPANY_ARTWORK_SRC);
  if (!item) return null;
  return { src: item.src, width: item.width, height: item.height, alt: item.alt[locale] };
}
