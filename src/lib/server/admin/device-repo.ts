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

/** 账号会话版本变化之后，把仍未撤销的设备行标成撤销。调用方先写 User。 */
export async function revokeUserDevices(db: Pick<PrismaClient, 'adminDeviceSession'>, userId: string, reason: string, now = new Date()) {
  await db.adminDeviceSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  });
}
