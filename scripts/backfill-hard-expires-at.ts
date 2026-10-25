// 部署时在 prisma db push 之后运行。只填 hardExpiresAt 仍为空的设备行，可以重复执行。
// stdout 恰好两行：ordinary=<n> 和 remembered=<n>。不打印连接串、主机、邮箱或异常文本。
import { PrismaClient } from '@prisma/client';
import { backfillHardExpiresAt } from '../src/lib/server/admin/device-session';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';

export const ERROR_LINE = 'error=backfill_failed\n';
export const USAGE_LINE = 'error=no_args_accepted\n';

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

export async function runBackfill(options: {
  argv: readonly string[];
  backfill: () => Promise<{ ordinary: number; remembered: number }>;
  out: (chunk: string) => void;
  err: (chunk: string) => void;
}): Promise<number> {
  if (options.argv.length > 0) {
    options.err(USAGE_LINE);
    return 2;
  }
  try {
    const counts = await options.backfill();
    if (!isCount(counts.ordinary) || !isCount(counts.remembered)) throw new Error('bad counts');
    options.out(`ordinary=${counts.ordinary}\nremembered=${counts.remembered}\n`);
    return 0;
  } catch {
    options.err(ERROR_LINE);
    return 1;
  }
}

async function main() {
  const code = await runBackfill({
    argv: process.argv.slice(2),
    out: (chunk) => { process.stdout.write(chunk); },
    err: (chunk) => { process.stderr.write(chunk); },
    backfill: async () => {
      if (!process.env.DATABASE_URL) throw new Error('no database');
      const db = new PrismaClient({ log: [], errorFormat: 'minimal' });
      try {
        return await backfillHardExpiresAt(db, ADMIN_SESSION_POLICY);
      } finally {
        await db.$disconnect().catch(() => undefined);
      }
    },
  });
  process.exitCode = code;
}

const entry = process.argv[1]?.replaceAll('\\', '/');
if (entry?.endsWith('/scripts/backfill-hard-expires-at.ts')) void main();
