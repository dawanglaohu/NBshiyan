import { randomBytes } from 'crypto';
import type { AdminDeviceSession, Role, User } from '@prisma/client';
import { AccountDTOSchema, type AccountDTO } from '../../contracts/account';
import type { ServerPolicy } from '../config';
import { createDeviceRepo, type DeviceRepo } from './device-repo';

export type SessionPolicy = ServerPolicy['session'];
export type SessionDenial = 'unauthenticated' | 'disabled' | 'forbidden';
type SessionUser = Pick<User, 'disabled' | 'totpEnabled' | 'lockedUntil' | 'sessionVersion' | 'role'>;

export type ExpiryBounds = { effectiveExpiresAt: Date; absoluteExpiresAt: Date | null };

export type BoundAccess =
  | { ok: true; user: User; device: AdminDeviceSession; bounds: ExpiryBounds }
  | { ok: false; reason: SessionDenial; status: 401 | 403 };

const SECURE_COOKIE = '__Secure-authjs.session-token';
const PLAIN_COOKIE = 'authjs.session-token';

/** 普通会话按上次活动滑动，不写绝对期限。记住设备再被首次签发后的绝对期限卡住。 */
export function expiryBounds(device: Pick<AdminDeviceSession, 'remembered' | 'createdAt' | 'lastActivityAt' | 'absoluteExpiresAt'>, policy: SessionPolicy): ExpiryBounds {
  const idleEnd = new Date(device.lastActivityAt.getTime() + (device.remembered ? policy.rememberedIdleMs : policy.idleMs));
  if (!device.remembered) return { effectiveExpiresAt: idleEnd, absoluteExpiresAt: null };
  const absolute = device.absoluteExpiresAt ?? new Date(device.createdAt.getTime() + policy.absoluteMs);
  return { effectiveExpiresAt: new Date(Math.min(idleEnd.getTime(), absolute.getTime())), absoluteExpiresAt: absolute };
}

export function isStrictlyBefore(now: Date, deadline: Date): boolean {
  return now.getTime() < deadline.getTime();
}

/**
 * 账号状态判断，接口和页面共用。
 * 未登录、用户不存在、锁定、会话版本不一致、未开 2FA → 401。
 * 停用 → 403。路由角色在设备校验之后判断。
 */
function classifyAccount<U extends SessionUser>(uid: string | undefined, user: U | null, sv: number | undefined, now: Date):
  { ok: true; user: U } | { ok: false; reason: SessionDenial; status: 401 | 403 } {
  if (!uid || !user) return { ok: false, reason: 'unauthenticated', status: 401 };
  if (user.disabled) return { ok: false, reason: 'disabled', status: 403 };
  if (!user.totpEnabled || (user.lockedUntil && user.lockedUntil > now) || sv !== user.sessionVersion) return { ok: false, reason: 'unauthenticated', status: 401 };
  return { ok: true, user };
}

export function classifySession<U extends SessionUser>(uid: string | undefined, user: U | null, sv: number | undefined, roles: readonly Role[], now = new Date()) {
  const account = classifyAccount(uid, user, sv, now);
  if (!account.ok) return account;
  if (!roles.includes(account.user.role)) return { ok: false, reason: 'forbidden', status: 403 } as const;
  return account;
}

/** 在账号判断之后核对本机设备。过期的等号拒绝，读取不改 lastActivityAt。 */
export function decideAdminAccess(input: {
  userId: string | undefined;
  sessionVersion: number | undefined;
  sid: string | undefined;
  user: User | null;
  device: AdminDeviceSession | null;
  roles: readonly Role[];
  now: Date;
  policy: SessionPolicy;
}): BoundAccess {
  const account = classifyAccount(input.userId, input.user, input.sessionVersion, input.now);
  if (!account.ok || !input.user) return account.ok ? { ok: false, reason: 'unauthenticated', status: 401 } : account;
  const device = input.device;
  if (!input.sid || !device || device.userId !== input.user.id || device.revokedAt || device.sessionVersion !== input.user.sessionVersion) {
    return { ok: false, reason: 'unauthenticated', status: 401 };
  }
  if (device.remembered !== (device.absoluteExpiresAt !== null)) return { ok: false, reason: 'unauthenticated', status: 401 };
  const bounds = expiryBounds(device, input.policy);
  if (!isStrictlyBefore(input.now, bounds.effectiveExpiresAt)) return { ok: false, reason: 'unauthenticated', status: 401 };
  if (bounds.absoluteExpiresAt && !isStrictlyBefore(input.now, bounds.absoluteExpiresAt)) return { ok: false, reason: 'unauthenticated', status: 401 };
  if (!input.roles.includes(input.user.role)) return { ok: false, reason: 'forbidden', status: 403 };
  return { ok: true, user: input.user, device, bounds };
}

