import type { DocType, Locale } from './sanity';

/**
 * 仅供 SEO 审计 mock 模式（seoMockEnabled）使用的本地文章数据，不访问 Sanity。
 * 内容是明确标注的测试文本，不含任何业务事实、数字或认证说法，绝不会在生产环境出现。
 */
type MockDoc = { _id: string; slug: Record<Locale, string>; title: Record<Locale, string>; excerpt: Record<Locale, string>; seo?: { title?: Record<Locale, string>; description?: Record<Locale, string> } };

export const MOCK_ARTICLES: MockDoc[] = [
  { _id: 'mock-article-1', slug: { en: 'mock-article-packaging-guide', ru: 'mock-statya-o-upakovke' },
    title: { en: 'Mock Article: Packaging Guide Layout Test', ru: 'Тестовая статья: проверка макета' },
    excerpt: { en: 'This is placeholder text used only by the local SEO audit to check article page templates and breadcrumbs.',
      ru: 'Это тестовый текст для локальной SEO-проверки шаблонов страниц статей и хлебных крошек.' } },
  // 超长标题 + 超长摘要：检查截断规则
  { _id: 'mock-article-2', slug: { en: 'mock-article-long-title', ru: 'mock-statya-dlinnyy-zagolovok' },
    title: { en: 'Mock Article With A Deliberately Very Long Title That Must Be Truncated By The Template',
      ru: 'Тестовая статья с намеренно очень длинным заголовком, который шаблон должен обрезать' },
    excerpt: { en: 'Placeholder excerpt for the local SEO audit. It is intentionally longer than one hundred and sixty characters so that the description template has to cut it at a word boundary.',
      ru: 'Тестовый отрывок для локальной SEO-проверки. Он намеренно длиннее ста шестидесяти символов, чтобы шаблон описания обрезал его по границе слова и добавил многоточие.' } }
];

export function mockDocs(type: DocType, locale: Locale) {
  if (type !== 'article') return [];
  return MOCK_ARTICLES.map((d) => ({ _id: d._id, slug: d.slug[locale], title: d.title[locale], excerpt: d.excerpt[locale] }));
}

export function mockDocBySlug(type: DocType, locale: Locale, slug: string) {
  if (type !== 'article') return null;
  const d = MOCK_ARTICLES.find((x) => x.slug[locale] === slug);
  if (!d) return null;
  return { _id: d._id, slug: d.slug[locale], alt: d.slug, title: d.title[locale], excerpt: d.excerpt[locale], body: [],
    seo: { title: d.seo?.title?.[locale], description: d.seo?.description?.[locale], noindex: false } };
}

/** sitemap 用（CmsDoc 形状） */
export function mockCmsDocs(type: string) {
  return type === 'article' ? MOCK_ARTICLES.map((d) => ({ updatedAt: undefined, noindex: false, slug: { ...d.slug } })) : [];
}
