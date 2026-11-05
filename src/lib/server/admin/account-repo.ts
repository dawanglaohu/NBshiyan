import type { Prisma, PrismaClient } from '@prisma/client';

/** 敏感变更接显式 tx，不读全局 prisma，也不反调 service。 */
export type AccountDb = PrismaClient | Prisma.TransactionClient;

export type SensitiveUser = {
  id: string;
  sessionVersion: number;
  disabled: boolean;
  totpEnabled: boolean;
  totpSecret: string | null;
  passwordHash: string;
  passwordlessEnabled: boolean;
};

export type SensitiveAudit = {
  actorId: string | null;
  action: string;
  target: string | null;
  meta?: Prisma.InputJsonValue;
  ip: string;
};

/**
 * 本人登录方式 / 密码的原子落库。
 * User 行已由 action-grant 的 consumeLocked 在同一事务里按固定 User→Device→Grant 锁序持有 FOR UPDATE，
 * 这里只读不另加锁，避免交叉死锁；最终写入用 sessionVersion 做 CAS。
 */
export type AccountRepo = {
  readCurrentUser(tx: Prisma.TransactionClient, userId: string): Promise<SensitiveUser | undefined>;
  /** 条件 UPDATE：sessionVersion 必须等于 grant 绑定时的值，否则旧授权/旧 sv 不提交。 */
  applySensitiveChange(
    tx: Prisma.TransactionClient,
    userId: string,
    sessionVersion: number,
    data: Prisma.UserUpdateManyMutationInput,
  ): Promise<number>;
  revokeDevices(tx: Prisma.TransactionClient, userId: string, sessionVersion: number, reason: string, now: Date): Promise<void>;
  createAudit(tx: Prisma.TransactionClient, entry: SensitiveAudit): Promise<void>;
};

export function createAccountRepo(): AccountRepo {
  return {
    async readCurrentUser(tx, userId) {
      const rows = await tx.$queryRaw<SensitiveUser[]>`
        SELECT id, "sessionVersion", disabled, "totpEnabled", "totpSecret", "passwordHash", "passwordlessEnabled"
        FROM "User"
        WHERE id = ${userId}
      `;
      return rows[0];
    },
    async applySensitiveChange(tx, userId, sessionVersion, data) {
      const r = await tx.user.updateMany({
        where: { id: userId, sessionVersion },
        data: { ...data, sessionVersion: { increment: 1 } },
      });
      return r.count;
    },
    async revokeDevices(tx, userId, sessionVersion, reason, now) {
      await tx.adminDeviceSession.updateMany({
        where: { userId, revokedAt: null, sessionVersion: { lt: sessionVersion } },
        data: { revokedAt: now, revokedReason: reason },
      });
    },
    async createAudit(tx, entry) {
      await tx.auditLog.create({
        data: {
          actorId: entry.actorId ?? null,
          action: entry.action,
          target: entry.target ?? null,
          meta: entry.meta,
          ip: entry.ip || 'unknown',
        },
      });
    },
  };
}
