// scripts/admin-reset-initial-password.mjs 的逻辑（不直接连库、不直接读终端），所有外部依赖都从参数注入，方便用假的 prisma / 限流存储测试。
// 不依赖 TypeScript 源码，standalone 镜像里可以直接用 node 运行。
//
// 用途：给「还没绑定 2FA 的 ADMIN」重设初始密码（#347 一次性绑定令牌上线之前的临时出口；绑定做到一半卡住时也用它）。
// 规则（安全审查已对齐）：
// - 新密码只从终端读（不回显，输两次）；不接受命令行参数、环境变量和标准输入；任何输出、日志、异常信息、审计都不含密码、哈希、密钥或邮箱明文。
// - 只处理 role=ADMIN、totpEnabled=false、未停用的账号。TOTP 已启用一律拒绝，没有任何参数能绕过。
// - 有待确认的绑定（待确认密钥 / enrollIssuedAt / totpPendingUntil / totpEnrollFails 非默认值）或绑定窗口已关闭时，
//   必须显式加 --clear-pending-enroll，否则拒绝（退出码非 0）。加了以后清掉待确认状态，并重新打开 72 小时绑定窗口（与后台重置 2FA 的 reset2faData 一致）。
// - 改密码、清待确认字段、会话全部失效（sessionVersion+1）、解除锁定、写审计（user.password_reset，必要时 user.pending_enroll_cleared）在同一个事务里。
// - 提交之后再清这个账号的限流计数：只清 key 名能只凭账号算出来的 login-acct:<e>、login:untrusted:<e>、enroll-confirm:untrusted:<e>
//   （当前和上一个窗口）。login-ip、真实 IP 的 login:<ip>:<e>、enroll-confirm:<ip>:<e> 不清，也不扫描键空间，10 分钟窗口后自己过期。
//   被真实 IP 桶挡住的人，重置后最多还要再等当前这一个 10 分钟窗口。
// - upstash：用 https.request 打 /pipeline。APP_ENV=production 时拒绝 http: 地址（不发 Bearer，结果是 failed）。
//   env.NODE_EXTRA_CA_CERTS 有值时读那个 PEM，和公共根证书一起交给这次请求
//   （docker compose exec 的新进程会继承容器 environment 里的这个变量和 CA 挂载；没带到 CA 时证书校验失败，返回 failed，不抛错）。
// - redis：RATE_LIMIT_STORE=redis。需要 Redis 7 或更新（PEXPIRE … NX）。APP_ENV=production 时，开任何 socket 之前
//   先按 prod-env-check.ts 的 rateLimitProblems 判定：REDIS_URL 必须带密码；非本机必须 rediss://
//   （本机只认 127.0.0.1、::1、localhost；URL 里的 [::1] 解析后是 ::1）。不合规则 rate_limit=failed，文案只写变量名，不连网。
//   同样只 DEL 上面那些 key，rediss 时同样带上额外 CA。
// - #347 方案 A：每次都在同一个事务里签发新的一次性绑定令牌（覆盖旧的，旧链接立即失效；加不加 --clear-pending-enroll 都签发），
//   审计 auth.enroll_token_issued（source 'cli'，不含令牌）。链接只打印到终端一次（链接 / 有效至 / 只私信给本人三行）。
//   stdin 或 stdout 不是终端（重定向、管道、exec -T）时在读密码、连库、签发令牌之前就拒绝（退出码 2），什么都不改：
//   链接不能落进文件或日志，也不能“签发了却没人看见”。必须用 docker compose exec -it。从标准输入喂密码的旧用法已失效。
//   NEXT_PUBLIC_SITE_URL 不合格（https；非生产可用 http://localhost）时同样在任何修改之前拒绝（退出码 1）。
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { enrollLinkBase, issuedAudit, linkLines, newEnrollToken } from './enroll-token-lib.mjs';
import { ARGON, firstLine, normalizeAccountEmail, passwordPolicyError, validEmail } from './admin-create-lib.mjs';

export { ARGON, firstLine };

