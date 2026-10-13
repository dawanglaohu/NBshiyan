import { createHash } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { storage as defaultStorage, type PrivateStorage } from './storage';
import { anonymizedContact, anonymizeInquiryOps, deleteLogoFiles } from './privacy';
import { BATCH_SIZE, inBatches, maxPerRun, daysAgo } from './retention';
import { assertNotLastActiveAdmin, LastAdminError } from './admin/last-admin';
import { disableUserTx } from './admin/accounts';

function intEnv(name: string, def: number, min: number, max: number) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}
/** 后台账号闲置多少天自动停用 */
export const adminInactiveDays = () => intEnv('ADMIN_INACTIVE_DAYS', 90, 7, 3650);

export const expiredInquiryWhere = (now = new Date()) => ({ retainUntil: { lt: now }, anonymizedAt: null });

/**
 * 保留期到期（retainUntil < now）且未匿名化的询盘：用和手动删除同一套逻辑匿名化（anonymizeInquiryOps），
 * 删除绑定的 logo（记录 + 文件），标记 anonymizedAt 保证幂等。
 * 联系人只有在其名下没有其他未匿名化询盘时才匿名化（同一客户较新的询盘不受影响）。
 * 每批 BATCH_SIZE（500）条，每次运行最多 RETENTION_MAX_PER_RUN。返回处理的询盘条数。
 */
export async function anonymizeExpiredInquiries(db: PrismaClient, now = new Date(), cap = maxPerRun(), storage: PrivateStorage = defaultStorage) {
  return inBatches(
    async (take) => (await db.inquiry.findMany({ where: expiredInquiryWhere(now), select: { id: true }, orderBy: { retainUntil: 'asc' }, take })).map((r) => r.id),
    async (ids) => {
      const rows = await db.inquiry.findMany({ where: { id: { in: ids }, anonymizedAt: null }, select: { id: true, contactId: true } });
      const inqIds = rows.map((r) => r.id);
      if (!inqIds.length) return 0;
      const contactIds = [...new Set(rows.map((r) => r.contactId))];
      const stillActive = new Set((await db.inquiry.findMany({ where: { contactId: { in: contactIds }, anonymizedAt: null, id: { notIn: inqIds } }, select: { contactId: true } })).map((r) => r.contactId));
      const toAnon = contactIds.filter((c) => !stillActive.has(c));
      const logos = await db.logoUpload.findMany({ where: { inquiryId: { in: inqIds } }, select: { id: true, path: true } });
      await db.$transaction([
        ...toAnon.map((c) => db.contact.update({ where: { id: c }, data: anonymizedContact(createHash('sha256').update(`retention:${c}`).digest('hex')) })),
        ...(await anonymizeInquiryOps(db, inqIds, logos.map((l) => l.id), now)),
      ]);
      await deleteLogoFiles(logos, storage);
      return inqIds.length;
    }, cap);
}

/** 闲置判断：max(lastLoginAt, reactivatedAt, createdAt) 早于 cutoff；从未登录（lastLoginAt=null）按 createdAt 算 */
export function inactiveWhere(cutoff: Date): Prisma.UserWhereInput {
  return {
    disabled: false,
    createdAt: { lt: cutoff },
    AND: [
      { OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: cutoff } }] },
      { OR: [{ reactivatedAt: null }, { reactivatedAt: { lt: cutoff } }] },
    ],
  };
}

type AuditFn = (e: { actorId: string; action: string; target: string; meta: Prisma.InputJsonValue }) => Promise<void>;
/**
 * 闲置超过 ADMIN_INACTIVE_DAYS 的后台账号自动停用（不删除），走和手动停用同一路径（disableUserTx：会话失效 + 取消询盘分配），
 * 审计 actor = system。最后一个有效 ADMIN 不停用：检查和停用在同一事务里（assertNotLastActiveAdmin 用 SELECT … FOR UPDATE 锁有效 ADMIN 行）。
 */
export async function disableInactiveUsers(db: PrismaClient, audit: AuditFn, now = new Date()) {
  const days = adminInactiveDays();
  const cutoff = daysAgo(days, now);
  const candidates = await db.user.findMany({ where: inactiveWhere(cutoff), select: { id: true }, orderBy: { createdAt: 'asc' }, take: BATCH_SIZE });
  let disabled = 0, skippedLastAdmin = 0;
  for (const { id } of candidates) {
    try {
      const done = await db.$transaction(async (tx) => {
        await assertNotLastActiveAdmin(tx, id);
        // 锁内重新确认仍满足闲置条件（期间可能刚登录或被重新启用）
        if (!(await tx.user.findFirst({ where: { id, ...inactiveWhere(cutoff) }, select: { id: true } }))) return false;
        await disableUserTx(tx, id);
        return true;
      });
      if (done) { disabled++; await audit({ actorId: 'system', action: 'user.disable_inactive', target: id, meta: { inactiveDays: days } }); }
    } catch (e) {
      if (e instanceof LastAdminError) { skippedLastAdmin++; continue; }
      throw e;
    }
  }
  if (skippedLastAdmin) console.warn('[retention] inactive last ADMIN not disabled', { count: skippedLastAdmin });
  return disabled;
}