/** 只留浏览器和系统的粗标签。对不上就空，不把原始 User-Agent 写进库。 */
export function coarseDeviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /Chrome\//.test(userAgent) ? 'Chrome'
      : /Firefox\//.test(userAgent) ? 'Firefox'
        : /Safari\//.test(userAgent) && !/Chrome\//.test(userAgent) ? 'Safari'
          : null;
  const system = /Windows/.test(userAgent) ? 'Windows'
    : /Mac OS X/.test(userAgent) ? 'macOS'
      : /Android/.test(userAgent) ? 'Android'
        : /iPhone|iPad/.test(userAgent) ? 'iOS'
          : /Linux/.test(userAgent) ? 'Linux'
            : null;
  if (!browser && !system) return null;
  return [browser, system].filter(Boolean).join(' / ').slice(0, 200);
}

export function accountDto(user: User, device: AdminDeviceSession, bounds: ExpiryBounds): AccountDTO {
  return AccountDTOSchema.parse({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    passwordlessEnabled: user.passwordlessEnabled,
    totpEnabled: user.totpEnabled,
    currentDevice: {
      id: device.id,
      current: true,
      remembered: device.remembered,
      createdAt: device.createdAt.toISOString(),
      lastActivityAt: device.lastActivityAt.toISOString(),
      effectiveExpiresAt: bounds.effectiveExpiresAt.toISOString(),
      absoluteExpiresAt: bounds.absoluteExpiresAt ? bounds.absoluteExpiresAt.toISOString() : null,
      revokedAt: null,
      deviceLabel: device.deviceLabel,
    },
  });
}

export function sessionCookieNames(): readonly string[] {
  return [PLAIN_COOKIE, SECURE_COOKIE];
}

/** 明确的过去 Expires 保证 Next 合并 cookie 时即使丢弃数值 0 的 Max-Age，删除仍然有效。 */
export function clearedSessionCookieHeaders(): string[] {
  return sessionCookieNames().map((name) => {
    const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
    if (name.startsWith('__Secure-') || name.startsWith('__Host-')) parts.push('Secure');
    return parts.join('; ');
  });
}

export type OpenDeviceInput = {
  userId: string;
  sessionVersion: number;
  remembered: boolean;
  userAgent: string | null;
};

export function createDeviceSessionService(deps: { repo: DeviceRepo; clock: () => Date; policy: SessionPolicy }) {
  const { repo, clock, policy } = deps;
  return {
    async open(input: OpenDeviceInput): Promise<AdminDeviceSession> {
      const now = clock();
      return repo.transaction(async (tx) => {
        const user = await tx.findUser(input.userId);
        if (!user || user.disabled || !user.totpEnabled || user.sessionVersion !== input.sessionVersion) throw new Error('device open refused');
        if (user.lockedUntil && user.lockedUntil > now) throw new Error('device open refused');
        return tx.create({
          id: randomBytes(24).toString('base64url'),
          userId: user.id,
          sessionVersion: user.sessionVersion,
          remembered: input.remembered,
          createdAt: now,
          lastActivityAt: now,
          absoluteExpiresAt: input.remembered ? new Date(now.getTime() + policy.absoluteMs) : null,
          deviceLabel: coarseDeviceLabel(input.userAgent),
        });
      });
    },
    async authenticate(input: { userId: string | undefined; sessionVersion: number | undefined; sid: string | undefined; roles: readonly Role[] }): Promise<BoundAccess> {
      try {
        const user = input.userId ? await repo.findUser(input.userId) : null;
        const device = input.sid ? await repo.findDevice(input.sid) : null;
        return decideAdminAccess({ ...input, user, device, now: clock(), policy });
      } catch {
        return { ok: false, reason: 'unauthenticated', status: 401 };
      }
    },
    async revokeSid(id: string, reason: string): Promise<void> {
      await repo.revokeSid(id, reason, clock());
    },
  };
}

export type DeviceSessionService = ReturnType<typeof createDeviceSessionService>;

export function deviceServiceFor(db: Parameters<typeof createDeviceRepo>[0], clock: () => Date, policy: SessionPolicy) {
  return createDeviceSessionService({ repo: createDeviceRepo(db), clock, policy });
}
