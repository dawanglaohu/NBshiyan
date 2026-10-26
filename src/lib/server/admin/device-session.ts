import { randomBytes } from 'crypto';
import type { AdminDeviceSession, PrismaClient, Role, User } from '@prisma/client';
import { AccountDTOSchema, type AccountDTO } from '../../contracts/account';
import type { ServerPolicy } from '../config';
import { createDeviceRepo, type DeviceRepo } from './device-repo';
import { activityRetryAfterSeconds, activityWriteAllowed, effectiveDeadline, enforcedAbsolute, initialHardExpiresAt, publicAbsolute } from './session-expiry';

export type SessionPolicy = ServerPolicy['session'];
export type SessionDenial = 'unauthenticated' | 'disabled' | 'forbidden' | 'unavailable';
/** 会话本身无效。数据库故障不在这里，见 UnavailableAccess。 */
export type AccountDenial = Exclude<SessionDenial, 'unavailable'>;
type SessionUser = Pick<User, 'disabled' | 'totpEnabled' | 'lockedUntil' | 'sessionVersion' | 'role'>;

export type ExpiryBounds = { effectiveExpiresAt: Date; absoluteExpiresAt: Date | null };

export type BoundAccess =
  | { ok: true; user: User; device: AdminDeviceSession; bounds: ExpiryBounds }
  | { ok: false; reason: AccountDenial; status: 401 | 403 };

/** 数据库暂时不可用。调用方保留 cookie，不把这次故障当成未登录。 */
export type UnavailableAccess = { ok: false; reason: 'unavailable'; status: 503 };

export type AuthenticateResult = BoundAccess | UnavailableAccess;

const SECURE_COOKIE = '__Secure-authjs.session-token';
const PLAIN_COOKIE = 'authjs.session-token';

/**
 * 续期只拉长闲置截止。有效期限是闲置截止和 hardExpiresAt 里较早的那个。
 * 对外的 absoluteExpiresAt 仍只属于记住设备；普通会话这一项保持空。
 */
export function expiryBounds(device: Pick<AdminDeviceSession, 'remembered' | 'createdAt' | 'lastActivityAt' | 'absoluteExpiresAt' | 'hardExpiresAt'>, policy: SessionPolicy): ExpiryBounds {
  return { effectiveExpiresAt: effectiveDeadline(device, policy), absoluteExpiresAt: publicAbsolute(device, policy) };
}

export function isStrictlyBefore(now: Date, deadline: Date): boolean {
  return now.getTime() < deadline.getTime();
}

/**
 * 只填 hardExpiresAt 仍为空的行，按创建时间写入绝对截止。
 * 已经有值的行不动，absoluteExpiresAt 也不动。可以重复执行。
 */
export async function backfillHardExpiresAt(db: PrismaClient, policy: SessionPolicy): Promise<{ ordinary: number; remembered: number }> {
  const ordinarySeconds = policy.ordinaryAbsoluteMs / 1000;
  const rememberedSeconds = policy.absoluteMs / 1000;
  const ordinary = await db.$executeRaw`
    UPDATE "AdminDeviceSession"
    SET "hardExpiresAt" = "createdAt" + make_interval(secs => ${ordinarySeconds})
    WHERE "remembered" = false AND "hardExpiresAt" IS NULL
  `;
  const remembered = await db.$executeRaw`
    UPDATE "AdminDeviceSession"
    SET "hardExpiresAt" = "createdAt" + make_interval(secs => ${rememberedSeconds})
    WHERE "remembered" = true AND "hardExpiresAt" IS NULL
  `;
  return { ordinary: Number(ordinary), remembered: Number(remembered) };
}

/**
 * 账号状态判断，接口和页面共用。
 * 未登录、用户不存在、锁定、会话版本不一致、未开 2FA → 401。
 * 停用 → 403。路由角色在设备校验之后判断。
 */
