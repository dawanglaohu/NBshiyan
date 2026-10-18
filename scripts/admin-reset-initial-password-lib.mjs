// scripts/admin-reset-initial-password.mjs 的逻辑（不直接连库、不直接读终端），所有外部依赖都从参数注入，方便用假的 prisma / 限流存储测试。
// 不依赖 TypeScript 源码，standalone 镜像里可以直接用 node 运行。
//
// 用途：给「还没绑定 2FA 的 ADMIN」重设初始密码（#347 一次性绑定令牌上线之前的临时出口；绑定做到一半卡住时也用它）。
// 规则（安全审查已对齐）：
// - 新密码只从终端（不回显）或标准输入读；不接受命令行参数和环境变量；任何输出、日志、异常信息、审计都不含密码、哈希、密钥或邮箱明文。
// - 只处理 role=ADMIN、totpEnabled=false、未停用的账号。TOTP 已启用一律拒绝，没有任何参数能绕过。
// - 有待确认的绑定（待确认密钥 / enrollIssuedAt / totpPendingUntil / totpEnrollFails 非默认值）或绑定窗口已关闭时，
//   必须显式加 --clear-pending-enroll，否则拒绝（退出码非 0）。加了以后清掉待确认状态，并重新打开 72 小时绑定窗口（与后台重置 2FA 的 reset2faData 一致）。
// - 改密码、清待确认字段、会话全部失效（sessionVersion+1）、解除锁定、写审计（user.password_reset，必要时 user.pending_enroll_cleared）在同一个事务里。
// - 提交之后再清这个账号的限流计数：只清 key 名能只凭账号算出来的 login-acct:<e>、login:untrusted:<e>、enroll-confirm:untrusted:<e>
//   （当前和上一个窗口）。login-ip、真实 IP 的 login:<ip>:<e>、enroll-confirm:<ip>:<e> 不清，也不用 SCAN/KEYS 去找，10 分钟窗口后自己过期。
import { createHmac } from 'node:crypto';
import { ARGON, firstLine, normalizeAccountEmail, passwordPolicyError, validEmail } from './admin-create-lib.mjs';

export { ARGON, firstLine };

/** 必须等于 src/lib/server/admin/enroll-guard.ts 的 ENROLL_WINDOW_MS（测试断言两者相等） */
export const ENROLL_WINDOW_MS = 72 * 3_600_000;
/** 必须等于 src/lib/server/admin/login.ts 的 LOGIN_WINDOW_MS */
export const LOGIN_WINDOW_MS = 10 * 60_000;
export const VIA = 'cli:admin-reset-initial-password';
export const CLEAR_FLAG = '--clear-pending-enroll';
/** 这些环境变量名如果出现，脚本只删除、从不读取（密码只从终端或标准输入来） */
export const IGNORED_PASSWORD_ENVS = ['ADMIN_RESET_PASSWORD', 'ADMIN_CREATE_PASSWORD'];

export const USAGE = [
  '用法：node scripts/admin-reset-initial-password.mjs (--email <邮箱> | --id <账号 id>) [--clear-pending-enroll]',
  '  只用于还没绑定 2FA 的 ADMIN。新密码在终端里交互输入（不回显，输两次）；没有终端时从标准输入读第一行。',
  '  密码绝不能放在命令行参数或环境变量里（环境变量会被忽略）。',
  '  有待确认的 2FA 绑定或绑定窗口已关闭时，必须加 --clear-pending-enroll：清掉待确认状态并重新打开 72 小时绑定窗口。',
].join('\n');

/** 错误码 → 面向运维的提示。只有固定文案，从不包含密码、哈希、邮箱或底层异常信息 */
export const MESSAGES = {
  password_in_argv: '密码不能通过命令行参数传入（会留在 shell 历史和进程列表里）。请在终端交互输入，或通过标准输入提供。',
  unknown_arg: `参数无法识别。\n${USAGE}`,
  no_target: `需要 --email 或 --id 二选一。\n${USAGE}`,
  both_targets: '--email 和 --id 只能给一个。',
  invalid_email: '邮箱无效。',
  invalid_id: '账号 id 无效。',
  weak_password: '密码不符合后台密码规则：12–200 位，且不能与邮箱相同。',
  password_mismatch: '两次输入的密码不一致。',
  no_password: '没有读到密码（只从终端或标准输入读，命令行参数和环境变量都不算）。',
  not_found: '没有找到这个账号，未做任何修改。',
  not_admin: '这个账号不是 ADMIN，未做任何修改。本脚本只处理 ADMIN；其他角色请在后台“账号管理”里重置。',
  disabled: '这个账号已停用，未做任何修改。请先在后台启用。',
  totp_enabled: '这个账号已经绑定 2FA，脚本拒绝修改（没有任何参数可以绕过）。请登录后台修改密码，或由另一个 ADMIN 重置 2FA。',
  pending_enroll: '这个账号有未完成的 2FA 绑定（待确认密钥、错码计数或冷却期）。如确认要清掉并重新开始绑定，请加 --clear-pending-enroll 再运行。未做任何修改。',
  enroll_window_closed: '这个账号的 72 小时绑定窗口已关闭，只改密码也无法绑定。如确认要重新打开绑定窗口，请加 --clear-pending-enroll 再运行。未做任何修改。',
  no_database: 'DATABASE_URL 未设置。',
  db_error: '数据库操作失败（详细原因未输出，以免带出敏感信息；请检查 DATABASE_URL 和数据库是否可达）。',
  aborted: '已取消。',
};

