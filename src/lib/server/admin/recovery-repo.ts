import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

/** 恢复凭据只存 SHA-256；明文是 256bit base64url，只在签发响应里出现一次。M3-T19 核销时复用同一函数。 */
export function hashRecoveryPermitToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 受限会话 cookie 的明文也是 256bit，库里只存 SHA-256；与 permit 用同一哈希函数但不同凭据族。 */
export function hashRecoverySessionToken(token: string): string {
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
  /** 仅 M3-T18 的本地 TTY 预授权写入；ADMIN 路径恒为 null。M3-T19 核销时转入受限会话。 */
  pendingPasswordHash?: string | null;
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

export type LockedRecoveryUser = {
  id: string;
  email: string;
  disabled: boolean;
  totpEnabled: boolean;
  recoveryCodes: string[];
  sessionVersion: number;
};

export type ConsumedPermit = {
  id: string;
  source: 'ADMIN' | 'SERVER_OWNER';
  pendingPasswordHash: string | null;
  sessionVersion: number;
};

export type NewRecoverySession = {
  id: string;
  tokenHash: string;
  userId: string;
  sessionVersion: number;
  source: 'RECOVERY_CODE' | 'ADMIN' | 'SERVER_OWNER' | 'SELF_REAUTH';
  createdAt: Date;
  expiresAt: Date;
  pendingPasswordHash?: string | null;
  passwordResetSource?: string | null;
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
  /**
   * M3-T18：本地恢复预授权要判断目标角色，而 readTargetUser 属 ADMIN 路径、不返回 role。
   * 单独一条只读查询，不改既有查询形状，避免影响 M3-T4/M3-T19 已验收行为。
   */
  readOwnerTarget(tx: Prisma.TransactionClient, userId: string): Promise<LockedRecoveryTarget & { role: string } | undefined>;
  createPermit(tx: Prisma.TransactionClient, permit: NewRecoveryPermit): Promise<void>;
  createAudit(tx: Prisma.TransactionClient, entry: RecoveryAudit): Promise<void>;

  /** M3-T19：锁账号行后重读当前 recoveryCodes/sv，禁止用旧快照整组覆盖（09 节第 6 条并发约束）。 */
  lockRecoveryUser(tx: Prisma.TransactionClient, email: string): Promise<LockedRecoveryUser | undefined>;
  /** 条件核销 permit：未用、未过期、绑定当前 sv、target 匹配，返回被核销行（含 SERVER_OWNER 预授权 hash）。 */
  consumePermit(tx: Prisma.TransactionClient, tokenHash: string, userId: string, sessionVersion: number, now: Date): Promise<ConsumedPermit | undefined>;
  /** 恢复码：锁 User 后按当前数组里恰好匹配的哈希做 array_remove，不整组覆盖。 */
  consumeRecoveryCode(tx: Prisma.TransactionClient, userId: string, code: string): Promise<boolean>;
  /** sv 递增后撤销旧设备与旧的未完成恢复会话，再建 10min 受限会话，全部在同一 tx。 */
  bumpSessionVersion(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<number>;
  revokeOldDevices(tx: Prisma.TransactionClient, userId: string, sessionVersion: number, now: Date): Promise<void>;
  revokeOldRecoverySessions(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<void>;
  createRecoverySession(tx: Prisma.TransactionClient, session: NewRecoverySession): Promise<void>;
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
    async readOwnerTarget(tx, userId) {
      const rows = await tx.$queryRaw<(LockedRecoveryTarget & { role: string })[]>`
        SELECT id, role::text AS role, "sessionVersion", disabled, "totpEnabled"
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

    async lockRecoveryUser(tx, email) {
      const rows = await tx.$queryRaw<LockedRecoveryUser[]>`
        SELECT id, email, disabled, "totpEnabled", "recoveryCodes", "sessionVersion"
        FROM "User"
        WHERE email = ${email.toLowerCase()}
        FOR UPDATE
      `;
      return rows[0];
    },
    async consumePermit(tx, tokenHash, userId, sessionVersion, now) {
      const instant = Prisma.sql`(${now}::timestamptz AT TIME ZONE 'UTC')`;
      const rows = await tx.$queryRaw<ConsumedPermit[]>`
        UPDATE "AdminRecoveryPermit"
        SET "consumedAt" = ${instant}
        WHERE "tokenHash" = ${tokenHash}
          AND "targetUserId" = ${userId}
          AND "sessionVersion" = ${sessionVersion}
          AND "consumedAt" IS NULL
          AND "expiresAt" > ${instant}
        RETURNING id, source::text AS source, "pendingPasswordHash", "sessionVersion"
      `;
      return rows[0];
    },
    async consumeRecoveryCode(tx, userId, hash) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "User"
        SET "recoveryCodes" = array_remove("recoveryCodes", ${hash})
        WHERE id = ${userId}
          AND ${hash} = ANY("recoveryCodes")
        RETURNING id
      `;
      return rows.length === 1;
    },
    async bumpSessionVersion(tx, userId, now) {
      const rows = await tx.$queryRaw<{ sessionVersion: number }[]>`
        UPDATE "User"
        SET "sessionVersion" = "sessionVersion" + 1
        WHERE id = ${userId}
        RETURNING "sessionVersion"
      `;
      return rows[0]?.sessionVersion ?? 0;
    },
    async revokeOldDevices(tx, userId, sessionVersion, now) {
      await tx.adminDeviceSession.updateMany({
        where: { userId, revokedAt: null, sessionVersion: { lt: sessionVersion } },
        data: { revokedAt: now, revokedReason: 'recovery_start' },
      });
    },
    async revokeOldRecoverySessions(tx, userId, now) {
      await tx.adminRecoverySession.updateMany({
        where: { userId, revokedAt: null, completedAt: null },
        data: { revokedAt: now },
      });
    },
    async createRecoverySession(tx, session) {
      await tx.adminRecoverySession.create({ data: session });
    },
  };
}
