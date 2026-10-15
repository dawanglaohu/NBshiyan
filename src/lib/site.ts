export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/**
 * 是否正式生产环境：只认我们自己的 APP_ENV（不再依赖 Vercel 注入的 VERCEL_ENV）。
 * APP_ENV === 'production' 算生产（过渡期另认 VERCEL_ENV === 'production'）；未设置或其他值一律按非生产处理（fail safe：整站 noindex、关闭 IndexNow 等）。
 */
export function isProdEnvFrom(env: Record<string, string | undefined> = process.env): boolean {
  // TODO(迁移后删除): remove VERCEL_ENV fallback after self-host migration
  return env.APP_ENV === 'production' || env.VERCEL_ENV === 'production';
}
export const isProdEnv = isProdEnvFrom();
