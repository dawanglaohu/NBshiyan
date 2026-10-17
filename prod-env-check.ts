import { isProdEnvFrom } from './src/lib/site';
import { dailyCapValid, smtpBaseConfig } from './src/lib/server/mail/config';
// 生产环境配置自检：在 next.config 加载时执行（next build 和 next start 都会加载），
// 只在 APP_ENV=production 时生效，CI / 预览 / 本地不受影响。
const TRUTHY = /^(1|true|yes|on)$/i;

export function isProductionDeploy(env: Record<string, string | undefined>) {
  return isProdEnvFrom(env);
}

export function prodEnvProblems(env: Record<string, string | undefined>): string[] {
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
  problems.push(...mailProblems(env));
  problems.push(...secretProblems(env));
  return problems.sort();
}

// #74 发信（§16 Gmail SMTP）：只报变量名和原因，不输出任何值
function mailProblems(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  // 生产环境必须显式 MAIL_SEND_ADAPTER=smtp：未设置、mock、log 或其他任何值都拒绝启动
  if ((env.MAIL_SEND_ADAPTER ?? '').trim() !== 'smtp') out.push('MAIL_SEND_ADAPTER：生产环境必须设置为 smtp（未设置 / mock / log 都不允许）');
  if (!dailyCapValid(env)) out.push('MAIL_DAILY_CAP 必须是 1–100000 的整数（默认 450）');
  if (env.MAIL_DAILY_CAP_RESET && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(env.MAIL_DAILY_CAP_RESET.trim())) out.push('MAIL_DAILY_CAP_RESET 必须是 HH:MM（UTC）');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') out.push('NODE_TLS_REJECT_UNAUTHORIZED=0：不能关闭证书校验');
  // 收信 webhook 密钥：缺失或少于 32 字节都拒绝启动（与 config.webhookSecret 的运行时判断一致）
  if (Buffer.byteLength(env.MAIL_WEBHOOK_SECRET ?? '') < 32) out.push('MAIL_WEBHOOK_SECRET：必须设置且至少 32 字节');
  // SMTP_* 缺失由 secretProblems 的必填项报；这里只查配了但不安全 / 不合规（端口、证书校验、From 用了 REPLY_DOMAIN）
  if (['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'].every((k) => env[k]?.trim())) {
    const c = smtpBaseConfig({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: undefined }); // 证书校验开关上面单独报
    if (!c.ok) out.push(`SMTP 发信配置无效（${c.error}）：SMTP_PORT 只能是 465 或 587，MAIL_FROM 必须是 Gmail 地址（不能是 REPLY_DOMAIN 的地址）`);
  }
  return out;
}

const TEST_TURNSTILE_SECRET = /^[123]x0{30,}AA$/;
const TEST_TURNSTILE_SITE_KEY = /^[123]x0{20,}[A-Z]{2}$/;

// 只报变量名和原因，不输出任何值
function secretProblems(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const v = (k: string) => env[k]?.trim() ?? '';
  const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'DATABASE_URL', 'AUTH_SECRET', 'AUTH_URL',
    'ADMIN_TOTP_KEY', 'PRIVACY_HASH_SECRET', 'CRON_SECRET', 'TURNSTILE_SECRET_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'INQUIRY_NOTIFY_EMAIL', 'NEXT_PUBLIC_SITE_URL'];
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

export function assertProdEnv(env: Record<string, string | undefined> = process.env) {
  const p = prodEnvProblems(env);
  if (p.length) throw new Error(`生产环境配置检查未通过：\n- ${p.join('\n- ')}`);
}
