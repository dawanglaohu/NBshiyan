import type { Prisma } from '@prisma/client';

export class LastAdminError extends Error {
  constructor() { super('last_admin'); this.name = 'LastAdminError'; }
}

/**
 * 停用或降级账号前调用：如果 userId 是唯一的有效 ADMIN（role=ADMIN 且未停用），抛 LastAdminError。
 *
 * 用 SELECT ... FOR UPDATE 锁住所有有效 ADMIN 行，并发事务会在这里排队；
 * 前一个事务提交后，被停用的行不再满足条件，后一个事务看到的是最新状态，
 * 所以两个并发请求不可能各停用一个、把最后两个 ADMIN 都去掉。
 *
 * **调用方必须在同一个 `prisma.$transaction(async (tx) => …)` 里先调用它，再执行停用 / 降级的写入**，
 * 否则锁在写入前就释放了，检查无效。
 */
export async function assertNotLastActiveAdmin(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE role = 'ADMIN' AND disabled = false ORDER BY id FOR UPDATE`;
  if (!rows.some((r) => r.id === userId)) return; // 目标不是有效 ADMIN，不影响
  if (rows.length <= 1) throw new LastAdminError();
}
