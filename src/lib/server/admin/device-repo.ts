import type { AdminDeviceSession, Prisma, PrismaClient, User } from '@prisma/client';

type QueryClient = PrismaClient | Prisma.TransactionClient;

export type DeviceRepo = {
  findUser(id: string): Promise<User | null>;
  findDevice(id: string): Promise<AdminDeviceSession | null>;
  create(data: Prisma.AdminDeviceSessionUncheckedCreateInput): Promise<AdminDeviceSession>;
  revokeSid(id: string, reason: string, now: Date): Promise<void>;
  revokeUser(userId: string, reason: string, now: Date): Promise<void>;
  transaction<T>(run: (repo: DeviceRepo) => Promise<T>): Promise<T>;
};

function bind(db: QueryClient): Omit<DeviceRepo, 'transaction'> {
  return {
    findUser: (id) => db.user.findUnique({ where: { id } }),
    findDevice: (id) => db.adminDeviceSession.findUnique({ where: { id } }),
    create: (data) => db.adminDeviceSession.create({ data }),
    async revokeSid(id, reason, now) {
      await db.adminDeviceSession.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      });
    },
    async revokeUser(userId, reason, now) {
      await db.adminDeviceSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      });
    },
  };
}

export function createDeviceRepo(db: PrismaClient): DeviceRepo {
  return {
    ...bind(db),
    transaction: (run) => db.$transaction((tx) => run(createDeviceRepo(tx as PrismaClient))),
  };
}

export type DevicePosition = { createdAt: Date; id: string };
export type ListedDevice = Pick<AdminDeviceSession, 'id' | 'remembered' | 'createdAt' | 'lastActivityAt' | 'absoluteExpiresAt' | 'hardExpiresAt' | 'revokedAt' | 'deviceLabel'>;

/** 设备管理查询接显式 db/tx；敏感动作先由 ActionGrant 按 User→Device→Grant 锁序核销。 */
export function createDeviceManagementRepo() {
  const select = {
    id: true, remembered: true, createdAt: true, lastActivityAt: true,
    absoluteExpiresAt: true, hardExpiresAt: true, revokedAt: true, deviceLabel: true,
  } as const;
  return {
    findCursor(db: QueryClient, userId: string, cursor: DevicePosition): Promise<{ id: string } | null> {
      return db.adminDeviceSession.findFirst({ where: { userId, id: cursor.id, createdAt: cursor.createdAt }, select: { id: true } });
    },
    list(db: QueryClient, userId: string, limit: number, cursor: DevicePosition | null): Promise<ListedDevice[]> {
      return db.adminDeviceSession.findMany({
        where: {
          userId,
          ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
        },
        select,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
    },
    /** 同账号动作已持 User 行锁；再锁目标设备不会与另一设备管理动作交叉加锁。 */
    async readOwnedTarget(tx: Prisma.TransactionClient, userId: string, id: string) {
      const rows = await tx.$queryRaw<{ id: string; revokedAt: Date | null }[]>`
        SELECT id, "revokedAt" FROM "AdminDeviceSession"
        WHERE "userId" = ${userId} AND id = ${id}
        FOR UPDATE
      `;
      return rows[0];
    },
    async revokeOwned(tx: Prisma.TransactionClient, userId: string, id: string, now: Date) {
      const result = await tx.adminDeviceSession.updateMany({
        where: { userId, id, revokedAt: null }, data: { revokedAt: now, revokedReason: 'device_revoke' },
      });
      return result.count;
    },
    readVersion(tx: Prisma.TransactionClient, userId: string): Promise<{ sessionVersion: number } | null> {
      return tx.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } });
    },
    async incrementVersion(tx: Prisma.TransactionClient, userId: string, sessionVersion: number) {
      const result = await tx.user.updateMany({ where: { id: userId, sessionVersion }, data: { sessionVersion: { increment: 1 } } });
      return result.count;
    },
    async revokePreviousVersion(tx: Prisma.TransactionClient, userId: string, committedVersion: number, now: Date) {
      await revokeUserDevices(tx, userId, 'logout_all', committedVersion, now);
    },
  };
}
export type DeviceManagementRepo = ReturnType<typeof createDeviceManagementRepo>;

/** 只撤销已提交账号版本之前的设备；提交之后新登录的设备不在撤销范围。 */
export async function revokeUserDevices(db: Pick<PrismaClient, 'adminDeviceSession'>, userId: string, reason: string, committedSessionVersion: number, now = new Date()) {
  await db.adminDeviceSession.updateMany({
    where: { userId, revokedAt: null, sessionVersion: { lt: committedSessionVersion } },
    data: { revokedAt: now, revokedReason: reason },
  });
}
