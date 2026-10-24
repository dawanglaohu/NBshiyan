/** Sanity 内容 slug。de 把变音折成 ae/oe/ue/ss；es/fr 只去掉组合附加符号。之后小写，非 [a-z0-9] 折成连字符，合并并去掉首尾连字符，最长 96。 */
const SLUG_MAX = 96;
const GERMAN_FOLD: Record<string, string> = {
  Ä: 'ae', ä: 'ae', Ö: 'oe', ö: 'oe', Ü: 'ue', ü: 'ue', ẞ: 'ss', ß: 'ss',
};

export function slugifyContent(input: string, locale: string): string {
  let text = input;
  if (locale === 'de') text = text.replace(/[ÄäÖöÜüẞß]/g, (ch) => GERMAN_FOLD[ch]);
  else if (locale === 'es' || locale === 'fr') text = text.normalize('NFD').replace(/\p{M}/gu, '');
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, SLUG_MAX).replace(/-+$/g, '');
}

/** 本语言标题有非空白内容时用它，否则回退 title.en。 */
export function contentSlugSource(doc: unknown, locale: string): string {
  const title = doc && typeof doc === 'object' && 'title' in doc ? (doc as { title?: unknown }).title : undefined;
  const bag = title && typeof title === 'object' ? title as Record<string, unknown> : {};
  const own = bag[locale];
  if (typeof own === 'string' && own.trim()) return own;
  const en = bag.en;
  return typeof en === 'string' ? en : '';
}
