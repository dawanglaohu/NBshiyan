import type { User } from '@prisma/client';
import { prisma } from '../db';
import { hitRateLimit, rateLimitSubject } from '../security';
import { audit } from './audit';

/**
 * 登录前 2FA 绑定（/api/auth-admin/enroll、/enroll/confirm）的加固（#347、#348）。接口的请求、响应和错误码都不变（#353 绑定页不用改）。
 *
 * #347（方案 C：绑定窗口 + 待确认密钥不可覆盖）
 * - 绑定窗口：起点 = enrollIssuedAt（重置 2FA 时写入）或 createdAt（新建账号），72 小时后 enroll/confirm 都拒绝（bad_credentials），需 ADMIN 重置 2FA。
 * - 待确认密钥有效 10 分钟（totpPendingUntil）；有效期内再调 enroll 返回 429 rate_limited，不会换掉别人正在扫的密钥。过期后可以重新 enroll。
 *
 * #348（只按账号、只统计「密码已通过」的错码）
 * - confirm 时密码正确但 6 位码错 → totpEnrollFails+1。同一个待确认密钥上错满 5 次 → 作废密钥（totpSecret 清空），
 *   返回 401 enroll_reset（新错误码，只在密码正确时出现）；之后 confirm 也返回 enroll_reset，直到重新 enroll。
 *   作废后冷却 10 分钟（totpPendingUntil = now+10min），期间 enroll 返回 429 rate_limited，之后可以重新 enroll 拿新密钥。
 * - 密码错的请求不计入、也不会作废密钥：否则不知道密码的人也能反复作废别人的待确认密钥（定向骚扰）。密码错仍按原来的登录限流和锁定处理。
 * - 绑定成功或发新密钥时清零。审计不记邮箱明文、密钥和验证码。
 */
export const ENROLL_WINDOW_MS = 72 * 3_600_000;
export const ENROLL_PENDING_MS = 10 * 60_000;
export const ENROLL_MAX_BAD_TOTP = 5;
export const ENROLL_IP_LIMIT = 20;
export const ENROLL_IP_WINDOW_MS = 10 * 60_000;

type EnrollUser = Pick<User, 'createdAt' | 'enrollIssuedAt' | 'totpPendingUntil' | 'totpSecret'>;

/** 绑定窗口是否还开着（#347） */
export const enrollWindowOpen = (u: EnrollUser, now = Date.now()) => now < (u.enrollIssuedAt ?? u.createdAt).getTime() + ENROLL_WINDOW_MS;
/** 是否在冷却期内（有待确认密钥，或刚被作废）：此时不允许再次 enroll */
export const enrollCoolingDown = (u: EnrollUser, now = Date.now()) => !!u.totpPendingUntil && u.totpPendingUntil.getTime() > now;
/** 是否有可以确认的待确认密钥（旧数据里没有有效期的密钥视为已过期，需重新 enroll） */
export const pendingSecretUsable = (u: EnrollUser, now = Date.now()) => !!u.totpSecret && enrollCoolingDown(u, now);

/** 两个绑定接口单独的按 IP 限流（与登录限流分开计数），在解析请求体之前调用。存储故障时拒绝。 */
export const enrollIpRateOk = (route: 'enroll' | 'confirm', ip: string | null) =>
  hitRateLimit(`enroll-ip:${route}:${rateLimitSubject(ip)}`, ENROLL_IP_LIMIT, ENROLL_IP_WINDOW_MS, { onStoreError: 'closed' });

/** 发新的待确认密钥时要写的字段 */
export const pendingSecretData = (encryptedSecret: string, now = Date.now()) => ({
  totpSecret: encryptedSecret, totpLastStep: null, totpPendingUntil: new Date(now + ENROLL_PENDING_MS), totpEnrollFails: 0,
});

/**
 * 记一次「密码正确、6 位码错」。错满上限就作废这个待确认密钥并开始冷却。
 * 只在当前密钥没变时作废（条件更新），返回是否已作废。
 */
export async function recordBadEnrollTotp(user: Pick<User, 'id' | 'totpSecret'>, ip: string | null) {
  const { totpEnrollFails: n } = await prisma.user.update({ where: { id: user.id }, data: { totpEnrollFails: { increment: 1 } }, select: { totpEnrollFails: true } });
  if (n < ENROLL_MAX_BAD_TOTP) {
    await audit({ actorId: user.id, action: 'auth.totp_enroll_fail', target: user.id, meta: { reason: 'bad_totp', fails: n }, ip });
    return false;
  }
  const r = await prisma.user.updateMany({
    where: { id: user.id, totpEnabled: false, totpSecret: user.totpSecret },
    data: { totpSecret: null, totpLastStep: null, totpEnrollFails: 0, totpPendingUntil: new Date(Date.now() + ENROLL_PENDING_MS) },
  });
  await audit({ actorId: user.id, action: 'auth.totp_enroll_voided', target: user.id, meta: { reason: 'too_many_bad_totp', fails: n, voided: r.count === 1 }, ip });
  return true;
}
