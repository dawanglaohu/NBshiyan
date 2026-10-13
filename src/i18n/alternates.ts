import { routing } from './routing';
// 每个页面按自己的路径输出 hreflang 和指向自身的 canonical
export function alternatesFor(locale: string, path = '') {
  const languages: Record<string, string> = Object.fromEntries(routing.locales.map((l) => [l, `/${l}${path}`]));
  languages['x-default'] = `/${routing.defaultLocale}${path}`;
  return { canonical: `/${locale}${path}`, languages };
}
