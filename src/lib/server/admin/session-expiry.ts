import type { AdminDeviceSession } from '@prisma/client';

/** 期限计算只用这几个毫秒数。绝对截止从设备 createdAt 起算，不读 JWT。 */
export type ExpiryPolicy = {
  idleMs: number;
  rememberedIdleMs: number;
  absoluteMs: number;
  ordinaryAbsoluteMs: number;
  activityThrottleMs: number;
};

export type ActivityDevice = Pick<AdminDeviceSession, 'remembered' | 'createdAt' | 'lastActivityAt' | 'absoluteExpiresAt' | 'hardExpiresAt'>;

function policyCapMs(remembered: boolean, policy: ExpiryPolicy): number {
  return remembered ? policy.absoluteMs : policy.ordinaryAbsoluteMs;
}

/** 新建会话时写入 hardExpiresAt 的值。续期不再调用它。 */
export function initialHardExpiresAt(createdAt: Date, remembered: boolean, policy: ExpiryPolicy): Date {
  return new Date(createdAt.getTime() + policyCapMs(remembered, policy));
}

/** 策略允许的最晚绝对截止。写得更晚的 hardExpiresAt 会被夹到这里，不能把会话延长。 */
export function policyCeiling(device: Pick<ActivityDevice, 'remembered' | 'createdAt'>, policy: ExpiryPolicy): Date {
  return initialHardExpiresAt(device.createdAt, device.remembered, policy);
}

/**
 * 鉴权用的绝对截止。以设备行 hardExpiresAt 为准，并且不超过策略上限。
 * 旧行还没回填时用创建时间推算，和回填写入的是同一个时刻。
 */
export function enforcedAbsolute(device: ActivityDevice, policy: ExpiryPolicy): Date {
  const ceiling = policyCeiling(device, policy).getTime();
  const stored = device.hardExpiresAt?.getTime();
  return new Date(stored == null ? ceiling : Math.min(stored, ceiling));
}

/** 对外的绝对期限。普通会话保持空；记住设备仍看 absoluteExpiresAt，不超过 30 天。 */
export function publicAbsolute(device: ActivityDevice, policy: ExpiryPolicy): Date | null {
  if (!device.remembered) return null;
  const ceiling = device.createdAt.getTime() + policy.absoluteMs;
  const stored = device.absoluteExpiresAt?.getTime();
  return new Date(stored == null ? ceiling : Math.min(stored, ceiling));
}

/** 闲置截止和设备行绝对截止里较早的那个。续期只让闲置截止前进，绝对截止不动。 */
export function effectiveDeadline(device: ActivityDevice, policy: ExpiryPolicy): Date {
  const idleEnd = device.lastActivityAt.getTime() + (device.remembered ? policy.rememberedIdleMs : policy.idleMs);
  return new Date(Math.min(idleEnd, enforcedAbsolute(device, policy).getTime()));
}

/** 距上次写库未满节流窗口就不再写。窗口等号允许下一次写。 */
export function activityWriteAllowed(lastActivityAt: Date, now: Date, throttleMs: number): boolean {
  return now.getTime() - lastActivityAt.getTime() >= throttleMs;
}

/** 距离下一次允许写库的秒数，至少 1 秒。调用方把它放进 Retry-After，不在服务端重放。 */
export function activityRetryAfterSeconds(lastActivityAt: Date, now: Date, throttleMs: number): number {
  const remainMs = lastActivityAt.getTime() + throttleMs - now.getTime();
  return Math.max(1, Math.ceil(remainMs / 1000));
}
