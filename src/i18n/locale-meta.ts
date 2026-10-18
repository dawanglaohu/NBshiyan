import type { Locale as DbLocale } from '@prisma/client';
import { PUBLISHED_LOCALES, DEFAULT_PUBLISHED_LOCALE, isPublishedLocale } from './published-locales';

/**
 * 每种语言的展示信息（含未发布的预留语言，供以后开放时直接用）：
 * - ogLocale：og:locale / og:locale:alternate
 * - nativeName：语言下拉里的母语名称（UX：不用国旗）
 * - short：语言按钮上的缩写
 * - dir：文字方向；ar 为 rtl（第 3 期才真正开放 RTL，这里先把映射放好）
 * 键是 Prisma `enum Locale` 的全集，漏一个 tsc 就报错。
 */
export type LocaleMeta = { ogLocale: string; nativeName: string; short: string; dir: 'ltr' | 'rtl' };
export const LOCALE_META: Record<DbLocale, LocaleMeta> = {
  en: { ogLocale: 'en_US', nativeName: 'English', short: 'EN', dir: 'ltr' },
  ru: { ogLocale: 'ru_RU', nativeName: 'Русский', short: 'RU', dir: 'ltr' },
  es: { ogLocale: 'es_ES', nativeName: 'Español', short: 'ES', dir: 'ltr' },
  de: { ogLocale: 'de_DE', nativeName: 'Deutsch', short: 'DE', dir: 'ltr' },
  fr: { ogLocale: 'fr_FR', nativeName: 'Français', short: 'FR', dir: 'ltr' },
  ja: { ogLocale: 'ja_JP', nativeName: '日本語', short: 'JA', dir: 'ltr' },
  hi: { ogLocale: 'hi_IN', nativeName: 'हिन्दी', short: 'HI', dir: 'ltr' },
  ar: { ogLocale: 'ar_AR', nativeName: 'العربية', short: 'AR', dir: 'rtl' }
};

export const localeMeta = (l: string): LocaleMeta => (Object.hasOwn(LOCALE_META, l) ? LOCALE_META[l as DbLocale] : LOCALE_META[DEFAULT_PUBLISHED_LOCALE]);
export const localeDir = (l: string): 'ltr' | 'rtl' => localeMeta(l).dir;

/** og:locale 和 og:locale:alternate：alternate 只列已发布的其他语言（与 hreflang 同一份清单） */
export function ogLocales(locale: string): { locale: string; alternateLocale: string[] } {
  const cur = isPublishedLocale(locale) ? locale : DEFAULT_PUBLISHED_LOCALE;
  return { locale: LOCALE_META[cur].ogLocale, alternateLocale: PUBLISHED_LOCALES.filter((l) => l !== cur).map((l) => LOCALE_META[l].ogLocale) };
}
