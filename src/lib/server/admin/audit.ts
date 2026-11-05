import { prisma } from '../db';
import type { Prisma, PrismaClient } from '@prisma/client';

export type AuditEntry = { actorId?: string | null; action: string; target?: string | null; meta?: Prisma.InputJsonValue; ip?: string | null };
export type AuditDb = PrismaClient | Prisma.TransactionClient;

/** 只记错误类型和代码，不带消息正文（可能含请求数据） */
export function errorSummary(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : typeof err;
  return typeof e?.code === 'string' ? `${name}:${e.code}`.slice(0, 80) : name.slice(0, 80);
}

function auditData(e: AuditEntry) {
  return { actorId: e.actorId ?? null, action: e.action, target: e.target ?? null, meta: e.meta, ip: e.ip || 'unknown' };
}

/** 只增不改的审计日志。写失败不影响主流程，但会打日志。 */
export async function audit(e: AuditEntry) {
  try {
    await prisma.auditLog.create({ data: auditData(e) });
  } catch (err) {
    console.error('[audit] write failed', { action: e.action, errorSummary: errorSummary(err) });
  }
}

/**
 * 事务内审计：与一次性凭据核销、敏感状态变更共用同一个 tx，失败会一起回滚。
 * 不吞异常，避免「动作成功但审计缺失」被当成成功。
 */
export async function auditInTx(tx: AuditDb, e: AuditEntry) {
  await tx.auditLog.create({ data: auditData(e) });
}
