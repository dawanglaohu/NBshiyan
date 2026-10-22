import { createHmac, randomBytes } from 'crypto';
import { authenticator } from 'otplib';
import type { User } from '@prisma/client';
import { prisma } from '../db';
import { hitRateLimit, rateLimitKeyHash, rateLimitSubject, refundRateLimit } from '../security';
import { burnVerify, decrypt, hashSecret, verifySecret } from './crypto';
import { sendAdminAlert } from '../mail';
import { audit } from './audit';
import { normalizeEmail } from '../sample';

authenticator.options = { window: 1, step: 30 };
export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60_000;

export type CheckFail = 'rate_limited' | 'bad_credentials' | 'locked' | 'totp_required' | 'totp_not_enrolled';

/**
 * 登录/2FA 限流（10 分钟窗口，三个桶都计数）：IP+账号 5 次、单账号 10 次（防换 IP 爆破）、单 IP 30 次（防撞库）。
 * 每次调用都原子计数（hit），不先查后计，并发请求也不会超过上限。登录接口每次都计、不退回。
 * enroll 两个接口在密码正确后调 refundLoginRate 退回 IP+账号、单账号两个桶（单 IP 桶不退），所以只有密码错才占这两个桶的额度。
 */
export const LOGIN_WINDOW_MS = 10 * 60_000;
export const loginKeys = (ip: string | null, email: string) => {
  const e = rateLimitKeyHash(email.trim().toLowerCase());
  return { ipAcct: `login:${rateLimitSubject(ip)}:${e}`, acct: `login-acct:${e}`, ip: `login-ip:${rateLimitSubject(ip)}` };
};
export async function loginRateOk(ip: string | null, email: string) {
  // 限流存储故障时拒绝（closed）；邮箱先 trim+小写再 HMAC，key 里不存明文
  const o = { onStoreError: 'closed' } as const;
  const k = loginKeys(ip, email);
  const [a, b, c] = await Promise.all([
    hitRateLimit(k.ipAcct, 5, LOGIN_WINDOW_MS, o),
    hitRateLimit(k.acct, 10, LOGIN_WINDOW_MS, o),
    hitRateLimit(k.ip, 30, LOGIN_WINDOW_MS, o),
  ]);
  return a && b && c;
}

/**
 * 只给 enroll / enroll confirm 用：checkPassword 返回 user（密码正确）后，退回这次计的 IP+账号、单账号两个桶。
 * 单 IP 桶（login-ip）不退。存储出错时忽略（计数保留）。登录接口不调用。
 */
export async function refundLoginRate(ip: string | null, email: string) {
  const k = loginKeys(ip, email);
  await Promise.all([refundRateLimit(k.ipAcct, LOGIN_WINDOW_MS), refundRateLimit(k.acct, LOGIN_WINDOW_MS)]);
}

/**
 * 登录失败审计里的邮箱只存 HMAC（不存明文）：subkey = HMAC(AUTH_SECRET, "audit-email-v1")，再 HMAC(subkey, normalizeEmail(email))（与 Contact/SampleRequest.normalizedEmail 同一规范化）。
 * 绝不直接用 AUTH_SECRET 当 HMAC 密钥；没有 AUTH_SECRET（本地/测试）时用固定开发密钥。写入格式 `emailh:<32 字符>`。
 */
export function auditEmailHash(email: string, env: Record<string, string | undefined> = process.env) {
  const sub = createHmac('sha256', env.AUTH_SECRET || 'dev-only-audit-email-key').update('audit-email-v1').digest();
  return 'emailh:' + createHmac('sha256', sub).update(normalizeEmail(email)).digest('base64url').slice(0, 32);
}

/** 让该账号所有现有会话失效。改密码、重置或关闭 2FA、禁用账号时必须调用。 */
export async function revokeSessions(userId: string) {
  const updated = await prisma.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
  const { revokeUserDevices } = await import('./device-repo');
  await revokeUserDevices(prisma, userId, 'session_version', updated.sessionVersion);
}

/** 登录类失败：计入 failedLogins（满 MAX_FAILS 锁定并告警）+ 审计 auth.login_fail。checkPassword 的错密码分支和 #347 的令牌错开关共用 */
export async function recordFailedLogin(user: User | null, email: string, ip: string | null, reason: string) { return fail(user, email, ip, reason); }

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
  await audit({ actorId: user?.id ?? null, action: 'auth.login_fail', target: auditEmailHash(email), meta: { reason }, ip });
}

/** 校验邮箱和密码，并检查锁定。成功返回 user。 */
export async function checkPassword(email: string, password: string, ip: string | null): Promise<User | CheckFail> {
  if (!(await loginRateOk(ip, email))) { await audit({ action: 'auth.login_fail', target: auditEmailHash(email), meta: { reason: 'rate_limited' }, ip }); return 'rate_limited'; }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.disabled) { await burnVerify(password); await fail(null, email, ip, 'bad_credentials'); return 'bad_credentials'; }
  if (user.lockedUntil && user.lockedUntil > new Date()) { await audit({ actorId: user.id, action: 'auth.login_fail', target: auditEmailHash(email), meta: { reason: 'locked' }, ip }); return 'locked'; }
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
  if (!user.totpEnabled) { await audit({ actorId: user.id, action: 'auth.login_fail', target: auditEmailHash(email), meta: { reason: 'totp_not_enrolled' }, ip }); return null; }
  if (!(await checkSecondFactor(user, input.totp, input.recoveryCode))) { await fail(user, email, ip, input.totp || input.recoveryCode ? 'bad_totp' : 'totp_missing'); return null; }
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  await audit({ actorId: user.id, action: 'auth.login_success', target: user.id, meta: { method: input.totp ? 'totp' : 'recovery_code' }, ip });
  return user;
}

export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => randomBytes(5).toString('hex')); // 10 位十六进制
}
export const hashCodes = (codes: string[]) => Promise.all(codes.map(hashSecret));
