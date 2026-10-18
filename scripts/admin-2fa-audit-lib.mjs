// scripts/admin-2fa-audit.mjs 的纯逻辑（不连库），单独放一个文件方便用假的 prisma 测试。
// 不依赖 TypeScript 源码，standalone 镜像里可以直接用 node 运行。
//
// 用途：#361（#347 绑定窗口）部署前的门禁。统计
//   admins            = 未停用的 ADMIN 总数
//   unbound_over_72h  = 其中 totpEnabled=false、且绑定窗口已关闭的 ADMIN 数
// 绑定窗口与 src/lib/server/admin/enroll-guard.ts 的 enrollWindowOpen 完全相同：
//   起点 = enrollIssuedAt（重置 2FA 时写入）?? createdAt；now >= 起点 + 72 小时 即关闭。
// #361 上线后这些账号就不能再自己绑定，只能由另一个 ADMIN 重置 2FA。
//
// 只读：只调用 user.count，不 select 任何字段，所以不会读到邮箱、id、名字。

/** 必须等于 enroll-guard.ts 的 ENROLL_WINDOW_MS（tests/admin-2fa-audit.test.ts 断言两者相等、判定一致） */
export const ENROLL_WINDOW_MS = 72 * 3_600_000;

/** 出错时唯一的输出（stderr）。不带异常信息、查询参数或连接串。 */
export const ERROR_LINE = 'error=audit_failed';
/** 带了任何命令行参数时的输出。脚本不接受参数（尤其不接受数据库地址）。 */
export const USAGE_LINE = 'error=no_args_accepted';

/** 绑定窗口已关闭的 where（等价于 !enrollWindowOpen(u, now)） */
export function windowClosedWhere(now) {
  const cutoff = new Date(now - ENROLL_WINDOW_MS);
  return { OR: [{ enrollIssuedAt: { lte: cutoff } }, { enrollIssuedAt: null, createdAt: { lte: cutoff } }] };
}

/** 只在 createdAt 上判断（库里还没有 #361 的 enrollIssuedAt 列时用；那时所有账号的起点本来就是 createdAt） */
export function windowClosedWhereCreatedOnly(now) {
  return { createdAt: { lte: new Date(now - ENROLL_WINDOW_MS) } };
}

const ACTIVE_ADMIN = { role: 'ADMIN', disabled: false };

/** Prisma P2022 = 列不存在。#361 的 db push 之前跑，库里还没有 enrollIssuedAt。 */
const isMissingColumn = (e) => !!e && typeof e === 'object' && e.code === 'P2022';

/**
 * @param db 只需要 user.count（PrismaClient 或测试用的假对象）
 * @param now 毫秒时间戳
 * @returns {{ admins: number, unboundOver72h: number }}
 */
export async function countAdmin2faAudit(db, now) {
  if (!Number.isFinite(now)) throw new TypeError('now');
  const admins = await db.user.count({ where: ACTIVE_ADMIN });
  const unboundBase = { ...ACTIVE_ADMIN, totpEnabled: false };
  let unboundOver72h;
  try {
    unboundOver72h = await db.user.count({ where: { ...unboundBase, ...windowClosedWhere(now) } });
  } catch (e) {
    // 部署 #361 之前（db push 之前）库里没有 enrollIssuedAt：此时起点都是 createdAt，部署后 enrollIssuedAt 也都是 null，结果相同
    if (!isMissingColumn(e)) throw e;
    unboundOver72h = await db.user.count({ where: { ...unboundBase, ...windowClosedWhereCreatedOnly(now) } });
  }
  for (const n of [admins, unboundOver72h]) if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('count');
  return { admins, unboundOver72h };
}

/** 恰好两行 */
export function formatAudit({ admins, unboundOver72h }) {
  return `admins=${admins}\nunbound_over_72h=${unboundOver72h}\n`;
}

/**
 * 跑一次统计并输出。所有异常都只输出 ERROR_LINE；无论成功失败都断开连接。
 * @param o.db  有 user.count 和 $disconnect 的对象；也可以是返回它的函数（创建客户端本身出错也按 audit_failed 处理）
 * @param o.now 毫秒时间戳
 * @param o.argv 命令行参数（必须为空）
 * @param o.out / o.err 写 stdout / stderr 的函数
 * @returns 退出码：0 成功，1 统计失败，2 带了参数
 */
export async function runAudit({ db, now, argv = [], out, err }) {
  if (argv.length > 0) { err(`${USAGE_LINE}\n`); return 2; }
  let client;
  try {
    client = typeof db === 'function' ? await db() : db;
    const text = formatAudit(await countAdmin2faAudit(client, now));
    out(text);
    return 0;
  } catch {
    err(`${ERROR_LINE}\n`);
    return 1;
  } finally {
    try { await client?.$disconnect?.(); } catch { /* 断开失败不影响结果，也不输出 */ }
  }
}
