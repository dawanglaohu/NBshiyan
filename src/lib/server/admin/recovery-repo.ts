import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

/** 恢复凭据只存 SHA-256；明文是 256bit base64url，只在签发响应里出现一次。M3-T19 核销时复用同一函数。 */
export function hashRecoveryPermitToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type RecoveryDb = PrismaClient | Prisma.TransactionClient;

export type LockedRecoveryTarget = {
  id: string;
  sessionVersion: number;
  disabled: boolean;
  totpEnabled: boolean;
};

export type NewRecoveryPermit = {
  id: string;
  tokenHash: string;
  targetUserId: string;
  source: 'ADMIN' | 'SERVER_OWNER';
  issuedById: string | null;
  reason: string;
  sessionVersion: number;
  createdAt: Date;
  expiresAt: Date;
};

export type RecoveryAudit = {
  actorId: string | null;
  action: string;
  target: string | null;
  meta?: Prisma.InputJsonValue;
  ip: string;
};

/**
 * 恢复相关的持久查询集中在这里，供 M3-T4 签发与 M3-T19 核销复用。
 * 只接显式传入的 db/tx，不读全局 prisma，也不反调 service。
 */
export type RecoveryRepo = {
  /**
   * 读授权方当前角色。授权方 User 行已由 action-grant 的 consumeLocked 在同一事务里
   * 按固定 User→Device→Grant 锁序持有 FOR UPDATE，这里只补读，不引入第二组行锁，
   * 避免两个管理员互为目标时交叉加锁死锁。
   */
  readActorRole(tx: Prisma.TransactionClient, userId: string): Promise<string | undefined>;
  /**
   * 读目标账号当前状态。不再对目标行加 FOR UPDATE：permit 只绑定此刻的 sessionVersion，
   * M3-T19 核销时会按当前 sv 做 CAS，并发的 sv 变化会让旧 permit 失效，无需在这里抢锁。
   */
  readTargetUser(tx: Prisma.TransactionClient, userId: string): Promise<LockedRecoveryTarget | undefined>;
  createPermit(tx: Prisma.TransactionClient, permit: NewRecoveryPermit): Promise<void>;
  createAudit(tx: Prisma.TransactionClient, entry: RecoveryAudit): Promise<void>;
};

export function createRecoveryRepo(): RecoveryRepo {
  return {
    async readActorRole(tx, userId) {
      const rows = await tx.$queryRaw<{ role: string }[]>`
        SELECT role::text AS role
        FROM "User"
        WHERE id = ${userId}
      `;
      return rows[0]?.role;
    },
    async readTargetUser(tx, userId) {
      const rows = await tx.$queryRaw<LockedRecoveryTarget[]>`
        SELECT id, "sessionVersion", disabled, "totpEnabled"
        FROM "User"
        WHERE id = ${userId}
      `;
      return rows[0];
    },
    async createPermit(tx, permit) {
      await tx.adminRecoveryPermit.create({ data: permit });
    },
    async createAudit(tx, entry) {
      await tx.auditLog.create({ data: entry });
    },
  };
}
