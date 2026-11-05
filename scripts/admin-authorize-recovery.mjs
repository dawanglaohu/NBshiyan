#!/usr/bin/env node
// 服务器所有者本地恢复预授权 CLI（M3-T18 / E-12）。只在服务器本机、以操作系统管理权限、在交互式终端里运行。
//   docker compose exec -it app node scripts/admin-authorize-recovery.mjs --email <邮箱> --reason "<原因>" [--role ADMIN] [--set-password]
//   （或 --id <账号 id>；--email 与 --id 二选一，不接受模糊匹配）
// 作用：为一个明确的目标账号签发 15 分钟、单次使用的恢复 permit（source = SERVER_OWNER），供 M3-T19 的受限恢复流程核销。
// 场景：验证器与全部恢复码同时丢失、且没有第二管理员（C-04）。这是唯一的本地出口，不经过 HTTP。
//
// 安全规则（09/10 节、E-75）：
// - 必须同时满足「具备 OS 管理权限」与「stdin/stdout 都是终端」。任一不满足都在连库与签发之前拒绝，什么都不写。
//   凭据只打印一次到终端，绝不落进文件、管道或日志，所以必须用 exec -it。
// - 只签发 permit，绝不修改目标账号的任何认证因素（passwordHash / totpSecret / recoveryCodes / sessionVersion 全部原样）。
// - 可选改密：--set-password 时在终端隐藏输入两次，沿用后台同一套 argon2id 参数；算出的 hash 只写进 permit 的
//   pendingPasswordHash，由核销后的受限会话生效。此刻原密码与 TOTP 都不变。HTTP 层永不接收该字段。
// - 审计只记 actor / target / source / time / reason；凭据、哈希、密钥、邮箱明文一律不进。
// - 不提供任何「清空 2FA」「跳过 TOTP」「改角色」的参数；--role 只用于校验一致，不一致即拒绝。
// 退出码：0 成功；1 运行错误；2 参数或终端错误；3 权限/账号状态拒绝。
//
// 依赖只有 @prisma/client 和 @node-rs/argon2（应用本身就用，standalone 产物里都有）。
// 与 src/lib/server/admin/owner-recovery.ts 的判定规则保持一致（tests/admin-owner-recovery-cli.test.ts 逐项比对）。
import { randomBytes, createHash } from 'node:crypto';

/** 必须等于 src/lib/server/config.ts 的 ADMIN_GRANT_POLICY.permitTtlMs（测试断言两者相等） */
export const PERMIT_TTL_MS = 15 * 60_000;
/** 必须等于 scripts/admin-create-lib.mjs 的 ARGON（后台改密码同一套参数） */
export const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const VIA = 'cli:admin-authorize-recovery';
export const REASON_MAX = 500;

export const USAGE = [
  '用法：node scripts/admin-authorize-recovery.mjs (--email <邮箱> | --id <账号 id>) --reason "<原因>" [--role ADMIN] [--set-password]',
  '  只在服务器本机、以操作系统管理权限、在交互式终端里运行（docker compose exec -it）。',
  '  为一个明确的目标账号签发 15 分钟、单次使用的恢复凭据，用于验证器与恢复码全部丢失且无第二管理员的场景。',
  '  --set-password：同时在终端里隐藏输入新密码两次，写进待生效字段；原密码与 TOTP 此刻不变。',
  '  凭据只打印一次，不会写入文件或日志。',
].join('\n');

export const MESSAGES = {
  not_os_owner: '当前进程不具备服务器操作系统管理权限，拒绝签发恢复凭据。请在服务器本机以系统管理员身份运行。',
  not_tty: '标准输入或标准输出不是终端，拒绝运行：凭据不能落进文件、管道或日志。请用 docker compose exec -it 重新运行。',
  unknown_arg: `参数无法识别。\n${USAGE}`,
  ambiguous_target: '--email 与 --id 只能给一个。',
  no_target: `必须用 --email 或 --id 明确指定目标账号。\n${USAGE}`,
  invalid_email: '邮箱无效。',
  invalid_id: '账号 id 无效。',
  no_reason: '必须用 --reason 说明本次恢复原因（会写入审计）。',
  reason_too_long: `原因过长（最多 ${REASON_MAX} 字符）。`,
  reason_control_chars: '原因里不能出现控制字符。',
  role_mismatch: '--role 与目标账号当前角色不一致，拒绝签发：不允许借本地恢复越权改角色。',
  weak_password: '密码不符合后台密码规则：12–200 位，且不能与目标邮箱相同。',
  password_mismatch: '两次输入的密码不一致。',
  no_password: '没有读到密码（只从终端读，命令行参数、环境变量和标准输入都不算）。',
  not_found: '没有找到这个账号，未做任何修改。',
  target_disabled: '目标账号已停用，未做任何修改。',
  not_admin: '目标账号不是 ADMIN 角色，本命令只用于后台账号的本地恢复。',
  no_database: 'DATABASE_URL 未设置。',
  db_error: '数据库操作失败（详细原因未输出，以免带出敏感信息；请检查 DATABASE_URL 和数据库是否可达）。',
  aborted: '已取消。',
};

