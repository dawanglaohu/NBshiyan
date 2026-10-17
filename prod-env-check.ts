import { accessSync, constants as fsConstants, statSync } from 'fs';
import path from 'path';
import { isProdEnvFrom } from './src/lib/site';
import { dailyCapValid, smtpBaseConfig } from './src/lib/server/mail/config';
// 生产环境配置自检：
// - next.config 加载时执行（next build → 'build'，next start → 'runtime'）；
// - 自建 standalone（node server.js 不会重新执行 next.config）由 src/instrumentation.ts 在启动时按 'runtime' 再查一遍。
// 只在 APP_ENV=production 时生效，CI / 预览 / 本地不受影响。
const TRUTHY = /^(1|true|yes|on)$/i;

export function isProductionDeploy(env: Record<string, string | undefined>) {
  return isProdEnvFrom(env);
}

/**
 * build：`next build` 加载配置时；runtime：`next start` / standalone 启动时；any（默认）：两类都查。
 * build 阶段只查会被内联进构建产物的公开值（NEXT_PUBLIC_*、mock 开关），构建机不需要任何密钥或服务端配置；
 * 其余全部（密钥、数据库、存储、限流、发信）只在 runtime 检查，缺了拒绝启动。
 */
export type EnvCheckPhase = 'build' | 'runtime' | 'any';
/** 只在运行时读取、构建产物里不应出现的密钥（构建后 grep .next/ 验证用；其他服务端变量同样只在 runtime 检查） */
export const RUNTIME_ONLY = ['EDGE_AUTH_SECRET', 'SMTP_USER', 'SMTP_PASS', 'MAIL_WEBHOOK_SECRET'] as const;

export type EnvCheckDeps = {
  /** STORAGE_DRIVER=local 时检查 UPLOAD_DIR：返回问题描述（不含路径）或 null。默认用 fs 检查存在、是目录、可读写 */
  dirProblem?: (dir: string) => string | null;
  /** 应用根目录（standalone 下就是 server.js 所在目录），用来拒绝 public/、.next/ 下的上传目录 */
  cwd?: string;
};

export function prodEnvProblems(env: Record<string, string | undefined>, phase: EnvCheckPhase = 'any', deps: EnvCheckDeps = {}): string[] {
  if (!isProductionDeploy(env)) return [];
  const problems = publicProblems(env);
  if (phase !== 'build') {
    if (env.RATE_LIMIT_STORE !== 'upstash') problems.push(`RATE_LIMIT_STORE 必须为 "upstash"（当前：${env.RATE_LIMIT_STORE ?? '未设置'}），多实例下内存限流无效`);
    for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) if (!env[k]?.trim()) problems.push(`${k} 未设置`);
    if (env.UPSTASH_REDIS_REST_URL && !/^https:\/\//.test(env.UPSTASH_REDIS_REST_URL)) problems.push('UPSTASH_REDIS_REST_URL 必须是 https 地址');
    problems.push(...mailProblems(env), ...storageProblems(env, deps), ...secretProblems(env), ...runtimeSecretProblems(env));
  }
  return problems.sort();
}

