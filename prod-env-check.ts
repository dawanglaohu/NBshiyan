import { isProdEnvFrom } from './src/lib/site';
// 生产环境配置自检：在 next.config 加载时执行（next build 和 next start 都会加载），
// 只在 APP_ENV=production 时生效，CI / 预览 / 本地不受影响。
const TRUTHY = /^(1|true|yes|on)$/i;

export function isProductionDeploy(env: Record<string, string | undefined>) {
  return isProdEnvFrom(env);
}

/**
 * build：`next build` 加载配置时；runtime：`next start` 加载配置时；any（默认）：两类都查。
 * 只在运行时使用的密钥（RUNTIME_ONLY）构建时不检查，构建机可以不放这些值；`next start` 时缺了照样拒绝启动。
 */
export type EnvCheckPhase = 'build' | 'runtime' | 'any';
/** 只在运行时读取、构建产物里不应出现的密钥 */
export const RUNTIME_ONLY = ['EDGE_AUTH_SECRET'] as const;

export function prodEnvProblems(env: Record<string, string | undefined>, phase: EnvCheckPhase = 'any'): string[] {
  if (!isProductionDeploy(env)) return [];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (/^NEXT_PUBLIC_.*_MOCK$/.test(k) && v && TRUTHY.test(v.trim())) problems.push(`${k}=${v}：生产环境不能开 mock`);
  }
  if (env.NEXT_PUBLIC_ADMIN_MAIL === 'mock') problems.push('NEXT_PUBLIC_ADMIN_MAIL=mock：生产环境不能用邮件示例数据（#74）');
  if (env.NEXT_PUBLIC_ADMIN_API !== 'http') problems.push(`NEXT_PUBLIC_ADMIN_API 必须为 "http"（当前：${env.NEXT_PUBLIC_ADMIN_API ?? '未设置'}）`);
  if (env.RATE_LIMIT_STORE !== 'upstash') problems.push(`RATE_LIMIT_STORE 必须为 "upstash"（当前：${env.RATE_LIMIT_STORE ?? '未设置'}），多实例下内存限流无效`);
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) if (!env[k]?.trim()) problems.push(`${k} 未设置`);
  if (env.UPSTASH_REDIS_REST_URL && !/^https:\/\//.test(env.UPSTASH_REDIS_REST_URL)) problems.push('UPSTASH_REDIS_REST_URL 必须是 https 地址');
  problems.push(...secretProblems(env), ...(phase === 'build' ? [] : runtimeSecretProblems(env)));
  return problems.sort();
}

const TEST_TURNSTILE_SECRET = /^[123]x0{30,}AA$/;
const TEST_TURNSTILE_SITE_KEY = /^[123]x0{20,}[A-Z]{2}$/;

// 只报变量名和原因，不输出任何值
function secretProblems(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const v = (k: string) => env[k]?.trim() ?? '';
  const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'DATABASE_URL', 'AUTH_SECRET', 'AUTH_URL',
    'ADMIN_TOTP_KEY', 'PRIVACY_HASH_SECRET', 'CRON_SECRET', 'TURNSTILE_SECRET_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    'RESEND_API_KEY', 'MAIL_FROM', 'INQUIRY_NOTIFY_EMAIL', 'NEXT_PUBLIC_SITE_URL'];
  for (const k of required) if (!v(k)) out.push(`${k} 未设置`);
  if (env.STORAGE_DRIVER !== 'r2') out.push('STORAGE_DRIVER 必须为 "r2"，生产环境不能用本地磁盘');
  const totp = v('ADMIN_TOTP_KEY');
  if (totp && Buffer.from(totp, 'base64').length !== 32) out.push('ADMIN_TOTP_KEY 必须是 base64 解码后 32 字节');
  const ph = env.PRIVACY_HASH_SECRET;
  if (ph && Buffer.byteLength(ph) < 32) out.push('PRIVACY_HASH_SECRET 至少 32 字节');
  const cron = env.CRON_SECRET;
  if (cron && cron.length < 32) out.push('CRON_SECRET 至少 32 个字符');
  if (TEST_TURNSTILE_SECRET.test(v('TURNSTILE_SECRET_KEY'))) out.push('TURNSTILE_SECRET_KEY 是 Cloudflare 测试密钥，生产必须用真实密钥');
  if (TEST_TURNSTILE_SITE_KEY.test(v('NEXT_PUBLIC_TURNSTILE_SITE_KEY'))) out.push('NEXT_PUBLIC_TURNSTILE_SITE_KEY 是 Cloudflare 测试 site key，生产必须用真实 key');
  const site = v('NEXT_PUBLIC_SITE_URL');
  if (site && !/^https:\/\//.test(site)) out.push('NEXT_PUBLIC_SITE_URL 必须是 https 地址');
  if (v('ADMIN_SEED_TOTP_SECRET')) out.push('ADMIN_SEED_TOTP_SECRET 只用于 CI，生产必须留空');
  return out;
}

// 只在运行时检查（构建时跳过）。只报变量名和原因，不输出值。
function runtimeSecretProblems(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  // geiom.com：nginx 用 X-Edge-Auth 带这个密钥，缺了所有请求都按不可信来源处理
  const edge = env.EDGE_AUTH_SECRET;
  if (!edge?.trim()) out.push('EDGE_AUTH_SECRET 未设置');
  else if (Buffer.byteLength(edge) < 32) out.push('EDGE_AUTH_SECRET 至少 32 字节（否则所有请求都按不可信来源限流）');
  return out;
}

export function assertProdEnv(env: Record<string, string | undefined> = process.env, phase: EnvCheckPhase = 'any') {
  const p = prodEnvProblems(env, phase);
  if (p.length) throw new Error(`生产环境配置检查未通过：\n- ${p.join('\n- ')}`);
}
