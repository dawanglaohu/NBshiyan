import { prisma } from '../db';
import type { Prisma } from '@prisma/client';

/** 只记错误类型和代码，不带消息正文（可能含请求数据） */
export function errorSummary(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : typeof err;
  return typeof e?.code === 'string' ? `${name}:${e.code}`.slice(0, 80) : name.slice(0, 80);
}

/** 只增不改的审计日志。写失败不影响主流程，但会打日志。 */
export async function audit(e: { actorId?: string | null; action: string; target?: string | null; meta?: Prisma.InputJsonValue; ip?: string | null }) {
  try {
    await prisma.auditLog.create({ data: { actorId: e.actorId ?? null, action: e.action, target: e.target ?? null, meta: e.meta, ip: e.ip ?? null } });
  } catch (err) {
    console.error('[audit] write failed', { action: e.action, errorSummary: errorSummary(err) });
  }
}
