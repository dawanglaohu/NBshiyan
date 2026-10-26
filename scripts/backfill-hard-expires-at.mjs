#!/usr/bin/env node
// 部署时在 prisma db push 之后运行。只填 hardExpiresAt 仍为空的设备行，可以重复执行。
//   docker compose … exec -T app node scripts/backfill-hard-expires-at.mjs
//   pnpm admin:backfill-hard-expires
// stdout 恰好两行：
//   ordinary=<n>
//   remembered=<n>
// 出错：stderr 只有一行 error=backfill_failed，退出码 1。
// 带任何参数：error=no_args_accepted，退出码 2。
// 不接受任何参数（尤其是数据库地址），只用容器环境里应用自己的 DATABASE_URL 和 @prisma/client。
// 不打印连接串、主机、邮箱或异常文本。
// 时长与 SQL 见 backfill-hard-expires-at-lib.mjs（普通 12h，记住设备 30d）。
import { fillNullHardExpiresAt, ORDINARY_ABSOLUTE_MS, REMEMBERED_ABSOLUTE_MS, runBackfill } from './backfill-hard-expires-at-lib.mjs';

const code = await runBackfill({
  argv: process.argv.slice(2),
  out: (chunk) => { process.stdout.write(chunk); },
  err: (chunk) => { process.stderr.write(chunk); },
  backfill: async () => {
    if (!process.env.DATABASE_URL) throw new Error('no database');
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ log: [], errorFormat: 'minimal' });
    try {
      return await fillNullHardExpiresAt(db, {
        ordinaryAbsoluteMs: ORDINARY_ABSOLUTE_MS,
        absoluteMs: REMEMBERED_ABSOLUTE_MS,
      });
    } finally {
      await db.$disconnect().catch(() => undefined);
    }
  },
}).catch(() => { process.stderr.write('error=backfill_failed\n'); return 1; });
process.exitCode = code;
