// 生产环境配置自检：在 next.config 加载时执行（next build 和 next start 都会加载），
// 只在 Vercel 正式环境生效，CI / 预览 / 本地不受影响。
const TRUTHY = /^(1|true|yes|on)$/i;

export function isProductionDeploy(env: Record<string, string | undefined>) {
  return env.VERCEL_ENV === 'production' || (env.VERCEL === '1' && env.NODE_ENV === 'production' && !env.VERCEL_ENV);
}

export function prodEnvProblems(env: Record<string, string | undefined>): string[] {
  if (!isProductionDeploy(env)) return [];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (/^NEXT_PUBLIC_.*_MOCK$/.test(k) && v && TRUTHY.test(v.trim())) problems.push(`${k}=${v}：生产环境不能开 mock`);
  }
  if (env.NEXT_PUBLIC_ADMIN_API !== 'http') problems.push(`NEXT_PUBLIC_ADMIN_API 必须为 "http"（当前：${env.NEXT_PUBLIC_ADMIN_API ?? '未设置'}）`);
  if (env.RATE_LIMIT_STORE !== 'upstash') problems.push(`RATE_LIMIT_STORE 必须为 "upstash"（当前：${env.RATE_LIMIT_STORE ?? '未设置'}），多实例下内存限流无效`);
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) if (!env[k]?.trim()) problems.push(`${k} 未设置`);
  if (env.UPSTASH_REDIS_REST_URL && !/^https:\/\//.test(env.UPSTASH_REDIS_REST_URL)) problems.push('UPSTASH_REDIS_REST_URL 必须是 https 地址');
  return problems.sort();
}

export function assertProdEnv(env: Record<string, string | undefined> = process.env) {
  const p = prodEnvProblems(env);
  if (p.length) throw new Error(`生产环境配置检查未通过：\n- ${p.join('\n- ')}`);
}
