import { prisma } from '../db';
import type { Prisma } from '@prisma/client';

/** 只增不改的审计日志。写失败不影响主流程，但会打日志。 */
export async function audit(e: { actorId?: string | null; action: string; target?: string | null; meta?: Prisma.InputJsonValue; ip?: string | null }) {
  try {
    await prisma.auditLog.create({ data: { actorId: e.actorId ?? null, action: e.action, target: e.target ?? null, meta: e.meta, ip: e.ip ?? null } });
  } catch (err) {
    console.error('[audit] write failed', e.action, err);
  }
}
