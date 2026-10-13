// Sanity Studio schema（在 Ryan 的 Sanity 项目里使用：sanity.config 中 schema.types = schemaTypes）。
// 不依赖 sanity 包，纯对象定义，网站构建不受影响。
const localeString = (name: string, title: string) => ({ name, title, type: 'object', fields: [{ name: 'en', type: 'string', title: 'English', validation: (r: { required(): unknown }) => r.required() }, { name: 'ru', type: 'string', title: 'Русский' }] });
const localeText = (name: string, title: string) => ({ name, title, type: 'object', fields: [{ name: 'en', type: 'text', title: 'English' }, { name: 'ru', type: 'text', title: 'Русский' }] });
const localeBlocks = (name: string, title: string) => ({ name, title, type: 'object', fields: [{ name: 'en', type: 'array', of: [{ type: 'block' }, { type: 'image' }] }, { name: 'ru', type: 'array', of: [{ type: 'block' }, { type: 'image' }] }] });
const slugs = { name: 'slug', title: 'Slug', type: 'object', fields: [
  { name: 'en', type: 'slug', options: { source: 'title.en', maxLength: 96 }, validation: (r: { required(): unknown }) => r.required() },
  { name: 'ru', type: 'slug', options: { source: 'title.en', maxLength: 96 } }
] };
const seo = { name: 'seo', title: 'SEO', type: 'object', fields: [localeString('title', 'Meta title'), localeText('description', 'Meta description'), { name: 'noindex', type: 'boolean', initialValue: false }] };
const doc = (name: string, title: string, extra: object[] = []) => ({ name, title, type: 'document', fields: [localeString('title', 'Title'), slugs, localeText('excerpt', 'Excerpt'), localeBlocks('body', 'Body'), ...extra, seo] });

export const schemaTypes = [
  doc('product', 'Product', [{ name: 'category', type: 'string', title: 'Category slug (categoryMeta.ts)' }, { name: 'cover', type: 'image' }]),
  doc('solution', 'Solution'),
  doc('article', 'Article', [{ name: 'publishedAt', type: 'datetime' }])
];
