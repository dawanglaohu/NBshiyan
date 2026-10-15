import { randomBytes } from 'crypto';
import { authenticator } from 'otplib';
import type { User } from '@prisma/client';
import { prisma } from '../db';
import { hitRateLimit } from '../security';
import { burnVerify, decrypt, hashSecret, verifySecret } from './crypto';
import { sendAdminAlert } from '../mail';
import { audit } from './audit';

authenticator.options = { window: 1, step: 30 };
export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60_000;

export type CheckFail = 'rate_limited' | 'bad_credentials' | 'locked' | 'totp_required' | 'totp_not_enrolled';

/** 登录限流（10 分钟窗口，三个桶都计数）：IP+账号 5 次、单账号 10 次（防换 IP 爆破）、单 IP 30 次（防撞库）。 */
export async function loginRateOk(ip: string | null, email: string) {
  const [a, b, c] = await Promise.all([
    hitRateLimit(`login:${ip ?? 'noip'}:${email}`, 5, 10 * 60_000),
    hitRateLimit(`login-acct:${email}`, 10, 10 * 60_000),
    hitRateLimit(`login-ip:${ip ?? 'noip'}`, 30, 10 * 60_000),
  ]);
  return a && b && c;
}

/** 让该账号所有现有会话失效。改密码、重置或关闭 2FA、禁用账号时必须调用。 */
export async function revokeSessions(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
}

async function fail(user: User | null, email: string, ip: string | null, reason: string) {
  if (user) {
    const n = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: n >= MAX_FAILS ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } : { failedLogins: n },
    });
    if (n >= MAX_FAILS) {
      await audit({ actorId: user.id, action: 'auth.lockout', ip });
      // 账号被锁定时告警（同一账号 30 分钟最多 1 封）；只发账号 id 和 IP，不含密码或验证码
      await sendAdminAlert('后台账号被锁定', { 账号ID: user.id, IP: ip ?? '未知', 锁定分钟: LOCK_MS / 60_000 }, `lockout:${user.id}`);
    }
  }
  await audit({ actorId: user?.id ?? null, action: 'auth.login_fail', target: email.slice(0, 200), meta: { reason }, ip });
}

/** 校验邮箱和密码，并检查锁定。成功返回 user。 */
export async function checkPassword(email: string, password: string, ip: string | null): Promise<User | CheckFail> {
  if (!(await loginRateOk(ip, email))) { await audit({ action: 'auth.login_fail', target: email.slice(0, 200), meta: { reason: 'rate_limited' }, ip }); return 'rate_limited'; }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.disabled) { await burnVerify(password); await fail(null, email, ip, 'bad_credentials'); return 'bad_credentials'; }
  if (user.lockedUntil && user.lockedUntil > new Date()) { await audit({ actorId: user.id, action: 'auth.login_fail', target: email, meta: { reason: 'locked' }, ip }); return 'locked'; }
  if (!(await verifySecret(user.passwordHash, password))) { await fail(user, email, ip, 'bad_password'); return 'bad_credentials'; }
  return user;
}

/** 校验 TOTP（拒绝重放）或恢复码（用后删除）。 */
export async function checkSecondFactor(user: User, totp: string | undefined, recovery: string | undefined): Promise<boolean> {
  if (!user.totpSecret) return false;
  if (totp && /^\d{6}$/.test(totp)) {
    const delta = authenticator.checkDelta(totp, decrypt(user.totpSecret));
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 30_000) + delta;
    // 条件更新：同一时间步的验证码只能用一次
    const r = await prisma.user.updateMany({
      where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    return r.count === 1;
  }
  if (recovery) {
    const code = recovery.replace(/[\s-]/g, '').toLowerCase();
    for (const h of user.recoveryCodes) {
      if (await verifySecret(h, code)) {
        const r = await prisma.user.updateMany({ where: { id: user.id, recoveryCodes: { has: h } }, data: { recoveryCodes: user.recoveryCodes.filter((x) => x !== h) } });
        return r.count === 1;
      }
    }
  }
  return false;
}

/** 完整登录校验，供 Auth.js Credentials 使用 */
export async function authorizeLogin(input: { email: string; password: string; totp?: string; recoveryCode?: string }, ip: string | null) {
  const email = input.email.trim().toLowerCase();
  const user = await checkPassword(email, input.password, ip);
  if (typeof user === 'string') return null;
  if (!user.totpEnabled) { await audit({ actorId: user.id, action: 'auth.login_fail', target: email, meta: { reason: 'totp_not_enrolled' }, ip }); return null; }
  if (!(await checkSecondFactor(user, input.totp, input.recoveryCode))) { await fail(user, email, ip, input.totp || input.recoveryCode ? 'bad_totp' : 'totp_missing'); return null; }
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  await audit({ actorId: user.id, action: 'auth.login_success', target: email, meta: { method: input.totp ? 'totp' : 'recovery_code' }, ip });
  return user;
}

export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => randomBytes(5).toString('hex')); // 10 位十六进制
}
export const hashCodes = (codes: string[]) => Promise.all(codes.map(hashSecret));
