// #347 方案 A：CLI（admin-create.mjs、create-admin.mjs）签发一次性绑定令牌。不依赖 TypeScript 源码，standalone 镜像里可直接运行。
// 规则与 src/lib/server/admin/enroll-token.ts 相同（单测 tests/admin-enroll-token-347.test.ts 校验两边一致）：
//   32 字节 CSPRNG → base64url；库里只存 sha256(令牌) 的 hex；有效期 = min(签发后 24 小时, 72 小时绑定窗口截止)。
// 明文令牌只在 stdout 打印一次（给运行脚本的人），不进日志、审计或异常信息。
import { createHash, randomBytes } from 'node:crypto';

export const ENROLL_TOKEN_TTL_MS = 24 * 3_600_000;
export const ENROLL_WINDOW_MS = 72 * 3_600_000;
export const ENROLL_PAGE = '/admin-enroll';

export const hashEnrollToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/** windowStart：绑定窗口起点（新建账号 = 现在） */
export function newEnrollToken(now = Date.now(), windowStart = now) {
  const token = randomBytes(32).toString('base64url');
  const windowEnd = windowStart + ENROLL_WINDOW_MS;
  const ttlEnd = now + ENROLL_TOKEN_TTL_MS;
  const expiresAt = new Date(Math.min(ttlEnd, windowEnd));
  return { token, data: { enrollTokenHash: hashEnrollToken(token), enrollTokenExpiresAt: expiresAt }, expiresAt, expiresTruncated: windowEnd < ttlEnd };
}

/** 链接前缀：NEXT_PUBLIC_SITE_URL（与应用一致），没有时用 APP_ORIGIN；都没有就只给相对路径，由运维自己拼域名 */
export function enrollLink(token, env = {}) {
  const base = String(env.NEXT_PUBLIC_SITE_URL || env.APP_ORIGIN || '').replace(/\/$/, '');
  return `${base}${ENROLL_PAGE}?t=${encodeURIComponent(token)}`;
}