/** 退出码：0 成功；1 运行错误（数据库、读不到密码、密码不合规）；2 参数错误；3 账号状态不允许（拒绝） */
export const EXIT = { ok: 0, error: 1, usage: 2, refused: 3 };
const EXIT_OF = {
  password_in_argv: 2, unknown_arg: 2, no_target: 2, both_targets: 2, invalid_email: 2, invalid_id: 2,
  not_found: 3, not_admin: 3, disabled: 3, totp_enabled: 3, pending_enroll: 3, enroll_window_closed: 3,
};
export const exitCodeOf = (code) => EXIT_OF[code] ?? 1;

/**
 * 解析命令行参数：--email / --id / --clear-pending-enroll / --help。
 * 任何看起来像密码的参数（--password、--pass=…、-p、--secret 等）直接拒绝，错误信息里不回显参数值。不读环境变量。
 */
export function parseArgs(argv) {
  const out = { email: undefined, id: undefined, clearPendingEnroll: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (/pass|pwd|secret/i.test(flag) || flag === '-p') return { error: 'password_in_argv' };
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--email') out.email = value() ?? '';
    else if (flag === '--id') out.id = value() ?? '';
    else if (flag === CLEAR_FLAG && inline === undefined) out.clearPendingEnroll = true;
    else if ((flag === '--help' || flag === '-h') && inline === undefined) out.help = true;
    else return { error: 'unknown_arg' };
  }
  if (out.help) return out;
  if (out.email !== undefined && out.id !== undefined) return { error: 'both_targets' };
  if (out.email === undefined && out.id === undefined) return { error: 'no_target' };
  if (out.email !== undefined) {
    out.email = normalizeAccountEmail(out.email);
    if (!validEmail(out.email)) return { error: 'invalid_email' };
  } else {
    out.id = String(out.id).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(out.id)) return { error: 'invalid_id' };
  }
  return out;
}

/** 删除（不读取）可能被误设的密码环境变量，返回删掉了哪些变量名（只有名字，没有值） */
export function stripPasswordEnv(env) {
  const removed = [];
  for (const k of IGNORED_PASSWORD_ENVS) if (k in env) { delete env[k]; removed.push(k); }
  return removed;
}

/** 绑定窗口是否开着，与 enroll-guard.ts enrollWindowOpen 相同 */
export const enrollWindowOpen = (u, now) => now < (u.enrollIssuedAt ?? u.createdAt).getTime() + ENROLL_WINDOW_MS;

/** 是否有任何「绑定进行中」的状态（非默认值） */
export function hasPendingEnroll(u) {
  return u.totpSecret != null || u.enrollIssuedAt != null || u.totpPendingUntil != null || (u.totpEnrollFails ?? 0) !== 0 || u.totpLastStep != null;
}

/**
 * 判定能不能重置。返回错误码，或 { clearPending: boolean }。
 * 顺序：账号不存在 → 不是 ADMIN → TOTP 已启用（与参数无关）→ 已停用 → 待确认绑定 / 窗口已关闭（需要参数）。
 */
export function decide(u, { clearPendingEnroll, now }) {
  if (!u) return 'not_found';
  if (u.role !== 'ADMIN') return 'not_admin';
  if (u.totpEnabled !== false) return 'totp_enabled';
  if (u.disabled) return 'disabled';
  const pending = hasPendingEnroll(u);
  const windowOpen = enrollWindowOpen(u, now);
  if (!clearPendingEnroll) {
    if (pending) return 'pending_enroll';
    if (!windowOpen) return 'enroll_window_closed';
    return { clearPending: false };
  }
  // 加了参数：总是把绑定状态恢复成「刚重置 2FA」（重新开 72 小时窗口）；审计里如实记录有没有待确认状态
  return { clearPending: true, hadPending: pending, windowWasOpen: windowOpen };
}

