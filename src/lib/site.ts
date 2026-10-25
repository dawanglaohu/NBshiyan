export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/**
 * 是否正式生产环境：只认 APP_ENV === 'production'。
 * 未设置、VERCEL_ENV、NODE_ENV 以及其他值都不是生产（整站 noindex、关闭 IndexNow）。
 */
export function isProdEnvFrom(env: Record<string, string | undefined> = process.env): boolean {
  return env.APP_ENV === 'production';
}
export const isProdEnv = isProdEnvFrom();
