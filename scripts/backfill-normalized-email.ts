/**
 * 回填 Contact.normalizedEmail（部署 #200 后运行一次；可重复运行，只处理还没填的行）。
 *   pnpm tsx scripts/backfill-normalized-email.ts            # 实际写入
 *   pnpm tsx scripts/backfill-normalized-email.ts --dry-run  # 只统计
 * 每批 500 条，按 id 顺序。已匿名化的联系人（@invalid.invalid）跳过、保持 null。
 */
import { PrismaClient } from '@prisma/client';
import { normalizeEmail } from '../src/lib/server/sample';

export async function backfill(db: Pick<PrismaClient, 'contact'>, dryRun = false, batch = 500) {
  let cursor: string | undefined;
  let updated = 0, scanned = 0;
  for (;;) {
    const rows = await db.contact.findMany({
      where: { normalizedEmail: null, NOT: { email: { endsWith: '@invalid.invalid' } } },
      select: { id: true, email: true }, orderBy: { id: 'asc' }, take: batch,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    scanned += rows.length;
    cursor = rows[rows.length - 1].id;
    if (!dryRun) for (const r of rows) {
      updated += (await db.contact.updateMany({ where: { id: r.id, normalizedEmail: null }, data: { normalizedEmail: normalizeEmail(r.email) } })).count;
    }
    if (rows.length < batch) break;
  }
  return { scanned, updated };
}

if (process.argv[1]?.endsWith('backfill-normalized-email.ts')) {
  const db = new PrismaClient();
  backfill(db, process.argv.includes('--dry-run'))
    .then((r) => console.log(`回填完成：扫描 ${r.scanned} 条，更新 ${r.updated} 条`))
    .catch((e) => { console.error('回填失败', (e as Error).name); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
