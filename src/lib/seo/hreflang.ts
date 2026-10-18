/**
 * hreflang 共用规则（sitemap 和页面 HTML 共用，保证两边一致）：
 * - x-default 只在默认语言（en）版本存在时输出，且指向 en；默认语言版本不存在时不输出 x-default。
 * - 列表页只互指「可索引」的语言（该语言至少有一篇可索引文档）；当前页本身不可索引（noindex 空态）时不输出任何 hreflang。
 */
export function withXDefault<L extends string>(languages: Partial<Record<L, string>>, defaultLocale: L): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [l, href] of Object.entries(languages) as [string, string | undefined][]) if (href) out[l] = href;
  if (out[defaultLocale]) out['x-default'] = out[defaultLocale];
  return out;
}

export function listLanguages<L extends string>(opts: {
  current: L;
  locales: readonly L[];
  indexable: readonly L[];
  defaultLocale: L;
  href: (l: L) => string;
}): Record<string, string> {
  if (!opts.indexable.includes(opts.current)) return {};
  const langs: Partial<Record<L, string>> = {};
  for (const l of opts.locales) if (opts.indexable.includes(l)) langs[l] = opts.href(l);
  return withXDefault(langs, opts.defaultLocale);
}
