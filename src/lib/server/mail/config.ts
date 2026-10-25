import { isProdEnvFrom } from '../../site';

/**
 * #74 邮件后端配置（只从环境变量读；仓库、测试、日志里只出现变量名）。
 *
 * 邮件开关沿用 #303 的 NEXT_PUBLIC_ADMIN_MAIL：只有 `http`（真实接口）时后端邮件接口才存在；
 * 未设置 / 空 / `off` / `mock` / 其他值一律按关闭处理（mock 只在前端替换数据，从不调用这些接口）。
 * 关闭时所有 /api/admin/mail/* 和收信 webhook 返回 404 not_found（与 /admin/mail/* 页面的 notFound() 一致）。
 */
type Env = Record<string, string | undefined>;

export function mailApiEnabled(env: Env = process.env): boolean {
  return env.NEXT_PUBLIC_ADMIN_MAIL === 'http';
}

export const MAX_RETRIES = 5;
export const DEFAULT_DAILY_CAP = 450;

/** §16 / §17：每日发信上限，MAIL_DAILY_CAP（正整数，默认 450；非法值回到默认值并在 prod-env-check 报错） */
export function dailyCap(env: Env = process.env): number {
  const raw = env.MAIL_DAILY_CAP?.trim();
  if (!raw) return DEFAULT_DAILY_CAP;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : DEFAULT_DAILY_CAP;
}
export function dailyCapValid(env: Env = process.env) {
  const raw = env.MAIL_DAILY_CAP?.trim();
  if (!raw) return true;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100_000;
}

/** MAIL_DAILY_CAP_RESET：每日重置时间（UTC，HH:MM，默认 00:00） → 当天的分钟偏移 */
export function capResetMinutes(env: Env = process.env): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(env.MAIL_DAILY_CAP_RESET?.trim() ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** 当前发信日窗口 [start, end)：end 即下一次重置时间（= deferredUntil） */
export function capWindow(now: Date, env: Env = process.env): { start: Date; end: Date } {
  const off = capResetMinutes(env) * 60_000;
  const DAY = 86_400_000;
  const startMs = Math.floor((now.getTime() - off) / DAY) * DAY + off;
  return { start: new Date(startMs), end: new Date(startMs + DAY) };
}

/** 每管理员 / 全局每小时发信次数（§7） */
export function mailRateLimits(env: Env = process.env) {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isInteger(x) && x > 0 ? x : d; };
  return { admin: n(env.MAIL_RATE_ADMIN_PER_HOUR, 30), global: n(env.MAIL_RATE_GLOBAL_PER_HOUR, 200) };
}

const ADDR_RE = /^[^\s@<>"',;:\\]+@([^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+)$/;
const CTL_RE = /[\r\n\0]/;

/** "Name <addr@x>" 或 "addr@x" → { name, address }；含 CR/LF/NUL 或格式不对返回 null */
export function parseMailbox(v: string | undefined): { name: string; address: string } | null {
  if (!v || CTL_RE.test(v)) return null;
  const s = v.trim();
  const m = /^(.*)<([^<>]+)>$/.exec(s);
  const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1') : '';
  const address = (m ? m[2] : s).trim();
  if (!ADDR_RE.test(address) || name.length > 100 || /[<>"]/.test(name)) return null;
  return { name, address };
}

export type SmtpBaseConfig = {
  host: string; port: 465 | 587; secure: boolean; requireTLS: boolean;
  user: string; pass: string;
  from: { name: string; address: string };
};
export type SmtpConfig = SmtpBaseConfig & { replyDomain: string };
export type SmtpConfigError =
  | 'missing' // SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM（回复询盘另需 REPLY_DOMAIN）有缺
  | 'insecure_tls' // 端口不是 465（SMTPS）或 587（STARTTLS 强制），或关闭了证书校验
  | 'bad_from' // MAIL_FROM 格式不对，或用了 REPLY_DOMAIN 的地址（§16：From 必须是 Gmail 地址）
  | 'bad_reply_domain';

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * §16 SMTP 连接配置（Gmail SMTP），所有发信（询盘回复、自动回复、通知、告警）共用。TLS 强制：
 * - 465 → secure:true（隐式 TLS）
 * - 587 → secure:false + requireTLS:true（STARTTLS 失败即中止，不降级明文）
 * - 其他端口、或进程设了 NODE_TLS_REJECT_UNAUTHORIZED=0 → insecure_tls，发信关闭
 * 从不设置 rejectUnauthorized:false（证书校验始终开启）。
 */
export function smtpBaseConfig(env: Env = process.env): { ok: true; cfg: SmtpBaseConfig } | { ok: false; error: SmtpConfigError } {
  const host = env.SMTP_HOST?.trim(), portRaw = env.SMTP_PORT?.trim(), user = env.SMTP_USER, pass = env.SMTP_PASS;
  if (!host || !portRaw || !user || !pass || !env.MAIL_FROM) return { ok: false, error: 'missing' };
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return { ok: false, error: 'insecure_tls' };
  const port = Number(portRaw);
  if (port !== 465 && port !== 587) return { ok: false, error: 'insecure_tls' };
  if (!DOMAIN_RE.test(host)) return { ok: false, error: 'missing' };
  const from = parseMailbox(env.MAIL_FROM);
  if (!from) return { ok: false, error: 'bad_from' };
  const replyDomain = env.REPLY_DOMAIN?.trim().toLowerCase();
  const fromDomain = from.address.split('@')[1].toLowerCase();
  if (replyDomain && (fromDomain === replyDomain || fromDomain.endsWith(`.${replyDomain}`))) return { ok: false, error: 'bad_from' };
  return { ok: true, cfg: { host, port, secure: port === 465, requireTLS: port === 587, user, pass, from } };
}

/** 询盘回复（8.1）用：在连接配置之外还需要 REPLY_DOMAIN（Reply-To = reply+<token>@REPLY_DOMAIN，Message-ID 域名） */
export function smtpConfig(env: Env = process.env): { ok: true; cfg: SmtpConfig } | { ok: false; error: SmtpConfigError } {
  const base = smtpBaseConfig(env);
  if (!base.ok) return base;
  const replyDomain = env.REPLY_DOMAIN?.trim().toLowerCase();
  if (!replyDomain) return { ok: false, error: 'missing' };
  if (!DOMAIN_RE.test(replyDomain)) return { ok: false, error: 'bad_reply_domain' };
  return { ok: true, cfg: { ...base.cfg, replyDomain } };
}

/** §15 补充 / §16：发信是否可用 = 邮件开关为 http 且 SMTP 配置完整、安全 */
export function sendingEnabled(env: Env = process.env): boolean {
  return mailApiEnabled(env) && smtpConfig(env).ok;
}

/**
 * 发信适配器：MAIL_SEND_ADAPTER=mock 只在 APP_ENV 去空白后非空、且不是 production 时生效。
 * APP_ENV 未设置时关闭。APP_ENV=production 时关闭（prod-env-check 也会拒绝 mock）。VERCEL_ENV 不参与。
 */
export function mockAdapterAllowed(env: Env = process.env): boolean {
  if (env.MAIL_SEND_ADAPTER !== 'mock') return false;
  const appEnv = env.APP_ENV?.trim();
  return !!appEnv && !isProdEnvFrom(env);
}

/** 收信 webhook 密钥（§4.0）：≥32 字节；没配或太短 → webhook 不启用（404） */
export function webhookSecret(env: Env = process.env): string | null {
  const s = env.MAIL_WEBHOOK_SECRET;
  return s && Buffer.byteLength(s) >= 32 ? s : null;
}