/** 必须等于 src/lib/server/admin/enroll-guard.ts 的 ENROLL_WINDOW_MS（测试断言两者相等） */
export const ENROLL_WINDOW_MS = 72 * 3_600_000;
/** 必须等于 src/lib/server/admin/login.ts 的 LOGIN_WINDOW_MS */
export const LOGIN_WINDOW_MS = 10 * 60_000;
export const VIA = 'cli:admin-reset-initial-password';
export const CLEAR_FLAG = '--clear-pending-enroll';
/** 这些环境变量名如果出现，脚本只删除、从不读取（密码只从终端来） */
export const IGNORED_PASSWORD_ENVS = ['ADMIN_RESET_PASSWORD', 'ADMIN_CREATE_PASSWORD'];

export const USAGE = [
  '用法：node scripts/admin-reset-initial-password.mjs (--email <邮箱> | --id <账号 id>) [--clear-pending-enroll]',
  '  只用于还没绑定 2FA 的 ADMIN。新密码在终端里交互输入（不回显，输两次）。不从标准输入读密码。',
  '  密码绝不能放在命令行参数或环境变量里（环境变量会被忽略）。',
  '  有待确认的 2FA 绑定或绑定窗口已关闭时，必须加 --clear-pending-enroll：清掉待确认状态并重新打开 72 小时绑定窗口。',
  '  成功后在终端显示一次 2FA 绑定链接（#347）。stdin 和 stdout 都必须是终端（docker compose exec -it），否则拒绝运行。',
].join('\n');

/** 错误码 → 面向运维的提示。只有固定文案，从不包含密码、哈希、邮箱或底层异常信息 */
export const MESSAGES = {
  password_in_argv: '密码不能通过命令行参数传入（会留在 shell 历史和进程列表里）。请在终端交互输入。',
  unknown_arg: `参数无法识别。\n${USAGE}`,
  no_target: `需要 --email 或 --id 二选一。\n${USAGE}`,
  both_targets: '--email 和 --id 只能给一个。',
  invalid_email: '邮箱无效。',
  invalid_id: '账号 id 无效。',
  weak_password: '密码不符合后台密码规则：12–200 位，且不能与邮箱相同。',
  password_mismatch: '两次输入的密码不一致。',
  no_password: '没有读到密码（只从终端读，命令行参数、环境变量和标准输入都不算）。',
  not_found: '没有找到这个账号，未做任何修改。',
  not_admin: '这个账号不是 ADMIN，未做任何修改。本脚本只处理 ADMIN；其他角色请在后台“账号管理”里重置。',
  disabled: '这个账号已停用，未做任何修改。请先在后台启用。',
  totp_enabled: '这个账号已经绑定 2FA，脚本拒绝修改（没有任何参数可以绕过）。请登录后台修改密码，或由另一个 ADMIN 重置 2FA。',
  pending_enroll: '这个账号有未完成的 2FA 绑定（待确认密钥、错码计数或冷却期）。如确认要清掉并重新开始绑定，请加 --clear-pending-enroll 再运行。未做任何修改。',
  enroll_window_closed: '这个账号的 72 小时绑定窗口已关闭，只改密码也无法绑定。如确认要重新打开绑定窗口，请加 --clear-pending-enroll 再运行。未做任何修改。',
  no_database: 'DATABASE_URL 未设置。',
  stdout_not_tty: '没有检测到交互终端，未生成绑定链接，之前的链接仍然有效。请用 -it 重新运行', // UX v1.0.3 原文
  stdin_not_tty: '标准输入不是终端，未生成绑定链接，之前的链接仍然有效。请用 docker compose exec -it 重新运行',
  site_url_invalid: 'NEXT_PUBLIC_SITE_URL 不合格（必须是 https 裸 origin；非生产可用 http://localhost），无法生成绑定链接，未做任何修改。',
  db_error: '数据库操作失败（详细原因未输出，以免带出敏感信息；请检查 DATABASE_URL 和数据库是否可达）。',
  aborted: '已取消。',
};

