import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { CredentialsSignin } from 'next-auth';
import {
  CHALLENGE_INVALID_CODE,
  RATE_LIMITED_CODE,
  TOTP_REQUIRED_CODE,
  TOTP_SETUP_REQUIRED_CODE,
} from '../../admin/login-step';
import { prisma } from '../db';

export const CHALLENGE_COOKIE = '__Host-admin-login-challenge';
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const CHALLENGE_TTL_SEC = 5 * 60;
const CHALLENGE_TTL_MS = CHALLENGE_TTL_SEC * 1000;

function throwCoded(code: string): never {
  const error = new CredentialsSignin();
  error.code = code;
  throw error;
}

/** 密码已经正确、账号开了两步验证、这次又没带验证码。不增加 failedLogins。 */
export function throwTotpRequired(): never {
  throwCoded(TOTP_REQUIRED_CODE);
}

/** 密码已经正确，但账号还没完成两步验证绑定。不建会话。 */
export function throwTotpSetupRequired(): never {
  throwCoded(TOTP_SETUP_REQUIRED_CODE);
}

/** 三个登录桶有一个已经超限。在查密码之前抛出。 */
export function throwRateLimited(): never {
  throwCoded(RATE_LIMITED_CODE);
}

/** 挑战缺失、过期、已用、设备不符或次数用尽。不增加 failedLogins。 */
export function throwChallengeInvalid(): never {
  throwCoded(CHALLENGE_INVALID_CODE);
}

type CookieBox = { cookies: string[] };
const loginCookies = new AsyncLocalStorage<CookieBox>();

export function withLoginCookies<T>(fn: () => Promise<T>): Promise<T> {
  return loginCookies.run({ cookies: [] }, fn);
}

export function stageLoginCookie(header: string): void {
  loginCookies.getStore()?.cookies.push(header);
}

export function stagedLoginCookies(): string[] {
  return loginCookies.getStore()?.cookies.slice() ?? [];
}

export function challengeIdHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function userAgentHash(userAgent: string | null | undefined): string {
  return createHash('sha256').update(userAgent ?? '').digest('hex');
}

export function challengeSetCookie(raw: string): string {
  return [
    `${CHALLENGE_COOKIE}=${encodeURIComponent(raw)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${CHALLENGE_TTL_SEC}`,
  ].join('; ');
}

export function readChallengeCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const prefix = `${CHALLENGE_COOKIE}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const raw = trimmed.slice(prefix.length);
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { value = raw; }
    if (value.length < 20 || value.length > 128) return null;
    return value;
  }
  return null;
}

export type LoginChallengeRow = {
  id: string;
  userId: string;
  sessionVersion: number;
  uaHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
};

/** 签发挑战：库里只存哈希，原文只放进 __Host- cookie。 */
export async function issueLoginChallenge(user: { id: string; sessionVersion: number }, userAgent: string | null): Promise<void> {
  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await prisma.adminLoginChallenge.create({
    data: {
      id: challengeIdHash(raw),
      userId: user.id,
      sessionVersion: user.sessionVersion,
      uaHash: userAgentHash(userAgent),
      expiresAt,
    },
  });
  stageLoginCookie(challengeSetCookie(raw));
}

export async function findLoginChallenge(cookieHeader: string | null, userAgent: string | null): Promise<{ id: string; uaHash: string; row: LoginChallengeRow | null }> {
  const uaHash = userAgentHash(userAgent);
  const raw = readChallengeCookie(cookieHeader);
  if (!raw) return { id: '', uaHash, row: null };
  const id = challengeIdHash(raw);
  const row = await prisma.adminLoginChallenge.findUnique({ where: { id } });
  return { id, uaHash, row };
}

export async function noteChallengeFailure(id: string): Promise<void> {
  await prisma.adminLoginChallenge.updateMany({
    where: { id, consumedAt: null, attempts: { lt: CHALLENGE_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
}

/** 条件同时钉住未核销、未过期、会话版本、设备哈希和剩余次数。返回行数不是 1 就当挑战无效。 */
export async function consumeLoginChallenge(id: string, sessionVersion: number, uaHash: string, now = new Date()) {
  return prisma.adminLoginChallenge.updateMany({
    where: {
      id,
      consumedAt: null,
      expiresAt: { gt: now },
      sessionVersion,
      uaHash,
      attempts: { lt: CHALLENGE_MAX_ATTEMPTS },
    },
    data: { consumedAt: now },
  });
}