export const EXIT = { ok: 0, error: 1, usage: 2, refused: 3 };
const EXIT_OF = {
  not_os_owner: 3, not_tty: 2, unknown_arg: 2, ambiguous_target: 2, no_target: 2,
  invalid_email: 2, invalid_id: 2, no_reason: 2, reason_too_long: 2, reason_control_chars: 2,
  role_mismatch: 3, weak_password: 1, password_mismatch: 1, no_password: 1,
  not_found: 3, target_disabled: 3, not_admin: 3, no_database: 1,
};
export const exitCodeOf = (code) => EXIT_OF[code] ?? 1;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** permit 明文 256bit，库里只存 SHA-256（与 src/lib/server/admin/recovery-repo.ts 同一函数） */
export const hashPermitToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * 解析参数。任何看起来像密码/密钥的参数直接拒绝（错误信息里不回显参数值）；
 * 不接受 --force / --clear-2fa / --skip-totp 这类能绕过因素的开关。
 */
export function parseArgs(argv) {
  const out = { email: undefined, id: undefined, reason: undefined, role: undefined, setPassword: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') && a.includes('=');
    const flag = eq ? a.slice(0, a.indexOf('=')) : a;
    const inline = eq ? a.slice(a.indexOf('=') + 1) : undefined;
    if (/pass|pwd|secret|token/i.test(flag) && flag !== '--set-password') return { error: 'unknown_arg' };
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--email') out.email = (value() ?? '').trim().toLowerCase();
    else if (flag === '--id') out.id = String(value() ?? '').trim();
    else if (flag === '--reason') out.reason = value() ?? '';
    else if (flag === '--role') out.role = (value() ?? '').trim().toUpperCase();
    else if (flag === '--set-password' && inline === undefined) out.setPassword = true;
    else if ((flag === '--help' || flag === '-h') && inline === undefined) out.help = true;
    else return { error: 'unknown_arg' };
  }
  if (out.help) return out;
  if (out.email !== undefined && out.id !== undefined) return { error: 'ambiguous_target' };
  if (out.email === undefined && out.id === undefined) return { error: 'no_target' };
  if (out.email !== undefined && !EMAIL_RE.test(out.email)) return { error: 'invalid_email' };
  if (out.id !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(out.id)) return { error: 'invalid_id' };
  const reason = (out.reason ?? '').trim();
  if (!reason) return { error: 'no_reason' };
  if (reason.length > REASON_MAX) return { error: 'reason_too_long' };
  if (/[\p{Cc}\p{Cf}]/u.test(reason)) return { error: 'reason_control_chars' };
  out.reason = reason;
  return out;
}

/** 后台密码规则：12–200 位，不能等于邮箱。与 admin-create-lib 的 passwordPolicyError 一致 */
export function passwordPolicyError(password, email) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) return 'weak_password';
  if (email && password.toLowerCase() === String(email).toLowerCase()) return 'weak_password';
  return null;
}

/**
 * 判定是否具备服务器操作系统管理权限。**失败即拒绝，绝不降级放行。**
 *
 * POSIX：euid === 0。不看补充组，避免把 docker 组之类的成员误判为管理权限。
 * Windows：Administrators 组成员身份不等于提权（UAC 会给出受限令牌），因此直接尝试打开
 *          受保护的系统对象（\\.\PHYSICALDRIVE0 独占写）；非提权进程得到 EPERM/EACCES。
 * 其他平台：无法可靠判定，按拒绝处理。
 */
export async function hasOsAdminPrivilege(platform, deps = {}) {
  if (platform === 'win32') {
    const open = deps.openProtected;
    if (typeof open !== 'function') return false;
    try {
      await open();
      return true;
    } catch {
      return false;
    }
  }
  if (platform === 'linux' || platform === 'darwin') {
    const geteuid = deps.geteuid ?? (() => process.geteuid?.());
    try {
      return geteuid() === 0;
    } catch {
      return false;
    }
  }
  return false;
}

