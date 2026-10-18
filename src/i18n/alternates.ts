import { PUBLISHED_LOCALES, DEFAULT_PUBLISHED_LOCALE } from './published-locales';
// 每个页面按自己的路径输出 hreflang 和指向自身的 canonical
export function alternatesFor(locale: string, path = '') {
  const languages: Record<string, string> = Object.fromEntries(PUBLISHED_LOCALES.map((l) => [l, `/${l}${path}`]));
  languages['x-default'] = `/${DEFAULT_PUBLISHED_LOCALE}${path}`; // x-default 固定指向 en
  return { canonical: `/${locale}${path}`, languages };
}