/** 事务里要写的字段。clearPending 时与 accounts.ts reset2faData 的绑定相关部分一致（totpEnabled 本来就是 false） */
export function resetData(passwordHash, { clearPending }, now) {
  return {
    passwordHash,
    sessionVersion: { increment: 1 }, // = revokeSessions：所有现有会话失效
    failedLogins: 0, lockedUntil: null, // 解除这个账号自己的登录锁定
    ...(clearPending ? { totpSecret: null, totpLastStep: null, recoveryCodes: [], totpPendingUntil: null, totpEnrollFails: 0, enrollIssuedAt: new Date(now) } : {}),
  };
}

/** 审计记录：actor=cli（actorId 为空）、目标账号 id、时间（createdAt 由库填）。不含密码、哈希、密钥、邮箱 */
export function auditEntries(userId, plan) {
  const base = { actorId: null, target: userId, ip: null };
  const out = [{ ...base, action: 'user.password_reset', meta: { actor: 'cli', via: VIA } }];
  if (plan.clearPending) out.push({ ...base, action: 'user.pending_enroll_cleared', meta: { actor: 'cli', via: VIA, hadPending: !!plan.hadPending, windowReopened: true } });
  return out;
}

// ---- 限流 key（与 src/lib/server/security.ts、login.ts、ratelimit/index.ts 一致，测试逐一对比） ----

/** = security.ts rateLimitEnv */
export function rateLimitEnv(env) {
  return (env.APP_ENV || env.VERCEL_ENV || env.NODE_ENV || 'development').replace(/[^a-z0-9_-]/gi, '');
}
/** = security.ts rateLimitKeyHash */
export function rateLimitKeyHash(value, env) {
  const base = env.AUTH_SECRET || 'dev-only-rate-limit-key';
  const k = createHmac('sha256', base).update('ratelimit-email-v1').digest();
  return createHmac('sha256', k).update(value).digest('base64url').slice(0, 32);
}
/** 必须等于 src/lib/server/admin/enroll-guard.ts 的 ENROLL_CONFIRM_WINDOW_MS */
export const ENROLL_CONFIRM_WINDOW_MS = 10 * 60_000;
/** 必须等于 src/lib/edge/client-ip.ts 的 UNTRUSTED：rateLimitSubject(null)，所有不可信来源共用这个“IP” */
export const UNTRUSTED = 'untrusted';

/**
 * 只凭账号就能算出名字的限流 key（不含环境前缀），以及各自的窗口长度：
 * - login-acct:<e>                 login.ts loginKeys().acct
 * - login:untrusted:<e>            login.ts loginKeys().ipAcct，ip=null（不可信来源共用的桶，仍然只属于这个账号）
 * - enroll-confirm:untrusted:<e>   enroll-guard.ts enrollConfirmRateOk，ip=null
 * <e> = rateLimitKeyHash(email.trim().toLowerCase())。真实 IP 的 login:<ip>:<e>、enroll-confirm:<ip>:<e> 和所有 login-ip / enroll-ip 一律不在这里。
 */
export function accountOnlyRateKeys(email, env) {
  const e = rateLimitKeyHash(email.trim().toLowerCase(), env);
  return [
    { key: `login-acct:${e}`, windowMs: LOGIN_WINDOW_MS },
    { key: `login:${UNTRUSTED}:${e}`, windowMs: LOGIN_WINDOW_MS },
    { key: `enroll-confirm:${UNTRUSTED}:${e}`, windowMs: ENROLL_CONFIRM_WINDOW_MS },
  ];
}
/**
 * Upstash 里的实际 key：= UpstashStore.keyOf(`${rateLimitEnv()}:${key}`, windowMs) = rl:<env>:<key>:<floor(now/windowMs)>。
 * 固定窗口、key 带窗口序号；offset=-1 是上一个窗口。
 */
export function upstashKey(key, env, now, windowMs = LOGIN_WINDOW_MS, offset = 0) {
  return `rl:${rateLimitEnv(env)}:${key}:${Math.floor(now / windowMs) + offset}`;
}
/** 要 DEL 的完整 key 列表：每个账号 key 的当前窗口和上一个窗口 */
export function rateKeysToDelete(email, env, now) {
  return accountOnlyRateKeys(email, env).flatMap(({ key, windowMs }) => [upstashKey(key, env, now, windowMs, 0), upstashKey(key, env, now, windowMs, -1)]);
}

/**
 * 清掉只凭账号能算出的限流 key（按 key 名直接 DEL，不 SCAN、不 KEYS）。
 * - RATE_LIMIT_STORE=upstash：一次 pipeline DEL。
 * - memory（默认）：计数在应用进程内存里，脚本碰不到，跳过（10 分钟后自然过期）。
 * 返回 'cleared' | 'skipped_memory' | 'failed'。出错不抛、不输出 key、邮箱或 token。
 */