/** Windows 下申请受保护对象的独占写句柄；失败即代表未提权 */
export async function openProtectedOnWindows() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $h=[System.IO.File]::Open("\\\\.\\PHYSICALDRIVE0","Open","ReadWrite","None"); $h.Close()',
  ], { windowsHide: true, timeout: 10_000 });
}

/** 只删除、从不读取可能被误设的密码环境变量；返回被删掉的变量名 */
export const stripPasswordEnv = (env) => {
  const removed = [];
  for (const k of ['ADMIN_RECOVERY_PASSWORD', 'ADMIN_RESET_PASSWORD', 'ADMIN_CREATE_PASSWORD']) {
    if (k in env) { delete env[k]; removed.push(k); }
  }
  return removed;
};

/** 终端里不回显地读一行（raw mode），Ctrl-C 取消 */
function readHidden(prompt, stdin, stderr) {
  return new Promise((resolve) => {
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { stdin.setRawMode(false); stderr.write(`\n${MESSAGES.aborted}\n`); process.exit(130); }
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
          stderr.write('\n');
          return resolve(buf);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * 在 TTY 下读两次密码并校验。**必须在连库之前完成**，否则会出现「permit 已签发却没人拿到密码」。
 * 非 TTY 直接按 not_tty 拒绝，不接受从管道读密码。
 */
export async function promptPassword(email, deps) {
  const { stdin, stderr } = deps;
  if (stdin.isTTY !== true) return { error: 'not_tty' };
  const pw = await readHidden('新的待生效密码（不回显）：', stdin, stderr);
  const again = await readHidden('再输一次：', stdin, stderr);
  if (pw !== again) return { error: 'password_mismatch' };
  const weak = passwordPolicyError(pw, email);
  if (weak) return { error: weak };
  return { password: pw };
}

/**
 * 目标账号校验（纯函数，与 src/lib/server/admin/owner-recovery.ts 的 decideTarget 一致）。
 *
 * E-12 的隔离场景正是本命令存在的理由：目标可以没有 TOTP、没有恢复码、也没有第二管理员，
 * 所以这里**不要求** totpEnabled；只要求存在、未停用、角色 ADMIN；
 * 显式传了 --role 时必须与库中当前角色一致（防提权）。
 */
export function decideTarget(target, declaredRole) {
  if (!target) return 'not_found';
  if (target.disabled) return 'target_disabled';
  if (target.role !== 'ADMIN') return 'not_admin';
  if (declaredRole !== undefined && declaredRole !== target.role) return 'role_mismatch';
  return null;
}

/** 凭据块：只含凭据与到期时刻，不含账号信息；调用方只打印一次 */
export function permitLines(token, expiresAt) {
  return [
    `一次性恢复凭据（只显示这一次）：${token}`,
    `有效至：${expiresAt.toISOString()}（15 分钟内、单次使用）`,
    '该凭据不会写入日志或审计。若已泄露，请重新运行本命令签发新凭据。',
  ];
}

/** 审计 meta：只有 actor/target/source/time/reason（+ 是否附带待生效密码），凭据与哈希不进 */
export function auditMeta(input) {
  return {
    source: 'SERVER_OWNER',
    reason: input.reason,
    time: input.now.toISOString(),
    actor: input.actor,
    via: VIA,
    passwordReset: input.hasPendingPassword,
  };
}

/** 组装本次要写的 permit 行（纯函数，便于单测断言字段） */
export function buildPermitRow(input) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    row: {
      id: randomBytes(16).toString('hex'),
      tokenHash: hashPermitToken(token),
      targetUserId: input.targetUserId,
      source: 'SERVER_OWNER',
      issuedById: null,
      reason: input.reason,
      pendingPasswordHash: input.pendingPasswordHash ?? null,
      sessionVersion: input.sessionVersion,
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + PERMIT_TTL_MS),
    },
  };
}

/**
 * 主流程，所有外部依赖注入，便于用假 prisma / 假终端测试。
 * 顺序刻意固定：环境变量清理 → 参数 → 终端 → 权限 → 数据库 → 可选改密 → 查目标 → 签发。
 * 任何一步拒绝都返回对应退出码，且**在数据库写入之前**完成（改密哈希除外，它不落库）。
 */