// 会被内联进构建产物的公开值和 mock 开关：next build 时就要对（构建后改环境变量也改不了产物）
function publicProblems(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const v = (k: string) => env[k]?.trim() ?? '';
  for (const [k, val] of Object.entries(env)) {
    if (/^NEXT_PUBLIC_.*_MOCK$/.test(k) && val && TRUTHY.test(val.trim())) out.push(`${k}=${val}：生产环境不能开 mock`);
  }
  if (env.NEXT_PUBLIC_ADMIN_MAIL === 'mock') out.push('NEXT_PUBLIC_ADMIN_MAIL=mock：生产环境不能用邮件示例数据（#74）');
  if (env.NEXT_PUBLIC_ADMIN_API !== 'http') out.push(`NEXT_PUBLIC_ADMIN_API 必须为 "http"（当前：${env.NEXT_PUBLIC_ADMIN_API ?? '未设置'}）`);
  for (const k of ['NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'NEXT_PUBLIC_SITE_URL']) if (!v(k)) out.push(`${k} 未设置`);
  if (TEST_TURNSTILE_SITE_KEY.test(v('NEXT_PUBLIC_TURNSTILE_SITE_KEY'))) out.push('NEXT_PUBLIC_TURNSTILE_SITE_KEY 是 Cloudflare 测试 site key，生产必须用真实 key');
  const site = v('NEXT_PUBLIC_SITE_URL');
  if (site && !/^https:\/\//.test(site)) out.push('NEXT_PUBLIC_SITE_URL 必须是 https 地址');
  else if (site && !publicSiteHostOk(site)) out.push('NEXT_PUBLIC_SITE_URL 必须是正式域名（不能是 localhost / 127.0.0.1 / ::1 / 0.0.0.0 / *.localhost，也不能是无效地址）');
  return out;
}

/** 正式站点地址的主机名：不能是本机 / 回环 / 未指定地址（canonical、sitemap、邮件链接都用它，构建时内联） */
export function publicSiteHostOk(site: string): boolean {
  let host: string;
  try { host = new URL(site).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '0.0.0.0' || host === '[::1]' || host === '[::]' || /^127(\.\d{1,3}){3}$/.test(host)) return false;
  return true;
}

/**
 * 私有文件存储（只在 runtime 检查）：
 * - r2：R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY、R2_BUCKET 必填（与之前一致）
 * - local：UPLOAD_DIR 必须是规范的绝对路径（不能是 /、不能含 ..），不能在 public/ 或 .next/ 下（否则可能被静态服务），必须存在且可读写
 * 只报变量名和原因，不输出路径或任何值。
 */
export function storageProblems(env: Record<string, string | undefined>, deps: EnvCheckDeps = {}): string[] {
  const driver = env.STORAGE_DRIVER?.trim();
  if (driver === 'r2') return ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter((k) => !env[k]?.trim()).map((k) => `${k} 未设置`);
  if (driver !== 'local') return ['STORAGE_DRIVER 必须为 "local"（挂载的数据卷）或 "r2"'];
  const dir = env.UPLOAD_DIR?.trim() ?? '';
  if (!dir) return ['UPLOAD_DIR 未设置（STORAGE_DRIVER=local 时必填，指向挂载的数据卷目录）'];
  if (!path.posix.isAbsolute(dir) || dir.includes('\0')) return ['UPLOAD_DIR 必须是绝对路径'];
  const norm = path.posix.normalize(dir).replace(/\/+$/, '');
  if (!norm || norm === '/' || dir.split('/').includes('..') || norm !== dir.replace(/\/+$/, '')) return ['UPLOAD_DIR 必须是规范的绝对路径（不能是 /，不能含 . 或 .. 段）'];
  const cwd = path.resolve(deps.cwd ?? process.cwd());
  for (const pub of ['public', '.next']) {
    const p = path.join(cwd, pub);
    if (norm === p || norm.startsWith(p + '/')) return [`UPLOAD_DIR 不能在应用的 ${pub}/ 目录下（会被静态服务）`];
  }
  const fsProblem = (deps.dirProblem ?? defaultDirProblem)(norm);
  return fsProblem ? [`UPLOAD_DIR ${fsProblem}`] : [];
}

function defaultDirProblem(dir: string): string | null {
  try {
    if (!statSync(dir).isDirectory()) return '不是目录';
    accessSync(dir, fsConstants.R_OK | fsConstants.W_OK);
    return null;
  } catch {
    return '不存在或当前用户不可读写';
  }
}

// #74 发信（§16 Gmail SMTP）：只报变量名和原因，不输出任何值
function mailProblems(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  // 生产环境必须显式 MAIL_SEND_ADAPTER=smtp：未设置、mock、log 或其他任何值都拒绝启动
  if ((env.MAIL_SEND_ADAPTER ?? '').trim() !== 'smtp') out.push('MAIL_SEND_ADAPTER：生产环境必须设置为 smtp（未设置 / mock / log 都不允许）');
  if (!dailyCapValid(env)) out.push('MAIL_DAILY_CAP 必须是 1–100000 的整数（默认 450）');
  if (env.MAIL_DAILY_CAP_RESET && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(env.MAIL_DAILY_CAP_RESET.trim())) out.push('MAIL_DAILY_CAP_RESET 必须是 HH:MM（UTC）');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') out.push('NODE_TLS_REJECT_UNAUTHORIZED=0：不能关闭证书校验');
  // MAIL_WEBHOOK_SECRET / SMTP_USER / SMTP_PASS 是只在运行时用的密钥（RUNTIME_ONLY），由 runtimeSecretProblems 在 next start 时检查。
  // SMTP_HOST / SMTP_PORT / MAIL_FROM 缺失由 secretProblems 的必填项报；这里只查配了但不安全 / 不合规（端口、证书校验、From 用了 REPLY_DOMAIN）。
  // 构建时没有账号密码也要能查端口和 From，所以缺的账号密码用占位值代入（占位值只用于这次格式校验，不是密钥）。
  if (['SMTP_HOST', 'SMTP_PORT', 'MAIL_FROM'].every((k) => env[k]?.trim())) {
    const c = smtpBaseConfig({ ...env, SMTP_USER: env.SMTP_USER || 'placeholder', SMTP_PASS: env.SMTP_PASS || 'placeholder', NODE_TLS_REJECT_UNAUTHORIZED: undefined }); // 证书校验开关上面单独报
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
  // R2_* 改由 storageProblems 按 STORAGE_DRIVER 检查
  const required = ['DATABASE_URL', 'AUTH_SECRET', 'AUTH_URL',
    'ADMIN_TOTP_KEY', 'PRIVACY_HASH_SECRET', 'CRON_SECRET', 'TURNSTILE_SECRET_KEY',
    'SMTP_HOST', 'SMTP_PORT', 'MAIL_FROM', 'INQUIRY_NOTIFY_EMAIL'];
  for (const k of required) if (!v(k)) out.push(`${k} 未设置`);
  const totp = v('ADMIN_TOTP_KEY');
  if (totp && Buffer.from(totp, 'base64').length !== 32) out.push('ADMIN_TOTP_KEY 必须是 base64 解码后 32 字节');
  const ph = env.PRIVACY_HASH_SECRET;
  if (ph && Buffer.byteLength(ph) < 32) out.push('PRIVACY_HASH_SECRET 至少 32 字节');
  const cron = env.CRON_SECRET;
  if (cron && cron.length < 32) out.push('CRON_SECRET 至少 32 个字符');
  if (TEST_TURNSTILE_SECRET.test(v('TURNSTILE_SECRET_KEY'))) out.push('TURNSTILE_SECRET_KEY 是 Cloudflare 测试密钥，生产必须用真实密钥');
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
  // #74 发信账号（Gmail SMTP）：只在运行时读取，构建机不放
  for (const k of ['SMTP_USER', 'SMTP_PASS']) if (!env[k]?.trim()) out.push(`${k} 未设置`);
  // 收信 webhook 密钥：缺失或少于 32 字节都拒绝启动（与 config.webhookSecret 的运行时判断一致）
  if (Buffer.byteLength(env.MAIL_WEBHOOK_SECRET ?? '') < 32) out.push('MAIL_WEBHOOK_SECRET：必须设置且至少 32 字节');
  return out;
}

export function assertProdEnv(env: Record<string, string | undefined> = process.env, phase: EnvCheckPhase = 'any', deps: EnvCheckDeps = {}) {
  const p = prodEnvProblems(env, phase, deps);
  if (p.length) throw new Error(`生产环境配置检查未通过：\n- ${p.join('\n- ')}`);
}
