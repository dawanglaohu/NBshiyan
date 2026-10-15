import type { PrismaClient } from '@prisma/client';
import { expiredDesignsWhere } from './designs';
import { orphanLogoWhere } from './uploads';
import { auditLogsWhere, sampleCountersWhere } from './retention';
import { expiredInquiryWhere, inactiveWhere, adminInactiveDays } from './retention-enforce';
import { daysAgo } from './retention';

/** RETENTION_DRY_RUN=1：定时清理只统计，不写库、不删文件、不写审计 */
export const isRetentionDryRun = (env: NodeJS.ProcessEnv = process.env) => env.RETENTION_DRY_RUN === '1';

/** 只读的数据库方法（dry run 只允许用这些） */
export type ReadOnlyDb = {
  sharedDesign: Pick<PrismaClient['sharedDesign'], 'count'>;
  logoUpload: Pick<PrismaClient['logoUpload'], 'count'>;
  sampleRequest: Pick<PrismaClient['sampleRequest'], 'count'>;
  auditLog: Pick<PrismaClient['auditLog'], 'count'>;
  inquiry: Pick<PrismaClient['inquiry'], 'count'>;
  user: Pick<PrismaClient['user'], 'findMany'>;
};

/**
 * 各步骤这次会处理多少条（不受 RETENTION_MAX_PER_RUN 限制，是全部待处理数）。
 * 说明：真实运行时先删过期方案，部分 logo 会因此变成孤儿，所以 orphanLogos 可能比真实运行时少。
 * 只做 count / findMany（只取 id、role、disabled），不读取任何个人信息。
 */
export async function retentionDryRunCounts(db: ReadOnlyDb, now = new Date()) {
  const inqWhere = expiredInquiryWhere(now);
  const [designs, orphanLogos, sampleCounters, auditLogs, inquiries, inquiryLogos] = await Promise.all([
    db.sharedDesign.count({ where: expiredDesignsWhere(now) }),
    db.logoUpload.count({ where: orphanLogoWhere(now) }),
    db.sampleRequest.count({ where: sampleCountersWhere(now) }),
    db.auditLog.count({ where: auditLogsWhere(now) }),
    db.inquiry.count({ where: inqWhere }),
    db.logoUpload.count({ where: { inquiry: inqWhere } }),
  ]);
  // 闲置账号：按真实运行的顺序（createdAt 升序）模拟“最后一个有效 ADMIN 不停用”
  const cutoff = daysAgo(adminInactiveDays(), now);
  const candidates = await db.user.findMany({ where: inactiveWhere(cutoff), select: { id: true, role: true }, orderBy: { createdAt: 'asc' } });
  let activeAdmins = (await db.user.findMany({ where: { role: 'ADMIN', disabled: false }, select: { id: true } })).length;
  let inactiveUsers = 0, skippedLastAdmin = 0;
  for (const c of candidates) {
    if (c.role === 'ADMIN') {
      if (activeAdmins <= 1) { skippedLastAdmin++; continue; }
      activeAdmins--;
    }
    inactiveUsers++;
  }
  return { designs, orphanLogos, sampleCounters, auditLogs, inquiries, inquiryLogos, inactiveUsers, skippedLastAdmin };
}
