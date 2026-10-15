/**
 * 品类页、文章页的 title / description 生成规则（en + ru），规则说明见 docs/seo-page-templates.md。
 * 纯函数：只整理、截断已有文案，不生成任何新的事实、数字或认证说法。
 */
export type Locale = 'en' | 'ru';
export const BRAND = 'PackJoyU';
export const SEP = ' | ';
export const TITLE_MIN = 30, TITLE_MAX = 60, DESC_MIN = 70, DESC_MAX = 160;

/** 各页面类型的兜底名称（名称缺失或是占位符时用） */
export const SECTION_NAMES: Record<'products' | 'articles', Record<Locale, string>> = {
  products: { en: 'Products', ru: 'Продукция' },
  articles: { en: 'Articles', ru: 'Статьи' }
};

const ELLIPSIS = '…';
/** 合并空白；含 `{{` 占位符的文本视为不可用 */
export function clean(s: string | null | undefined): string | undefined {
  if (typeof s !== 'string' || s.includes('{{')) return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t || undefined;
}

/** 在单词边界截断到 max 个字符以内（含末尾 …）；单个超长单词时硬截断 */
export function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const room = max - ELLIPSIS.length;
  const cut = s.slice(0, room + 1);
  const sp = cut.lastIndexOf(' ');
  const base = (sp > room * 0.5 ? cut.slice(0, sp) : s.slice(0, room)).replace(/[\s,;:.\-–—|]+$/u, '');
  return base + ELLIPSIS;
}

const hasBrand = (s: string) => s.toLowerCase().includes(BRAND.toLowerCase());

/**
 * title 规则：
 * 1. 编辑给的 SEO title（Sanity seo.title / categoryMeta.title）可用且长度 30–60 → 原样使用（没带品牌且放得下就补 " | PackJoyU"）。
 * 2. 否则用 "<名称/H1> | PackJoyU"；超过 60 → 名称按单词截断，保证品牌后缀完整。
 * 3. 名称缺失或是占位符 → "<栏目名> | PackJoyU"。
 * 不足 30 字符时不补凑词（避免编造），由审计脚本给出 warning。
 */
export function buildTitle(opts: { name?: string | null; seoTitle?: string | null; fallback: string }): string {
  const seo = clean(opts.seoTitle);
  if (seo) {
    const withBrand = hasBrand(seo) ? seo : seo + SEP + BRAND;
    if (withBrand.length >= TITLE_MIN && withBrand.length <= TITLE_MAX) return withBrand;
    if (seo.length >= TITLE_MIN && seo.length <= TITLE_MAX) return seo;
  }
  const name = clean(opts.name) ?? clean(opts.fallback) ?? BRAND;
  const suffix = SEP + BRAND;
  if (hasBrand(name) && name.length <= TITLE_MAX) return name;
  return truncateAtWord(name, TITLE_MAX - suffix.length) + suffix;
}

/**
 * description 规则：按顺序取第一个可用来源（SEO description → 品类 meta / 文章摘要），跳过含 `{{` 的。
 * 超过 160 → 单词边界截断并加 …；短于 70 仍原样使用（不补凑），审计给 warning；都没有 → undefined（不输出该 meta）。
 */
export function buildDescription(...sources: (string | null | undefined)[]): string | undefined {
  for (const s of sources) {
    const c = clean(s);
    if (c) return truncateAtWord(c, DESC_MAX);
  }
  return undefined;
}

export function categorySeo(opts: { locale: Locale; name?: string | null; meta?: { title?: string; description?: string } | null }) {
  return {
    title: buildTitle({ name: opts.name, seoTitle: opts.meta?.title, fallback: SECTION_NAMES.products[opts.locale] }),
    description: buildDescription(opts.meta?.description)
  };
}

export function articleSeo(opts: { locale: Locale; title?: string | null; excerpt?: string | null; seo?: { title?: string | null; description?: string | null } | null }) {
  return {
    title: buildTitle({ name: opts.title, seoTitle: opts.seo?.title, fallback: SECTION_NAMES.articles[opts.locale] }),
    description: buildDescription(opts.seo?.description, opts.excerpt)
  };
}