export async function runAuthorize(deps) {
  const { argv, env, platform, stdin, stdout, stderr, now, db, hash, openProtected, geteuid, noDatabaseUrl } = deps;

  const removed = stripPasswordEnv(env);
  if (removed.length) stderr.write(`已忽略并删除环境变量 ${removed.join(', ')}：本脚本只从终端读密码。\n`);

  const args = parseArgs(argv);
  if (args.error) { stderr.write(`${MESSAGES[args.error]}\n`); return exitCodeOf(args.error); }
  if (args.help) { stdout.write(`${USAGE}\n`); return EXIT.ok; }

  if (stdin.isTTY !== true || stdout.isTTY !== true) { stderr.write(`${MESSAGES.not_tty}\n`); return EXIT.usage; }

  const privileged = await hasOsAdminPrivilege(platform,
    platform === 'win32' ? { openProtected } : { geteuid });
  if (!privileged) { stderr.write(`${MESSAGES.not_os_owner}\n`); return EXIT.refused; }

  if (noDatabaseUrl) { stderr.write(`${MESSAGES.no_database}\n`); return EXIT.error; }

  let pendingPasswordHash = null;
  if (args.setPassword) {
    const got = await promptPassword(args.email, { stdin, stderr });
    if (got.error) { stderr.write(`${MESSAGES[got.error]}\n`); return exitCodeOf(got.error); }
    pendingPasswordHash = await hash(got.password);
  }

  let target;
  try {
    target = args.id !== undefined ? await db.findById(args.id) : await db.findByEmail(args.email);
  } catch (e) {
    stderr.write(`${MESSAGES.db_error}（${e?.name ?? 'Error'}）\n`);
    return EXIT.error;
  }
  const refusal = decideTarget(target, args.role);
  if (refusal) { stderr.write(`${MESSAGES[refusal]}\n`); return exitCodeOf(refusal); }

  const built = buildPermitRow({
    targetUserId: target.id,
    reason: args.reason,
    pendingPasswordHash,
    sessionVersion: target.sessionVersion,
    now: now(),
  });

  try {
    await db.writePermit(built.row, auditMeta({
      now: now(),
      actor: `SERVER_OWNER:${env.USER ?? env.USERNAME ?? 'unknown'}`,
      target: target.id,
      reason: args.reason,
      hasPendingPassword: pendingPasswordHash !== null,
    }));
  } catch (e) {
    stderr.write(`${MESSAGES.db_error}（${e?.name ?? 'Error'}）\n`);
    return EXIT.error;
  }

  for (const line of permitLines(built.token, built.row.expiresAt)) stdout.write(`${line}\n`);
  return EXIT.ok;
}

// 只有直接运行时才进入主流程（被测试 import 时不执行）
const invokedDirectly = typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && /admin-authorize-recovery\.mjs$/.test(String(process.argv[1] ?? ''));

if (invokedDirectly) {
  // 用 .then 链而非顶层 await：该文件也会被测试以 ESM→CJS 方式转换后 import，
  // 顶层 await 在 CJS 输出格式下不被支持。行为与顶层 await 等价。
  main().catch((e) => {
    process.stderr.write(`${MESSAGES.db_error}（${e?.name ?? 'Error'}）\n`);
    process.exitCode = EXIT.error;
  });
}

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ log: [], errorFormat: 'minimal' });
  const argon = await import('@node-rs/argon2');
  try {
    const code = await runAuthorize({
      argv: process.argv.slice(2),
      env: process.env,
      platform: process.platform,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      now: () => new Date(),
      noDatabaseUrl: !process.env.DATABASE_URL,
      openProtected: openProtectedOnWindows,
      hash: (pw) => argon.hash(pw, ARGON),
      db: {
        findById: async (id) => (await client.user.findMany({
          where: { id }, select: { id: true, role: true, disabled: true, totpEnabled: true, sessionVersion: true }, take: 1,
        }))[0],
        findByEmail: async (email) => (await client.user.findMany({
          where: { email: String(email).toLowerCase() }, select: { id: true, role: true, disabled: true, totpEnabled: true, sessionVersion: true }, take: 1,
        }))[0],
        writePermit: async (row, meta) => client.$transaction(async (tx) => {
          await tx.adminRecoveryPermit.create({ data: row });
          await tx.auditLog.create({ data: { actorId: null, action: 'recovery.issued', target: row.targetUserId, meta, ip: 'local-cli' } });
        }),
      },
    });
    process.exitCode = code;
  } finally {
    await client.$disconnect().catch(() => {});
  }
}
