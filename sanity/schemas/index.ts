// Sanity Studio schema（在 Ryan 的 Sanity 项目里使用：sanity.config 中 schema.types = schemaTypes）。
// 不依赖 sanity 包，纯对象定义，网站构建不受影响。
// 内容语言只有这一份列表。加一种语言：在 contentLocales 加一行。公开站点是否发布看 PUBLISHED_LOCALES，不看这里。
import { contentSlugSource, slugifyContent } from '../../src/lib/seo/contentSlug';
export const contentLocales = [
  { code: 'en', title: 'English', required: true },
  { code: 'ru', title: 'Русский' },
  { code: 'es', title: 'Español' },
  { code: 'de', title: 'Deutsch' },
  { code: 'fr', title: 'Français' },
] as const;

type ContentLocale = (typeof contentLocales)[number];

const localeFields = (type: string, requireEnglish: boolean, extra?: (loc: ContentLocale) => Record<string, unknown>) =>
  contentLocales.map((loc) => ({
    name: loc.code,
    type,
    title: loc.title,
    ...(extra?.(loc) ?? {}),
    ...(requireEnglish && 'required' in loc && loc.required ? { validation: (r: { required(): unknown }) => r.required() } : {}),
  }));

const localeString = (name: string, title: string) => ({ name, title, type: 'object', fields: localeFields('string', true) });
const localeText = (name: string, title: string) => ({ name, title, type: 'object', fields: localeFields('text', false) });
const localeBlocks = (name: string, title: string) => ({ name, title, type: 'object', fields: localeFields('array', false, () => ({ of: [{ type: 'block' }, { type: 'image' }] })) });
// es/de/fr 用本语言标题（空白则回退 title.en）再按该语言 slugify。en/ru 仍固定 title.en，沿用 Sanity 默认 slugify。
const OWN_TITLE_SLUGS = new Set(['es', 'de', 'fr']);
const slugs = {
  name: 'slug', title: 'Slug', type: 'object',
  fields: localeFields('slug', true, (loc) => (
    OWN_TITLE_SLUGS.has(loc.code)
      ? {
          options: {
            source: (doc: unknown) => contentSlugSource(doc, loc.code),
            maxLength: 96,
            slugify: (input: string) => slugifyContent(input, loc.code),
          },
        }
      : { options: { source: 'title.en', maxLength: 96 } }
  )),
};
const seo = { name: 'seo', title: 'SEO', type: 'object', fields: [localeString('title', 'Meta title'), localeText('description', 'Meta description'), { name: 'noindex', type: 'boolean', initialValue: false }] };
const doc = (name: string, title: string, extra: object[] = []) => ({ name, title, type: 'document', fields: [localeString('title', 'Title'), slugs, localeText('excerpt', 'Excerpt'), localeBlocks('body', 'Body'), ...extra, seo] });

export const schemaTypes = [
  doc('product', 'Product', [{ name: 'category', type: 'string', title: 'Category slug (categoryMeta.ts)' }, { name: 'cover', type: 'image' }]),
  doc('solution', 'Solution'),
  doc('article', 'Article', [{ name: 'publishedAt', type: 'datetime' }])
];