export async function clearAccountRateLimits({ email, env, now, fetchImpl }) {
  const kind = env.RATE_LIMIT_STORE ?? 'memory';
  if (kind !== 'upstash') return 'skipped_memory';
  const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return 'failed';
  const keys = rateKeysToDelete(email, env, now);
  try {
    const r = await fetchImpl(`${url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(keys.map((k) => ['DEL', k])),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return 'failed';
    const j = await r.json();
    return Array.isArray(j) && !j.some((x) => x?.error) ? 'cleared' : 'failed';
  } catch {
    return 'failed';
  }
}

const USER_SELECT = {
  id: true, email: true, role: true, disabled: true, totpEnabled: true, totpSecret: true, totpLastStep: true,
  enrollIssuedAt: true, totpPendingUntil: true, totpEnrollFails: true, createdAt: true,
};

/** 只输出错误类型 / Prisma 错误码，不输出底层 message（可能带连接串或数据） */
export function safeErrorCode(e) {
  if (typeof e?.code === 'string' && /^P\d{4}$/.test(e.code)) return e.code;
  return typeof e?.name === 'string' ? e.name.slice(0, 40) : 'Error';
}

/**
 * 跑一次重置。
 * @param o.argv           命令行参数
 * @param o.env            环境变量对象（只读 DATABASE_URL 是否存在、限流相关配置；密码类变量启动时已删除，从不读取）
 * @param o.readPassword   () => Promise<string|{error}> 从终端/标准输入读密码（终端时内部已确认两次一致）
 * @param o.db             () => Promise<PrismaClient 形状的对象>（findUnique、$transaction、$disconnect）
 * @param o.hash           (password) => Promise<string>，生产里是 @node-rs/argon2 hash(·, ARGON)
 * @param o.fetchImpl      清 Upstash 限流用的 fetch
 * @param o.now            () => 毫秒时间戳
 * @param o.out / o.err    写 stdout / stderr
 * @returns 退出码
 */
export async function runReset({ argv, env, readPassword, db, hash, fetchImpl, now = () => Date.now(), out, err }) {
  const fail = (code) => { err(`${MESSAGES[code] ?? MESSAGES.db_error}\n`); return exitCodeOf(code); };
  const args = parseArgs(argv);
  if (args.error) return fail(args.error);
  if (args.help) { out(`${USAGE}\n`); return EXIT.ok; }
  if (!env.DATABASE_URL) return fail('no_database');

  let client;
  try {
    client = await db();
    const where = args.email !== undefined ? { email: args.email } : { id: args.id };
    // 先只读判定一次：状态不允许时在读密码之前就拒绝，不让人白输密码
    const pre = await client.user.findUnique({ where, select: USER_SELECT });
    const first = decide(pre, { clearPendingEnroll: args.clearPendingEnroll, now: now() });
    if (typeof first === 'string') return fail(first);

    let password = await readPassword();
    if (password && typeof password === 'object') return fail(password.error);
    if (!password) return fail('no_password');
    const policy = passwordPolicyError(password, pre.email);
    if (policy) { password = undefined; return fail(policy); }
    const passwordHash = await hash(password);
    password = undefined;

    const result = await client.$transaction(async (tx) => {
      // 锁住这一行，再按锁内读到的状态重新判定（防止和后台操作或另一次 enroll 并发）
      await tx.$executeRaw`SELECT 1 FROM "User" WHERE id = ${pre.id} FOR UPDATE`;
      const u = await tx.user.findUnique({ where: { id: pre.id }, select: USER_SELECT });
      const t = now();
      const plan = decide(u, { clearPendingEnroll: args.clearPendingEnroll, now: t });
      if (typeof plan === 'string') return { refused: plan };
      await tx.user.update({ where: { id: u.id }, data: resetData(passwordHash, plan, t), select: { id: true } });
      for (const data of auditEntries(u.id, plan)) await tx.auditLog.create({ data });
      return { id: u.id, email: u.email, plan };
    });
    if (result.refused) return fail(result.refused);

    const rl = await clearAccountRateLimits({ email: result.email, env, now: now(), fetchImpl });
    out(`已重置管理员（id ${result.id}）的初始密码；该账号所有会话已失效、登录锁定已解除。\n`);
    if (result.plan.clearPending) out('已清掉未完成的 2FA 绑定，72 小时绑定窗口重新开始计时。\n');
    out(`rate_limit=${rl}\n`);
    if (rl === 'failed') err('提示：清这个账号的限流计数失败（密码已改好），最多 10 分钟后自动过期。\n');
    out('下一步：用新密码登录 /admin，立即绑定 2FA。\n');
    return EXIT.ok;
  } catch (e) {
    err(`${MESSAGES.db_error}（${safeErrorCode(e)}）\n`);
    return EXIT.error;
  } finally {
    try { await client?.$disconnect?.(); } catch { /* 忽略 */ }
  }
}
