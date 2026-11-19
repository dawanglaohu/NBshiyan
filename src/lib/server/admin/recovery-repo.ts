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

/**
 * M3-T5 R1：锁前只用来定位 User 行与账号限流主体的会话提示。
 * 它不参与任何成功/失败判定；所有授权状态必须在 User→session 两把锁之后重读。
 */
export type RecoverySessionHint = {
  userId: string;
  email: string;
};

/**
 * Prisma `DateTime` 列是 PostgreSQL `timestamp(3)`（无时区）。raw SQL 里直接绑 JS Date
 * 会被驱动按 timestamptz 发送，再按会话时区落到 timestamp，产生整时区偏移；
 * 既有 `consumePermit` 已用 `($n::timestamptz AT TIME ZONE 'UTC')` 统一成 UTC 墙上时间。
 * 新 raw 写/比较必须走同一转换。
 */
function utcWall(value: Date): Prisma.Sql {
  return Prisma.sql`(${value}::timestamptz AT TIME ZONE 'UTC')`;
}

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

/** M3-T5：受限会话行。confirm 在锁内重读 pending/sv/期限/失败计数，不用锁前快照。 */
export type LockedRecoverySession = {
  id: string;
  userId: string;
  sessionVersion: number;
  source: 'RECOVERY_CODE' | 'ADMIN' | 'SERVER_OWNER' | 'SELF_REAUTH';
  expiresAt: Date;
  pendingSecretEncrypted: string | null;
  pendingUntil: Date | null;
  pendingPasswordHash: string | null;
  passwordResetSource: string | null;
  failedAttempts: number;
  completedAt: Date | null;
  revokedAt: Date | null;
};

/** M3-T5：最终确认要核对的 User 因素；只投必要列，不把整行 User 快照带进事务外。 */
export type LockedRecoveryFactors = {
  id: string;
  email: string;
  disabled: boolean;
  totpEnabled: boolean;
  totpSecret: string | null;
  recoveryCodes: string[];
  sessionVersion: number;
  passwordHash: string;
};

