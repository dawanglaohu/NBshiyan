import { CATEGORY_PAGES_LIVE } from './categoryPages';

/**
 * SEO 审计 mock 模式（scripts/seo-audit.ts --mock）：本地构建时设 SEO_AUDIT_MOCK=1，
 * 强制打开品类落地页并用本地 mock 文章代替 Sanity（不发网络请求）。
 * 生产环境（VERCEL_ENV=production）一律关闭，即使误设了变量也不生效。
 */
export function seoMockEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SEO_AUDIT_MOCK === '1' && env.VERCEL_ENV !== 'production';
}

/** 品类落地页是否可访问：CATEGORY_PAGES_LIVE（#198）或本地 mock 模式 */
export function categoryPagesLive(env: Record<string, string | undefined> = process.env): boolean {
  return CATEGORY_PAGES_LIVE || seoMockEnabled(env);
}
