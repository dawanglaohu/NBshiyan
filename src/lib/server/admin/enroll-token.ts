import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { User } from '@prisma/client';
import { isProdEnvFrom } from '@/lib/site';
import { ENROLL_PAGE } from '@/lib/admin/enroll';
import { ENROLL_WINDOW_MS } from './enroll-guard';
import { audit } from './audit';
import { recordFailedLogin } from './login';

/**
 * #347 方案 A：一次性绑定令牌（只知道初始密码不能开始或完成 2FA 绑定）。
 * - 令牌：32 字节 CSPRNG，base64url（43 字符）。库里只存 sha256(令牌) 的 hex（全栈定：令牌本身是 256 bit 随机数，不需要 HMAC/慢哈希）。
 * - 有效期 = min(签发后 24 小时, 账号 72 小时绑定窗口截止)；被窗口截短时 expiresTruncated=true（UX v1.0.1）。
 * - 签发点：后台新建账号、后台重置他人 2FA、自助重置 2FA、CLI（admin-create / seed）。每次签发覆盖旧哈希，旧令牌立即失效。
 * - enroll / confirm 必须带 token：同源 → IP 限流 → 密码 → 令牌（常量时间比较哈希 + 未过期）。缺失/错误/过期/已用过一律 401 bad_credentials，
 *   与密码错完全一样；令牌不对时也不退回登录桶（否则“密码对、令牌错”会在限流上和“密码错”不一样，变成判断密码是否正确的旁路）。
 * - confirm 成功时用条件 UPDATE（where 带当前哈希且未过期）在同一条语句里开启 2FA 并清掉哈希和截止时间：令牌只能用一次。enroll 成功不消耗令牌。
 * - 令牌明文只出现在签发接口的响应体里（一次），不进日志、审计、错误上报、URL 以外的任何地方。
 */
export const ENROLL_TOKEN_BYTES = 32;
export const ENROLL_TOKEN_TTL_MS = 24 * 3_600_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export const hashEnrollToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

type WindowUser = Pick<User, 'createdAt' | 'enrollIssuedAt'>;
type TokenUser = Pick<User, 'enrollTokenHash' | 'enrollTokenExpiresAt'>;

export type IssuedEnrollToken = {
  /** 明文令牌：只用来拼 enrollLink，不要单独返回、记录或审计 */
  token: string;
  /** 要写进 User 的字段（与重置 2FA / 建号放在同一次写入里） */
  data: { enrollTokenHash: string; enrollTokenExpiresAt: Date };
  expiresAt: Date;
  expiresTruncated: boolean;
};

/** 生成新令牌。windowStart 为空时按 now（新建账号：createdAt≈now；重置 2FA：enrollIssuedAt=now） */
export function newEnrollToken(u: Partial<WindowUser> = {}, now = Date.now()): IssuedEnrollToken {
  const token = randomBytes(ENROLL_TOKEN_BYTES).toString('base64url');
  const windowEnd = (u.enrollIssuedAt ?? u.createdAt ?? new Date(now)).getTime() + ENROLL_WINDOW_MS;
  const ttlEnd = now + ENROLL_TOKEN_TTL_MS;
  const expiresAt = new Date(Math.min(ttlEnd, windowEnd));
  return { token, data: { enrollTokenHash: hashEnrollToken(token), enrollTokenExpiresAt: expiresAt }, expiresAt, expiresTruncated: windowEnd < ttlEnd };
}

/**
 * 绑定链接的站点前缀：只取 NEXT_PUBLIC_SITE_URL（构建时内联，与后台邮件链接同一来源），从不用请求的 Host。不合格返回 null，签发接口在写库之前就 500 拒绝。
 * 必须是裸 origin（无账号密码、路径、查询、fragment）；https，或非生产（APP_ENV/VERCEL_ENV 不是 production）下的 http://localhost / http://127.0.0.1。
 * 与 scripts/enroll-token-lib.mjs enrollLinkBase 相同（单测对比）。生产启动时 prod-env-check 也要求 https 正式域名。
 */
