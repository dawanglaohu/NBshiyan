// scripts/backfill-hard-expires-at.mjs 的逻辑（不自己创建客户端）。
// 不依赖 TypeScript 源码，standalone 镜像里可以直接用 node 运行。
//
// 部署时在 prisma db push 之后运行。只填 hardExpiresAt 仍为空的 AdminDeviceSession 行：
//   remembered = false → createdAt + 普通绝对时长
//   remembered = true  → createdAt + 记住设备绝对时长
// 已经有值的行不动，absoluteExpiresAt 也不动。可以重复执行。
//
// SQL 与 src/lib/server/admin/device-session.ts 的 backfillHardExpiresAt 相同。
// 时长必须等于 src/lib/server/config.ts 的 ADMIN_SESSION_POLICY
// （ordinaryAbsoluteMs = 12h，absoluteMs = 30d）。
// tests/backfill-hard-expires-at.test.ts 断言数值相等，并比对两条 UPDATE。

/** 必须等于 ADMIN_SESSION_POLICY.ordinaryAbsoluteMs（12 小时） */
export const ORDINARY_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
/** 必须等于 ADMIN_SESSION_POLICY.absoluteMs（30 天） */
export const REMEMBERED_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

/** 出错时唯一的输出（stderr）。不带异常信息、查询参数或连接串。 */
export const ERROR_LINE = 'error=backfill_failed\n';
/** 带了任何命令行参数时的输出。脚本不接受参数（尤其不接受数据库地址）。 */
export const USAGE_LINE = 'error=no_args_accepted\n';

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * 只填 hardExpiresAt 仍为空的行。
 * @param db 需要 $executeRaw 的 PrismaClient 或测试用的假对象
 * @param policy {{ ordinaryAbsoluteMs: number, absoluteMs: number }}
 * @returns {Promise<{ ordinary: number, remembered: number }>}
 */
export async function fillNullHardExpiresAt(db, policy) {
  const ordinarySeconds = policy.ordinaryAbsoluteMs / 1000;
  const rememberedSeconds = policy.absoluteMs / 1000;
  const ordinary = await db.$executeRaw`
    UPDATE "AdminDeviceSession"
    SET "hardExpiresAt" = "createdAt" + make_interval(secs => ${ordinarySeconds})
    WHERE "remembered" = false AND "hardExpiresAt" IS NULL
  `;
  const remembered = await db.$executeRaw`
    UPDATE "AdminDeviceSession"
    SET "hardExpiresAt" = "createdAt" + make_interval(secs => ${rememberedSeconds})
    WHERE "remembered" = true AND "hardExpiresAt" IS NULL
  `;
  return { ordinary: Number(ordinary), remembered: Number(remembered) };
}

/**
 * 跑一次回填并输出。所有异常都只输出 ERROR_LINE。
 * @param options.argv 命令行参数（必须为空）
 * @param options.backfill 返回 { ordinary, remembered }；创建客户端和断开连接由调用方负责
 * @param options.out / options.err 写 stdout / stderr
 * @returns {Promise<0 | 1 | 2>} 0 成功，1 失败，2 带了参数
 */
export async function runBackfill(options) {
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
