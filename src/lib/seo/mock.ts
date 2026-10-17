import { isProdEnvFrom } from '../site';
import { CATEGORY_PAGES_LIVE } from './categoryPages';

/**
 * SEO 审计 mock 模式（scripts/seo-audit.ts --mock）：本地构建时设 SEO_AUDIT_MOCK=1，
 * 强制打开品类落地页并用本地 mock 文章代替 Sanity（不发网络请求）。
 * 生产环境（APP_ENV/VERCEL_ENV=production）一律关闭，即使误设了变量也不生效。
 * #291 默认安全：APP_ENV 和 VERCEL_ENV 都没设时也按生产处理（关闭），本地/CI 审计必须显式设 APP_ENV=development 或 test。
 * 只影响 SEO mock，isProdEnvFrom 本身不变（noindex、IndexNow、生产自检等仍按原规则）。
 */
export function seoMockEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const explicitNonProd = !!(env.APP_ENV?.trim() || env.VERCEL_ENV?.trim()) && !isProdEnvFrom(env);
  return env.SEO_AUDIT_MOCK === '1' && explicitNonProd;
}

/** 品类落地页是否可访问：CATEGORY_PAGES_LIVE（#198）或本地 mock 模式 */
export function categoryPagesLive(env: Record<string, string | undefined> = process.env): boolean {
  return CATEGORY_PAGES_LIVE || seoMockEnabled(env);
}