export function enrollLinkBase(env: Record<string, string | undefined> = { NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL, APP_ENV: process.env.APP_ENV, VERCEL_ENV: process.env.VERCEL_ENV }): string | null {
  const raw = String(env.NEXT_PUBLIC_SITE_URL ?? '').trim();
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (raw.replace(/\/$/, '') !== u.origin) return null;
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && !isProdEnvFrom(env) && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.origin;
  return null;
}

/** 绑定页链接。令牌放在 fragment（#t=）：浏览器不会把它发给服务器，不进访问日志、CDN 日志和 Referer；页面打开后立即 replaceState 去掉 */
export const enrollLink = (token: string, base: string) => `${base}${ENROLL_PAGE}#t=${encodeURIComponent(token)}`;

/** 签发接口响应里追加的字段：只在这一次响应里出现。base 必须来自 enrollLinkBase() */
export const issueResponse = (t: IssuedEnrollToken, base: string) => ({ enrollLink: enrollLink(t.token, base), expiresAt: t.expiresAt.toISOString(), expiresTruncated: t.expiresTruncated });

export type EnrollTokenCheck = 'ok' | 'missing' | 'invalid' | 'expired';

/**
 * 校验令牌。总是计算哈希并做一次 timingSafeEqual（库里没有哈希时与全零比较），耗时不随“有没有令牌 / 前缀对不对”变化。
 * 已用过（confirm 成功后哈希被清空）和被新令牌覆盖的都归为 invalid。
 */
export function checkEnrollToken(u: TokenUser, token: string | undefined | null, now = Date.now()): EnrollTokenCheck {
  if (!token) return 'missing';
  const given = createHash('sha256').update(token, 'utf8').digest();
  const stored = u.enrollTokenHash && HASH_RE.test(u.enrollTokenHash) ? Buffer.from(u.enrollTokenHash, 'hex') : null;
  const eq = timingSafeEqual(given, stored ?? Buffer.alloc(32));
  if (!stored || !eq || !TOKEN_RE.test(token)) return 'invalid';
  if (!u.enrollTokenExpiresAt || u.enrollTokenExpiresAt.getTime() <= now) return 'expired';
  return 'ok';
}

/** 审计：签发。只记操作者、目标账号 id 和来源，不记令牌、哈希、链接或邮箱 */
export const auditTokenIssued = (actorId: string | null, targetId: string, source: 'admin_create' | 'admin_reset_2fa' | 'self_reset_2fa', ip: string | null, truncated: boolean) =>
  audit({ actorId, action: 'auth.enroll_token_issued', target: targetId, meta: { source, truncated }, ip });

/**
 * 密码正确、令牌不对时是否也计入 failedLogins（与错密码一样，满 5 次锁 15 分钟）。
 * 已定（PM 定、全栈同意）：计入，enroll 和 confirm 都与错密码完全一样（failedLogins+1，满 5 次锁 15 分钟、告警，审计 reason=bad_enroll_token）。
 * 要关掉只改这一行。
 */
export const WRONG_TOKEN_COUNTS_AS_FAILED_LOGIN = true;

/**
 * 令牌不对时的统一处理（enroll、confirm 共用）：审计 auth.enroll_token_rejected（reason 只有 missing / invalid / expired），
 * 开关打开时（现在打开）再按错密码的路径计入 failedLogins / 锁定（recordFailedLogin，审计 reason=bad_enroll_token）。调用方随后返回 401 bad_credentials，不退登录桶。
 */
export async function rejectEnrollToken(
  user: User, email: string, route: 'enroll' | 'confirm', reason: Exclude<EnrollTokenCheck, 'ok'>, ip: string | null,
  countsAsFailedLogin = WRONG_TOKEN_COUNTS_AS_FAILED_LOGIN,
) {
  await audit({ actorId: user.id, action: 'auth.enroll_token_rejected', target: user.id, meta: { reason, route }, ip });
  if (countsAsFailedLogin) await recordFailedLogin(user, email, ip, 'bad_enroll_token');
}