/** 退出码：0 成功；1 运行错误（数据库、读不到密码、密码不合规）；2 参数错误或 stdin/stdout 不是终端；3 账号状态不允许（拒绝） */
export const EXIT = { ok: 0, error: 1, usage: 2, refused: 3 };
const EXIT_OF = {
  password_in_argv: 2, unknown_arg: 2, stdout_not_tty: 2, stdin_not_tty: 2, no_target: 2, both_targets: 2, invalid_email: 2, invalid_id: 2,
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

/** 审计记录：actor=cli（actorId 为空）、目标账号 id、时间（createdAt 由库填）。不含密码、哈希、密钥、邮箱、绑定令牌 */
export function auditEntries(userId, plan, issued) {
  const base = { actorId: null, target: userId, ip: null };
  const out = [{ ...base, action: 'user.password_reset', meta: { actor: 'cli', via: VIA } }];
  if (plan.clearPending) out.push({ ...base, action: 'user.pending_enroll_cleared', meta: { actor: 'cli', via: VIA, hadPending: !!plan.hadPending, windowReopened: true } });
  if (issued) out.push({ ...issuedAudit(userId), meta: { actor: 'cli', source: 'cli', via: VIA, truncated: issued.expiresTruncated } });
  return out;
}

/** #347：这次重置后的绑定窗口起点（clearPending 时重新开始 = now，否则沿用 enrollIssuedAt ?? createdAt），令牌有效期按它截短 */
export const windowStartAfter = (u, plan, now) => (plan.clearPending ? now : (u.enrollIssuedAt ?? u.createdAt).getTime());

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

/** 读 NODE_EXTRA_CA_CERTS。没设置返回 undefined（用默认信任库）；设置了但读不到返回 error，调用方按 failed 处理，不把路径写出去。 */
function loadExtraCa(env) {
  const p = env.NODE_EXTRA_CA_CERTS;
  if (!p) return { ca: undefined };
  try {
    const pem = fs.readFileSync(p);
    if (!pem.length) return { error: true };
    return { ca: [...tls.rootCertificates, pem] };
  } catch {
    return { error: true };
  }
}

function postJson(urlStr, token, body, ca, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { reject(new Error('bad url')); return; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { reject(new Error('bad url')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    };
    if (ca) opts.ca = ca;
    if (u.protocol === 'https:' && !net.isIP(u.hostname)) opts.servername = u.hostname;
    const req = lib.request(opts, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > 65536) { req.destroy(); reject(new Error('big')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (err) => { req.destroy(); reject(err); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * 与 src/lib/server/ratelimit/redis.ts 的 parseRedisUrl、以及 prod-env-check.ts rateLimitProblems 的文案映射同一规则。
 * error 只含变量名 REDIS_URL，不含原始串。解析成功时 endpoint 还不含「生产必须有密码 / 非本机必须 rediss」这两条。
 */
function classifyRedisUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { error: 'REDIS_URL 未设置' };
  let u;
  try { u = new URL(text); } catch { return { error: 'REDIS_URL 必须是 redis:// 或 rediss://' }; }
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') return { error: 'REDIS_URL 必须是 redis:// 或 rediss://' };
  if (u.search || u.hash || !u.hostname) return { error: 'REDIS_URL 无效' };
  const port = u.port ? Number(u.port) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'REDIS_URL 无效' };
  const path = u.pathname.replace(/^\//, '');
  if (path && (!/^\d+$/.test(path) || Number(path) > 15)) return { error: 'REDIS_URL 无效' };
  let password;
  let username;
  try {
    password = u.password ? decodeURIComponent(u.password) : undefined;
    username = u.username ? decodeURIComponent(u.username) : undefined;
  } catch { return { error: 'REDIS_URL 无效' }; }
  if (username && !password) return { error: 'REDIS_URL 无效' };
  const host = u.hostname.startsWith('[') && u.hostname.endsWith(']') ? u.hostname.slice(1, -1) : u.hostname;
  return { endpoint: { host, port, tls: u.protocol === 'rediss:', username, password, db: path ? Number(path) : 0 } };
}

/** 与 parseRedisUrl 同一规则。失败返回 null，不带回原始串。 */
function parseRedisEndpoint(raw) {
  return classifyRedisUrl(raw).endpoint ?? null;
}

/** 允许明文 redis:// 的主机。与 prod-env-check.ts 的 REDIS_PLAINTEXT_HOSTS 一致，大小写敏感。 */
const REDIS_PLAINTEXT_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * APP_ENV=production 且 RATE_LIMIT_STORE=redis 时，返回与 rateLimitProblems 相同的拒绝文案；否则 null。
 * 文案只含变量名。调用方必须在打开 socket 之前用它拒绝。
 */
function productionRedisProblem(env) {
  if (env.APP_ENV !== 'production' || env.RATE_LIMIT_STORE !== 'redis') return null;
  const parsed = classifyRedisUrl(env.REDIS_URL);
  if (parsed.error) return parsed.error;
  if (!parsed.endpoint.password) return 'REDIS_URL 必须包含密码';
  if (!parsed.endpoint.tls && !REDIS_PLAINTEXT_HOSTS.has(parsed.endpoint.host)) return 'REDIS_URL 必须是 rediss://';
  return null;
}

function encodeCmd(args) {
  const chunks = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.from(String(a));
    chunks.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(chunks);
}

const MAX_RESP_DEPTH = 2;

/** 长度和个数必须是整数字面量。空串、1e3、带空格都不行。与 src/lib/server/ratelimit/redis.ts 一致。 */
function respCount(head) {
  if (!/^-?\d+$/.test(head)) return null;
  const n = Number(head);
  return Number.isInteger(n) ? n : null;
}

/** 从 buf[at] 读一条 RESP。数据不够返回 null。协议不对 kind 为 bad。嵌套超过 2 层也是 bad。 */
export function readResp(buf, at = 0, depth = 0) {
  if (depth > MAX_RESP_DEPTH) return { kind: 'bad', next: at };
  if (at >= buf.length) return null;
  const nl = buf.indexOf('\r\n', at);
  if (nl < 0) return null;
  const type = String.fromCharCode(buf[at]);
  const head = buf.toString('utf8', at + 1, nl);
  const next = nl + 2;
  if (type === '+' || type === '-') return { kind: type === '+' ? 'ok' : 'err', value: head, next };
  if (type === ':') {
    const value = respCount(head);
    if (value === null || !Number.isSafeInteger(value)) return { kind: 'bad', next };
    return { kind: 'int', value, next };
  }
  if (type === '$') {
    const n = respCount(head);
    if (n === null || n > 1_000_000) return { kind: 'bad', next };
    if (n < 0) return { kind: 'bulk', value: null, next };
    if (buf.length < next + n + 2) return null;
    return { kind: 'bulk', value: buf.toString('utf8', next, next + n), next: next + n + 2 };
  }
  if (type === '*') {
    const n = respCount(head);
    if (n === null || n < 0 || n > 64) return { kind: 'bad', next };
    const value = [];
    let p = next;
    for (let i = 0; i < n; i++) {
      const one = readResp(buf, p, depth + 1);
      if (!one) return null;
      if (one.kind === 'bad') return one;
      value.push(one);
      p = one.next;
    }
    return { kind: 'arr', value, next: p };
  }
  return { kind: 'bad', next };
}

function connectRedis(ep, ca, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const opts = { host: ep.host, port: ep.port };
    if (ep.tls) {
      if (ca) opts.ca = ca;
      if (!net.isIP(ep.host)) opts.servername = ep.host;
    }
    const sock = ep.tls ? tls.connect(opts) : net.connect(opts);
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(new Error('conn'));
    };
    const timer = setTimeout(fail, timeoutMs);
    sock.once('error', fail);
    sock.once(ep.tls ? 'secureConnect' : 'connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sock);
    });
  });
}

/** 一条连接里按顺序写完命令并读回同样条数的回复。回复是错误或协议不对则 throw；throw 的对象不含命令内容。 */
function redisRoundtrip(ep, commands, ca, timeoutMs) {
  const batch = [];
  if (ep.password) batch.push(ep.username ? ['AUTH', ep.username, ep.password] : ['AUTH', ep.password]);
  if (ep.db !== 0) batch.push(['SELECT', String(ep.db)]);
  batch.push(...commands);
  return connectRedis(ep, ca, timeoutMs).then((sock) => new Promise((resolve, reject) => {
    const bufs = [];
    let size = 0;
    let got = 0;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.on('error', () => {});
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    // 每次从整段缓冲重新数。got 若跨分片累加，而 at 又从 0 开始，前面的回复会被再数一遍，后面的 -ERR 会被漏掉。
    const pump = () => {
      try {
        const buf = Buffer.concat(bufs, size);
        let at = 0;
        got = 0;
        while (got < batch.length) {
          const one = readResp(buf, at);
          if (!one) return;
          if (one.kind === 'bad' || one.kind === 'err') return finish(new Error('bad'));
          got++;
          at = one.next;
        }
        finish();
      } catch {
        finish(new Error('bad'));
      }
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    sock.on('data', (c) => {
      try {
        size += c.length;
        if (size > 1_000_000) return finish(new Error('big'));
        bufs.push(c);
        pump();
      } catch {
        finish(new Error('bad'));
      }
    });
    sock.on('error', () => finish(new Error('conn')));
    sock.on('end', () => { if (got < batch.length) finish(new Error('bad')); });
    sock.write(Buffer.concat(batch.map(encodeCmd)), (err) => { if (err) finish(new Error('conn')); });
  }));
}

async function clearViaRedis(email, env, now) {
  // 生产传输规则先于任何 socket，避免把命令或 AUTH 发到明文远端。
  if (productionRedisProblem(env)) return 'failed';
  const ep = parseRedisEndpoint(env.REDIS_URL);
  if (!ep) return 'failed';
  let ca;
  if (ep.tls) {
    const extra = loadExtraCa(env);
    if (extra.error) return 'failed';
    ca = extra.ca;
  }
  const keys = rateKeysToDelete(email, env, now);
  await redisRoundtrip(ep, keys.map((k) => ['DEL', k]), ca, 3000);
  return 'cleared';
}

/**
 * 清掉只凭账号能算出的限流 key（按 key 名直接 DEL，不扫描键空间）。
 * - RATE_LIMIT_STORE=upstash：一次 pipeline DEL。传了 fetchImpl 就用它（测试）；否则用 https.request，并读取 env.NODE_EXTRA_CA_CERTS。APP_ENV=production 时 http: 地址直接 failed，不发 Bearer。
 * - RATE_LIMIT_STORE=redis：TCP DEL，REDIS_URL。需要 Redis 7 或更新（PEXPIRE … NX）。rediss:// 同样读取 NODE_EXTRA_CA_CERTS。
 *   APP_ENV=production 时先按 rateLimitProblems 拒绝（无密码、非本机 redis://、URL 无效），不连网。
 * - memory（默认）以及其他值：计数在应用进程内存里，或不是这支脚本认识的存储，跳过（10 分钟后自然过期）。
 * 返回 'cleared' | 'skipped_memory' | 'failed'。出错不抛、不输出 key、邮箱或 token。
 */
export async function clearAccountRateLimits({ email, env, now, fetchImpl }) {
  const kind = env.RATE_LIMIT_STORE ?? 'memory';
  if (kind === 'redis') {
    try { return await clearViaRedis(email, env, now); } catch { return 'failed'; }
  }
  if (kind !== 'upstash') return 'skipped_memory';
  const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return 'failed';
  if (env.APP_ENV === 'production') {
    let proto;
    try { proto = new URL(url).protocol; } catch { return 'failed'; }
    if (proto === 'http:') return 'failed';
  }
  const body = JSON.stringify(rateKeysToDelete(email, env, now).map((k) => ['DEL', k]));
  try {
    if (fetchImpl) {
      const r = await fetchImpl(`${url.replace(/\/$/, '')}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return 'failed';
      const j = await r.json();
      return Array.isArray(j) && !j.some((x) => x?.error) ? 'cleared' : 'failed';
    }
    const extra = loadExtraCa(env);
    if (extra.error) return 'failed';
    const r = await postJson(`${url.replace(/\/$/, '')}/pipeline`, token, body, extra.ca, 3000);
    if (!r.ok) return 'failed';
    const j = JSON.parse(r.body);
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
 * @param o.readPassword   () => Promise<string|{error}> 从终端读密码（内部已确认两次一致）。调用前 stdin 必须已是终端。
 * @param o.db             () => Promise<PrismaClient 形状的对象>（findUnique、$transaction、$disconnect）
 * @param o.hash           (password) => Promise<string>，生产里是 @node-rs/argon2 hash(·, ARGON)
 * @param o.fetchImpl      清 Upstash 限流用的 fetch；不传则用 https.request，并读取 env.NODE_EXTRA_CA_CERTS
 * @param o.now            () => 毫秒时间戳
 * @param o.out / o.err    写 stdout / stderr
 * @param o.stdoutIsTTY    stdout 是不是终端（#347：不是 true 就拒绝运行；测试里注入）
 * @param o.stdinIsTTY     stdin 是不是终端（不是 true 就拒绝运行，与 stdout 同样严格；测试里注入）
 * @param o.issueToken     (now, windowStart) => 令牌（默认 enroll-token-lib newEnrollToken；测试里可注入固定值）
 * @returns 退出码
 */
export async function runReset({ argv, env, readPassword, db, hash, fetchImpl, now = () => Date.now(), out, err, stdoutIsTTY, stdinIsTTY, issueToken = newEnrollToken }) {
  const fail = (code) => { err(`${MESSAGES[code] ?? MESSAGES.db_error}\n`); return exitCodeOf(code); };
  const args = parseArgs(argv);
  if (args.error) return fail(args.error);
  if (args.help) { out(`${USAGE}\n`); return EXIT.ok; }
  // 读密码、连库、签发令牌之前：两者都不是 true 则退出 2。同时失败时先报 stdout。
  if (stdoutIsTTY !== true) return fail('stdout_not_tty');
  if (stdinIsTTY !== true) return fail('stdin_not_tty');
  const linkBase = enrollLinkBase(env);
  if (!linkBase) return fail('site_url_invalid');
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
      const issued = issueToken(t, windowStartAfter(u, plan, t)); // #347：同一事务里覆盖旧令牌
      await tx.user.update({ where: { id: u.id }, data: { ...resetData(passwordHash, plan, t), ...issued.data }, select: { id: true } });
      for (const data of auditEntries(u.id, plan, issued)) await tx.auditLog.create({ data });
      return { id: u.id, email: u.email, plan, issued };
    });
    if (result.refused) return fail(result.refused);

    const rl = await clearAccountRateLimits({ email: result.email, env, now: now(), fetchImpl });
    out(`已重置管理员（id ${result.id}）的初始密码；该账号所有会话已失效、登录锁定已解除。\n`);
    if (result.plan.clearPending) out('已清掉未完成的 2FA 绑定，72 小时绑定窗口重新开始计时。\n');
    out(`rate_limit=${rl}\n`);
    if (rl === 'failed') {
      err('提示：清这个账号的限流计数失败（密码已改好），最多 10 分钟后自动过期。\n');
      const problem = productionRedisProblem(env);
      if (problem) err(`${problem}\n`);
    }
    out('下一步：把下面的绑定链接和新密码分别私信给本人，对方打开链接立即绑定 2FA（之前发出的绑定链接已失效）。\n');
    out(linkLines(result.issued, linkBase)); // 只打印这一次、只到终端
    result.issued = undefined;
    return EXIT.ok;
  } catch (e) {
    err(`${MESSAGES.db_error}（${safeErrorCode(e)}）\n`);
    return EXIT.error;
  } finally {
    try { await client?.$disconnect?.(); } catch { /* 忽略 */ }
  }
}
