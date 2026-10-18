// #347 方案 A：CLI（admin-create.mjs、create-admin.mjs、admin-reset-initial-password）签发一次性绑定令牌。不依赖 TypeScript 源码，standalone 镜像里可直接运行。
// 规则与 src/lib/server/admin/enroll-token.ts 相同（单测 tests/admin-enroll-token-347.test.ts 校验两边一致）：
//   32 字节 CSPRNG → base64url；库里只存 sha256(令牌) 的 hex；有效期 = min(签发后 24 小时, 72 小时绑定窗口截止)。
//   链接 = <NEXT_PUBLIC_SITE_URL>/admin-enroll#t=<令牌>（放在 fragment 里：不发给服务器、不进访问日志和 Referer）。
//   NEXT_PUBLIC_SITE_URL 必须是 https 裸 origin；只有非生产（APP_ENV/VERCEL_ENV 不是 production）允许 http://localhost、http://127.0.0.1。
// 明文令牌只在 stdout 是终端时打印一次（给运行脚本的人），不进日志、审计或异常信息。
import { createHash, randomBytes } from 'node:crypto';

export const ENROLL_TOKEN_TTL_MS = 24 * 3_600_000;
export const ENROLL_WINDOW_MS = 72 * 3_600_000;
export const ENROLL_PAGE = '/admin-enroll';
export const PRIVATE_HINT = '只私信发给本人，不要贴到群里或工单里';
export const TRUNCATED_HINT = '已按账号绑定截止时间缩短';

export const hashEnrollToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/** windowStart：绑定窗口起点（enrollIssuedAt ?? createdAt；新建账号 / 重新打开窗口 = 现在） */
export function newEnrollToken(now = Date.now(), windowStart = now) {
  const token = randomBytes(32).toString('base64url');
  const windowEnd = windowStart + ENROLL_WINDOW_MS;
  const ttlEnd = now + ENROLL_TOKEN_TTL_MS;
  const expiresAt = new Date(Math.min(ttlEnd, windowEnd));
  return { token, data: { enrollTokenHash: hashEnrollToken(token), enrollTokenExpiresAt: expiresAt }, expiresAt, expiresTruncated: windowEnd < ttlEnd };
}

const isProd = (env) => env.APP_ENV === 'production' || env.VERCEL_ENV === 'production';
/**
 * 绑定链接的站点前缀，只取 NEXT_PUBLIC_SITE_URL（从不用请求的 Host）。不合格返回 null：
 * 必须是裸 origin（无账号密码、路径、查询、fragment）；https，或非生产下的 http://localhost / http://127.0.0.1（可带端口）。
 */
export function enrollLinkBase(env = {}) {
  const raw = String(env.NEXT_PUBLIC_SITE_URL ?? '').trim();
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (raw.replace(/\/$/, '') !== u.origin) return null;
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && !isProd(env) && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.origin;
  return null;
}

/** base 必须来自 enrollLinkBase */
export const enrollLink = (token, base) => `${base}${ENROLL_PAGE}#t=${encodeURIComponent(token)}`;

/** 截止时间按太平洋时间显示：2026-10-19 06:20 PT */
export function formatPt(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} PT`;
}

/** UX 的三行：链接 / 有效至（被窗口截短时追加一句）/ 只私信给本人 */
export function linkLines(issued, base) {
  return [
    enrollLink(issued.token, base),
    `有效至 ${formatPt(issued.expiresAt)}${issued.expiresTruncated ? ` ${TRUNCATED_HINT}` : ''}`,
    PRIVATE_HINT,
  ].join('\n') + '\n';
}

/** 审计：只记来源和是否被截短，不含令牌、哈希、链接、邮箱 */
export const issuedAudit = (userId) => ({ actorId: null, action: 'auth.enroll_token_issued', target: userId, ip: null });
