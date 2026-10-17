// scripts/admin-create.mjs 的纯逻辑（不连库、不读终端），单独放一个文件方便测试。
// 不依赖 TypeScript 源码，standalone 镜像里可以直接用 node 运行。

/** 与 src/lib/server/admin/user-policy.ts normalizeAccountEmail 一致：NFKC、去空白、小写 */
export function normalizeAccountEmail(raw) {
  return String(raw).normalize('NFKC').trim().toLowerCase();
}

/** 与后台新建账号（/api/admin/users，zod .email().max(200)）同口径的保守校验 */
export function validEmail(email) {
  return typeof email === 'string' && email.length <= 200 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(email);
}

/** 与 src/lib/server/admin/accounts.ts passwordPolicyError 相同：12–200 位、不能等于邮箱 */
export function passwordPolicyError(pw, email) {
  if (typeof pw !== 'string' || pw.length < 12 || pw.length > 200) return 'weak_password';
  if (pw.trim().toLowerCase() === String(email).toLowerCase()) return 'weak_password';
  return null;
}

/** argon2id 参数与 src/lib/server/admin/crypto.ts 相同 */
export const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const PASSWORD_ENV = 'ADMIN_CREATE_PASSWORD';
export const USAGE = [
  '用法：node scripts/admin-create.mjs --email <邮箱> [--name <显示名>] [--allow-additional-admin]',
  '  密码：在终端里交互输入（不回显，输两次）；没有终端时从标准输入读第一行，或读环境变量 ADMIN_CREATE_PASSWORD（读完立即从进程环境里删除）。',
  '  密码绝不能放在命令行参数里。',
].join('\n');

/**
 * 解析命令行参数。只接受 --email / --name / --allow-additional-admin / --help。
 * 任何看起来像密码的参数（--password、--pass=…、-p 等）直接拒绝，并且错误信息里不回显参数值。
 */
export function parseArgs(argv, env = {}) {
  const out = { email: env.ADMIN_CREATE_EMAIL ?? '', name: env.ADMIN_CREATE_NAME ?? '', allowAdditionalAdmin: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (/pass|pwd|secret/i.test(flag) || flag === '-p') return { error: 'password_in_argv' };
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--email') out.email = value() ?? '';
    else if (flag === '--name') out.name = value() ?? '';
    else if (flag === '--allow-additional-admin') out.allowAdditionalAdmin = true;
    else if (flag === '--help' || flag === '-h') out.help = true;
    else return { error: 'unknown_arg' };
  }
  out.email = normalizeAccountEmail(out.email);
  out.name = String(out.name).trim() || 'Admin';
  if (out.help) return out;
  if (!validEmail(out.email)) return { error: 'invalid_email' };
  if (out.name.length > 100) return { error: 'invalid_name' };
  return out;
}

/**
 * 决定密码来源：有终端（TTY）→ 交互输入；没有终端 → 环境变量（如有），否则标准输入第一行。
 * 环境变量在脚本启动时就已读出并删除（见 takeEnvPassword），这里只拿读出的值。
 */
export function passwordSource({ isTTY, envPassword }) {
  if (isTTY) return 'tty';
  if (typeof envPassword === 'string' && envPassword.length) return 'env';
  return 'stdin';
}

/** 读取并立即删除环境变量里的密码（无论之后用不用），避免留在进程环境里被子进程或诊断输出带出 */
export function takeEnvPassword(env) {
  const v = env[PASSWORD_ENV];
  delete env[PASSWORD_ENV];
  return v;
}

/** 管道输入：只取第一行，去掉行尾 \r\n（不 trim 其他空白，密码里允许空格） */
export function firstLine(text) {
  const s = String(text);
  const i = s.search(/\r?\n/);
  return i === -1 ? s : s.slice(0, i);
}

/** 已有管理员时是否允许继续 */
export function adminGateError({ existingAdmins, emailTaken, allowAdditionalAdmin }) {
  if (emailTaken) return 'email_taken';
  if (existingAdmins > 0 && !allowAdditionalAdmin) return 'admin_exists';
  return null;
}

/** 错误码 → 面向运维的提示。只有固定文案，从不包含密码、哈希或底层异常信息 */
export const MESSAGES = {
  password_in_argv: '密码不能通过命令行参数传入（会留在 shell 历史和进程列表里）。请交互输入，或通过标准输入 / ADMIN_CREATE_PASSWORD 提供。',
  unknown_arg: `参数无法识别。\n${USAGE}`,
  invalid_email: '邮箱无效（--email 或 ADMIN_CREATE_EMAIL）。',
  invalid_name: '显示名最多 100 个字符。',
  weak_password: '密码不符合后台密码规则：12–200 位，且不能与邮箱相同。',
  password_mismatch: '两次输入的密码不一致。',
  no_password: '没有读到密码。',
  email_taken: '该邮箱已有账号，未做任何修改（脚本不会覆盖已有账号）。',
  admin_exists: '数据库里已经有管理员。如确实要再建一个管理员，请加 --allow-additional-admin；日常加人请在后台“账号管理”里操作。',
  no_database: 'DATABASE_URL 未设置。',
  db_error: '数据库操作失败（详细原因未输出，以免带出敏感信息；请检查 DATABASE_URL 和数据库是否可达）。',
  aborted: '已取消。',
};