function classifyAccount<U extends SessionUser>(uid: string | undefined, user: U | null, sv: number | undefined, now: Date):
  { ok: true; user: U } | { ok: false; reason: AccountDenial; status: 401 | 403 } {
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
  if (!isStrictlyBefore(input.now, enforcedAbsolute(device, input.policy))) return { ok: false, reason: 'unauthenticated', status: 401 };
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

export type ActivityWrite =
  | { ok: true; wrote: boolean; bounds: ExpiryBounds; retryAfterSeconds: number; user: User; device: AdminDeviceSession }
  | { ok: false; reason: AccountDenial; status: 401 | 403 }
  | UnavailableAccess;

const ACTIVITY_ROLES = ['ADMIN', 'SALES', 'EDITOR'] as const;

export function createDeviceSessionService(deps: { repo: DeviceRepo; clock: () => Date; policy: SessionPolicy; db?: PrismaClient }) {
  const { repo, clock, policy, db } = deps;
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
          hardExpiresAt: initialHardExpiresAt(now, input.remembered, policy),
          deviceLabel: coarseDeviceLabel(input.userAgent),
        });
      });
    },
    async authenticate(input: { userId: string | undefined; sessionVersion: number | undefined; sid: string | undefined; roles: readonly Role[] }): Promise<AuthenticateResult> {
      try {
        const user = input.userId ? await repo.findUser(input.userId) : null;
        const device = input.sid ? await repo.findDevice(input.sid) : null;
        return decideAdminAccess({ ...input, user, device, now: clock(), policy });
      } catch {
        return { ok: false, reason: 'unavailable', status: 503 };
      }
    },
    async revokeSid(id: string, reason: string): Promise<void> {
      await repo.revokeSid(id, reason, clock());
    },
    /**
     * 把一次真实活动写入当前设备。节流窗口内只做无锁读，不锁用户行或设备行。
     * 需要写库时才先锁用户再锁设备。条件更新只允许 lastActivityAt 前进。
     * hardExpiresAt 不在更新列里。已撤销、停用、2FA 关闭、版本不符或期限等号已到的行不更新。
     */
    async recordActivity(input: { userId: string; sessionVersion: number; sid: string }): Promise<ActivityWrite> {
      if (!db) return { ok: false, reason: 'unauthenticated', status: 401 };
      try {
        const seenAt = clock();
        const seenUser = await db.user.findUnique({ where: { id: input.userId } });
        const seenDevice = await db.adminDeviceSession.findUnique({ where: { id: input.sid } });
        const seen = decideAdminAccess({
          userId: input.userId,
          sessionVersion: input.sessionVersion,
          sid: input.sid,
          user: seenUser,
          device: seenDevice,
          roles: ACTIVITY_ROLES,
          now: seenAt,
          policy,
        });
        if (!seen.ok) return seen;
        if (!seenUser || !seenDevice) return { ok: false, reason: 'unauthenticated', status: 401 };
        if (!activityWriteAllowed(seenDevice.lastActivityAt, seenAt, policy.activityThrottleMs)) {
          return {
            ok: true,
            wrote: false,
            bounds: seen.bounds,
            retryAfterSeconds: activityRetryAfterSeconds(seenDevice.lastActivityAt, seenAt, policy.activityThrottleMs),
            user: seenUser,
            device: seenDevice,
          };
        }
        return await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
          await tx.$queryRaw`SELECT "id" FROM "AdminDeviceSession" WHERE "id" = ${input.sid} AND "userId" = ${input.userId} FOR UPDATE`;
          const user = await tx.user.findUnique({ where: { id: input.userId } });
          const device = await tx.adminDeviceSession.findUnique({ where: { id: input.sid } });
          const now = clock();
          const decision = decideAdminAccess({
            userId: input.userId,
            sessionVersion: input.sessionVersion,
            sid: input.sid,
            user,
            device,
            roles: ACTIVITY_ROLES,
            now,
            policy,
          });
          if (!decision.ok || !user || !device) return decision.ok ? { ok: false, reason: 'unauthenticated', status: 401 } : decision;
          if (!activityWriteAllowed(device.lastActivityAt, now, policy.activityThrottleMs)) {
            return {
              ok: true,
              wrote: false,
              bounds: decision.bounds,
              retryAfterSeconds: activityRetryAfterSeconds(device.lastActivityAt, now, policy.activityThrottleMs),
              user,
              device,
            };
          }
          const updated = await tx.adminDeviceSession.updateMany({
            where: {
              id: device.id,
              userId: user.id,
              sessionVersion: user.sessionVersion,
              revokedAt: null,
              lastActivityAt: device.lastActivityAt,
              hardExpiresAt: device.hardExpiresAt,
            },
            data: { lastActivityAt: now },
          });
          if (updated.count !== 1) return { ok: false, reason: 'unauthenticated', status: 401 };
          const fresh = await tx.adminDeviceSession.findUnique({ where: { id: device.id } });
          const again = decideAdminAccess({
            userId: input.userId,
            sessionVersion: input.sessionVersion,
            sid: input.sid,
            user,
            device: fresh,
            roles: ACTIVITY_ROLES,
            now,
            policy,
          });
          if (!again.ok || !fresh) return again.ok ? { ok: false, reason: 'unauthenticated', status: 401 } : again;
          return { ok: true, wrote: true, bounds: again.bounds, retryAfterSeconds: Math.ceil(policy.activityThrottleMs / 1000), user, device: fresh };
        }, { maxWait: 5_000, timeout: 10_000 });
      } catch {
        return { ok: false, reason: 'unavailable', status: 503 };
      }
    },
  };
}

export type DeviceSessionService = ReturnType<typeof createDeviceSessionService>;

export function deviceServiceFor(db: Parameters<typeof createDeviceRepo>[0], clock: () => Date, policy: SessionPolicy) {
  return createDeviceSessionService({ repo: createDeviceRepo(db), clock, policy, db: db as PrismaClient });
}
