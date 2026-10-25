import { isProdEnvFrom } from '../site';
import { CATEGORY_PAGES_LIVE } from './categoryPages';

/**
 * SEO 审计 mock（scripts/seo-audit.ts --mock）：SEO_AUDIT_MOCK=1 时强制打开品类落地页，并用本地 mock 文章代替 Sanity（不发网络请求）。
 * 只在 APP_ENV 去空白后非空、且不是 production 时打开。APP_ENV 未设置时关闭。
 * APP_ENV=production 时关闭，误设 SEO_AUDIT_MOCK=1 也不生效。VERCEL_ENV 与 NODE_ENV 不参与。
 * 这比 isProdEnvFrom 更严：未设置 APP_ENV 时 isProdEnvFrom 为 false，mock 仍然关闭。
 */
export function seoMockEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const explicitNonProd = !!env.APP_ENV?.trim() && !isProdEnvFrom(env);
  return env.SEO_AUDIT_MOCK === '1' && explicitNonProd;
}

/** 品类落地页是否可访问：CATEGORY_PAGES_LIVE（#198）或本地 mock 模式 */
export function categoryPagesLive(env: Record<string, string | undefined> = process.env): boolean {
  return CATEGORY_PAGES_LIVE || seoMockEnabled(env);
}
