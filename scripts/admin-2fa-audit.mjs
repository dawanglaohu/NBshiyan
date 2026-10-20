#!/usr/bin/env node
// #361 部署前门禁：统计 ADMIN 总数，和「绑定窗口（72 小时）已过、仍未绑定 2FA」的 ADMIN 数。只读，只输出两个数字。
//   docker compose … run --rm -T --no-deps app node scripts/admin-2fa-audit.mjs
//   （运行中的容器里：docker compose … exec -T app node scripts/admin-2fa-audit.mjs）
// 输出（stdout，恰好两行）：
//   admins=<n>
//   unbound_over_72h=<n>
// 出错：stderr 只有一行 error=audit_failed，退出码 1；带任何参数：error=no_args_accepted，退出码 2。
// 不接受任何参数（尤其是数据库地址），只用容器环境里应用自己的 DATABASE_URL 和 @prisma/client；不输出邮箱、id、名字、异常信息或连接串。
// 判定规则与 src/lib/server/admin/enroll-guard.ts 相同，见 admin-2fa-audit-lib.mjs。
import { runAudit } from './admin-2fa-audit-lib.mjs';

const code = await runAudit({
  argv: process.argv.slice(2),
  now: Date.now(),
  db: async () => {
    if (!process.env.DATABASE_URL) throw new Error('no database');
    const { PrismaClient } = await import('@prisma/client');
    return new PrismaClient({ log: [], errorFormat: 'minimal' });
  },
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
}).catch(() => { process.stderr.write('error=audit_failed\n'); return 1; });
process.exitCode = code;
