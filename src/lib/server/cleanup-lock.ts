import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { prisma } from './db';

export const CLEANUP_LOCK = 'cron:cleanup-uploads';
type LockDb = { $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: { maxWait?: number; timeout?: number }): Promise<T> };

/** 持锁事务的超时：比路由 maxDuration（300s）略短，函数被平台终止前事务先结束、锁随之释放 */
export const LOCK_TX_TIMEOUT_MS = 290_000;

/**
 * 同一时间只允许一次清理（含 dry run）：在一个交互式事务里 pg_try_advisory_xact_lock，拿不到返回 409 cleanup_running。
 * 事务级锁随事务提交/回滚自动释放（fn 抛错、超时、连接断开都一样），不需要也不能手动 unlock，
 * 不会因为解锁失败或解锁落在别的连接上而把锁留在会话里。fn 运行期间这个事务一直占着一个连接；各清理步骤用自己的连接/事务。
 */
export async function withCleanupLock(fn: () => Promise<Response>, db: LockDb = prisma as unknown as LockDb): Promise<Response> {
  return db.$transaction(async (tx) => {
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${CLEANUP_LOCK})) AS locked`;
    if (!locked) return NextResponse.json({ error: 'cleanup_running' }, { status: 409 });
    return fn();
  }, { maxWait: 10_000, timeout: LOCK_TX_TIMEOUT_MS });
}
