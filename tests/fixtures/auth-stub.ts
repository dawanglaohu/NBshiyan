// 测试用：替换 '@/auth'。会话由 globalThis.__testSession 提供。
// 真实守卫现在还要核对本机设备。这里给没有 sid 的夹具补一个固定设备，并在内存 prisma 上补查询，旧用例不用各写一行。
const FIXTURE_SID = 'fixturedevice0000000000000001';

type StubSession = { user?: { id?: string }; sv?: number; sid?: string } | null;

function sessionOf(): StubSession {
  return (globalThis as { __testSession?: StubSession }).__testSession ?? null;
}

export function fixtureDeviceApi() {
  return {
    async findUnique({ where }: { where: { id: string } }) {
      const current = sessionOf();
      if (!current?.user?.id || where.id !== (current.sid ?? FIXTURE_SID)) return null;
      const now = new Date();
      return {
        id: where.id,
        userId: current.user.id,
        sessionVersion: current.sv ?? 0,
        remembered: false,
        createdAt: now,
        lastActivityAt: now,
        absoluteExpiresAt: null,
        revokedAt: null,
        revokedReason: null,
        deviceLabel: null,
      };
    },
    async updateMany() { return { count: 0 }; },
  };
}

function ensureFixtureDevice() {
  const g = globalThis as { prisma?: { adminDeviceSession?: { findUnique: (args: { where: { id: string } }) => Promise<unknown>; updateMany: (args: unknown) => Promise<{ count: number }> } } };
  const db = g.prisma;
  if (!db || db.adminDeviceSession?.findUnique) return;
  const api = fixtureDeviceApi();
  try { db.adminDeviceSession = api; } catch { /* 只读代理由夹具自己挂上 */ }
}

export const auth = async () => {
  const session = sessionOf();
  if (!session || typeof session !== 'object') return session;
  if (!session.sid) session.sid = FIXTURE_SID;
  ensureFixtureDevice();
  return session;
};

export const handlers = {};
