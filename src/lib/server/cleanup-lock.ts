import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from './db';
import { errorSummary } from './mail';

export const CLEANUP_LOCK = 'cron:cleanup-uploads';
type LockDb = { $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: { maxWait?: number; timeout?: number }): Promise<T> };

/**
 * 同一时间只允许一次清理（含 dry run）：pg_try_advisory_lock 拿不到返回 409 cleanup_running；finally 里 pg_advisory_unlock。
 * 会话级锁的加锁和解锁必须在同一个数据库连接上，Prisma 连接池不保证这一点，
 * 所以用一个交互式事务占住一个连接，加锁、等待清理结束、解锁都在这个连接上做；各清理步骤仍用自己的连接。
 */
export async function withCleanupLock(fn: () => Promise<Response>, db: LockDb = prisma as unknown as LockDb): Promise<Response> {
  return db.$transaction(async (tx) => {
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${CLEANUP_LOCK})) AS locked`;
    if (!locked) return NextResponse.json({ error: 'cleanup_running' }, { status: 409 });
    try {
      return await fn();
    } finally {
      await tx.$queryRaw`SELECT pg_advisory_unlock(hashtext(${CLEANUP_LOCK}))`.catch((e: unknown) => console.error('[cron] cleanup unlock failed', errorSummary(e)));
    }
  }, { maxWait: 10_000, timeout: 290_000 });
}