/** 最终确认的原子 User CAS 输入：新 secret/step/恢复码/sv+1 同一条 UPDATE。 */
export type CommitRecoveredFactors = {
  userId: string;
  expectedSessionVersion: number;
  expectedTotpSecret: string | null;
  newTotpSecretEncrypted: string;
  totpLastStep: number;
  recoveryCodeHashes: string[];
  /** 仅 SERVER_OWNER 的受限会话才带；HTTP 永不写。 */
  pendingPasswordHash: string | null;
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
  revokeOldDevices(tx: Prisma.TransactionClient, userId: string, sessionVersion: number, now: Date, reason?: string): Promise<void>;
  revokeOldRecoverySessions(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<void>;
  createRecoverySession(tx: Prisma.TransactionClient, session: NewRecoverySession): Promise<void>;

  /**
   * M3-T20：本人换验证器先锁 User→Device，确认账号仍启用 2FA 且当前设备属于本人、未撤销、sv 未变。
   * 锁序与 action-grant 的 consumeLocked 相同（User 再 Device），可与其在同一事务里重入。
   * 返回 undefined 表示会话/设备已不可用；sv 递增由调用方在同一事务完成。
   */
  lockActiveAccountForSelfRebind(tx: Prisma.TransactionClient, userId: string, sid: string): Promise<{ sessionVersion: number } | undefined>;
  /** M3-T5：无锁读 tokenHash 对应的 userId/email，只用于选定要锁的 User 行与账号桶主体。 */
  readRecoverySessionHint(db: RecoveryDb, tokenHash: string): Promise<RecoverySessionHint | undefined>;
  /**
   * M3-T5：按 tokenHash 锁受限会话行。固定锁序 User→session：confirm/enroll 必须先
   * `lockRecoveryFactors` 再调它，否则与 start 的 User 锁交叉成 ABBA。
   */
  lockRecoverySession(tx: Prisma.TransactionClient, tokenHash: string): Promise<LockedRecoverySession | undefined>;
  /** M3-T5：按 userId 锁 User 行并只取最终确认需要的因素列；enroll/confirm 的第一把锁。 */
  lockRecoveryFactors(tx: Prisma.TransactionClient, userId: string): Promise<LockedRecoveryFactors | undefined>;
  /** 首次 pending 写入的 CAS：只有待确认列仍为空、会话未完成/未撤销/未过期且 sv 相符时成功。 */
  setPendingSecret(tx: Prisma.TransactionClient, sessionId: string, encrypted: string, until: Date, now: Date, sessionVersion: number): Promise<boolean>;
  /** 过期/作废：持久撤销受限会话并清掉 pending，不从只读检查里返回。 */
  revokeRecoverySession(tx: Prisma.TransactionClient, sessionId: string, now: Date): Promise<void>;
  /** 错码 +1 与第 5 次作废合并成一条 UPDATE；拒绝分支的副作用不能在 throw 时被回滚。 */
  recordConfirmFailure(tx: Prisma.TransactionClient, sessionId: string, now: Date): Promise<number | undefined>;
  /** 成功领取受限会话：completedAt 置位并清 pending；条件不满足时整组回滚。 */
  completeRecoverySession(tx: Prisma.TransactionClient, sessionId: string, now: Date, expectedPendingSecret: string, sessionVersion: number): Promise<boolean>;
  /** 成功后撤销同账号其他未完成受限会话；当前这条不撤，置 completedAt。 */
  revokeOtherRecoverySessions(tx: Prisma.TransactionClient, userId: string, keepSessionId: string, now: Date): Promise<void>;
  /** 最终原子发布：新 secret/step/恢复码/sv+1（SERVER_OWNER 时含密码）一条 UPDATE，返回新 sv。 */
  commitRecoveredFactors(tx: Prisma.TransactionClient, input: CommitRecoveredFactors): Promise<number | undefined>;
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
    async revokeOldDevices(tx, userId, sessionVersion, now, reason = 'recovery_start') {
      await tx.adminDeviceSession.updateMany({
        where: { userId, revokedAt: null, sessionVersion: { lt: sessionVersion } },
        data: { revokedAt: now, revokedReason: reason },
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

    async lockActiveAccountForSelfRebind(tx, userId, sid) {
      const users = await tx.$queryRaw<{ sessionVersion: number; disabled: boolean; totpEnabled: boolean }[]>`
        SELECT "sessionVersion", disabled, "totpEnabled"
        FROM "User"
        WHERE id = ${userId}
        FOR UPDATE
      `;
      const user = users[0];
      if (!user || user.disabled || !user.totpEnabled) return undefined;
      const devices = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM "AdminDeviceSession"
        WHERE id = ${sid}
          AND "userId" = ${userId}
          AND "revokedAt" IS NULL
          AND "sessionVersion" = ${user.sessionVersion}
        FOR UPDATE
      `;
      if (devices.length !== 1) return undefined;
      return { sessionVersion: user.sessionVersion };
    },

    async readRecoverySessionHint(db, tokenHash) {
      const rows = await db.$queryRaw<RecoverySessionHint[]>`
        SELECT s."userId", u."email"
        FROM "AdminRecoverySession" AS s
        JOIN "User" AS u ON u.id = s."userId"
        WHERE s."tokenHash" = ${tokenHash}
      `;
      return rows[0];
    },
    async lockRecoverySession(tx, tokenHash) {
      const rows = await tx.$queryRaw<LockedRecoverySession[]>`
        SELECT id, "userId", "sessionVersion", source::text AS source, "expiresAt",
               "pendingSecretEncrypted", "pendingUntil", "pendingPasswordHash",
               "passwordResetSource", "failedAttempts", "completedAt", "revokedAt"
        FROM "AdminRecoverySession"
        WHERE "tokenHash" = ${tokenHash}
        FOR UPDATE
      `;
      return rows[0];
    },
    async lockRecoveryFactors(tx, userId) {
      const rows = await tx.$queryRaw<LockedRecoveryFactors[]>`
        SELECT id, email, disabled, "totpEnabled", "totpSecret", "recoveryCodes",
               "sessionVersion", "passwordHash"
        FROM "User"
        WHERE id = ${userId}
        FOR UPDATE
      `;
      return rows[0];
    },
    async setPendingSecret(tx, sessionId, encrypted, until, now, sessionVersion) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "AdminRecoverySession"
        SET "pendingSecretEncrypted" = ${encrypted}, "pendingUntil" = ${utcWall(until)}
        WHERE id = ${sessionId}
          AND "sessionVersion" = ${sessionVersion}
          AND "completedAt" IS NULL
          AND "revokedAt" IS NULL
          AND "expiresAt" > ${utcWall(now)}
          AND "pendingSecretEncrypted" IS NULL
          AND "pendingUntil" IS NULL
        RETURNING id
      `;
      return rows.length === 1;
    },
    async revokeRecoverySession(tx, sessionId, now) {
      await tx.adminRecoverySession.updateMany({
        where: { id: sessionId, revokedAt: null, completedAt: null },
        data: { revokedAt: now, pendingSecretEncrypted: null, pendingUntil: null },
      });
    },
    async recordConfirmFailure(tx, sessionId, now) {
      const rows = await tx.$queryRaw<{ failedAttempts: number }[]>`
        UPDATE "AdminRecoverySession"
        SET "failedAttempts" = "failedAttempts" + 1,
            "revokedAt" = CASE WHEN "failedAttempts" + 1 >= 5 THEN ${utcWall(now)} ELSE "revokedAt" END,
            "pendingSecretEncrypted" = CASE WHEN "failedAttempts" + 1 >= 5 THEN NULL ELSE "pendingSecretEncrypted" END,
            "pendingUntil" = CASE WHEN "failedAttempts" + 1 >= 5 THEN NULL ELSE "pendingUntil" END
        WHERE id = ${sessionId}
          AND "failedAttempts" < 5
          AND "completedAt" IS NULL
          AND "revokedAt" IS NULL
        RETURNING "failedAttempts"
      `;
      return rows[0]?.failedAttempts;
    },
    async completeRecoverySession(tx, sessionId, now, expectedPendingSecret, sessionVersion) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "AdminRecoverySession"
        SET "completedAt" = ${utcWall(now)},
            "pendingSecretEncrypted" = NULL,
            "pendingUntil" = NULL
        WHERE id = ${sessionId}
          AND "sessionVersion" = ${sessionVersion}
          AND "completedAt" IS NULL
          AND "revokedAt" IS NULL
          AND "pendingSecretEncrypted" = ${expectedPendingSecret}
          AND "pendingUntil" IS NOT NULL
          AND "pendingUntil" > ${utcWall(now)}
        RETURNING id
      `;
      return rows.length === 1;
    },
    async revokeOtherRecoverySessions(tx, userId, keepSessionId, now) {
      await tx.adminRecoverySession.updateMany({
        where: { userId, id: { not: keepSessionId }, revokedAt: null, completedAt: null },
        data: { revokedAt: now },
      });
    },
    async commitRecoveredFactors(tx, input) {
      const hashes = Prisma.sql`ARRAY[${Prisma.join(input.recoveryCodeHashes)}]::text[]`;
      const rows = await tx.$queryRaw<{ sessionVersion: number }[]>`
        UPDATE "User"
        SET "totpSecret" = ${input.newTotpSecretEncrypted},
            "totpEnabled" = true,
            "totpLastStep" = ${input.totpLastStep},
            "recoveryCodes" = ${hashes},
            "sessionVersion" = "sessionVersion" + 1,
            "passwordHash" = COALESCE(${input.pendingPasswordHash}::text, "passwordHash")
        WHERE id = ${input.userId}
          AND "sessionVersion" = ${input.expectedSessionVersion}
          AND "totpSecret" IS NOT DISTINCT FROM ${input.expectedTotpSecret}
          AND "totpEnabled" = true
        RETURNING "sessionVersion"
      `;
      return rows[0]?.sessionVersion;
    },
  };
}
