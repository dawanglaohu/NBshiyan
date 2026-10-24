// 队列 ②：scripts/admin-reset-initial-password.mjs（给未绑定 2FA 的 ADMIN 重设初始密码）。prisma 换成内存里的假对象；Redis 只用本机假服务器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import {
  ARGON, CLEAR_FLAG, ENROLL_CONFIRM_WINDOW_MS, ENROLL_WINDOW_MS, LOGIN_WINDOW_MS, MESSAGES, UNTRUSTED, VIA, accountOnlyRateKeys, clearAccountRateLimits, decide, hasPendingEnroll, parseArgs,
  rateKeysToDelete, rateLimitEnv, rateLimitKeyHash, runReset, stripPasswordEnv, upstashKey, type ResetUser,
} from '../scripts/admin-reset-initial-password-lib.mjs';
import { startFakeRedis } from './fake-redis';
import { newEnrollToken, hashEnrollToken, type Issued } from '../scripts/enroll-token-lib.mjs';
import { verifySecret } from '../src/lib/server/admin/crypto';
import { rateLimitEnv as appEnv, rateLimitKeyHash as appKeyHash, rateLimitSubject, UNTRUSTED as APP_UNTRUSTED } from '../src/lib/server/security';
import { UpstashStore } from '../src/lib/server/ratelimit/index';
import { hash as argonHash } from '@node-rs/argon2';

const PW = 'Correct-Horse-Battery-9!';
const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 18, 13, 0, 0);
const EMAIL = 'ryan@example.com';
const SECRET = 'v1.ENCRYPTED-PENDING-SECRET.tag.ct';

function user(over: Partial<ResetUser> & { enrollTokenHash?: string | null; enrollTokenExpiresAt?: Date | null; sessionVersion?: number; failedLogins?: number; lockedUntil?: Date | null; passwordHash?: string; recoveryCodes?: string[] } = {}) {
  return {
    id: 'cuid_admin_1', email: EMAIL, role: 'ADMIN', disabled: false, totpEnabled: false, totpSecret: null, totpLastStep: null,
    enrollIssuedAt: null, totpPendingUntil: null, totpEnrollFails: 0, createdAt: new Date(NOW - 2 * H),
    sessionVersion: 3, failedLogins: 4, lockedUntil: new Date(NOW + 5 * 60_000), passwordHash: 'OLD-HASH', recoveryCodes: [] as string[],
    enrollTokenHash: null as string | null, enrollTokenExpiresAt: null as Date | null,
    ...over,
  };
}
type Row = ReturnType<typeof user>;

/** 假 prisma：findUnique / $transaction（失败回滚）/ $executeRaw / update（支持 increment）/ auditLog.create */
function fakeDb(rows: Row[], opts: { failAudit?: boolean; beforeLock?: (rows: Row[]) => void } = {}) {
  let state = rows.map((r) => ({ ...r }));
  const audits: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const log = { updates: 0, txs: 0, disconnected: 0, inTx: false };
  const pick = (r: Row | undefined, select?: Record<string, boolean>) => {
    if (!r) return null;
    if (!select) return { ...r };
    return Object.fromEntries(Object.keys(select).map((k) => [k, (r as Record<string, unknown>)[k]]));
  };
  const find = ({ where, select }: { where: { email?: string; id?: string }; select?: Record<string, boolean> }) =>
    pick(state.find((r) => (where.email !== undefined ? r.email === where.email : r.id === where.id)), select);
  const userApi = {
    async findUnique(a: { where: { email?: string; id?: string }; select?: Record<string, boolean> }) { return find(a); },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      assert.ok(log.inTx, 'update only inside the transaction');
      const r = state.find((x) => x.id === where.id)!;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in (v as object)) (r as Record<string, unknown>)[k] = ((r as unknown as Record<string, number>)[k] ?? 0) + (v as { increment: number }).increment;
        else (r as Record<string, unknown>)[k] = v;
      }
      log.updates++;
      return { id: r.id };
    },
  };
  const db = {
    user: userApi,
    async $transaction<T>(fn: (tx: unknown) => Promise<T>) {
      log.txs++;
      const snap = state.map((r) => ({ ...r })); const auditLen = audits.length;
      const tx = {
        user: userApi,
        auditLog: { async create({ data }: { data: Record<string, unknown> }) { if (opts.failAudit) throw Object.assign(new Error(`insert failed for ${EMAIL} ${PW}`), { code: 'P2010' }); audits.push(data); return data; } },
        async $executeRaw(strings: TemplateStringsArray, ...vals: unknown[]) { opts.beforeLock?.(state); raw.push(strings.join('?') + JSON.stringify(vals)); return 1; },
      };
      log.inTx = true;
      try { return await fn(tx); } catch (e) { state = snap; audits.length = auditLen; throw e; } finally { log.inTx = false; }
    },
    async $disconnect() { log.disconnected++; },
  };
  return { db, audits, raw, log, get rows() { return state; } };
}

type FetchCall = { url: string; body: unknown; auth: string };
function fakeFetch(ok = true) {
  const calls: FetchCall[] = [];
  const f = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return { ok, json: async () => [{ result: 1 }] };
  };
  return { f, calls };
}

async function run(rows: Row[], o: { argv?: string[]; env?: Record<string, string | undefined>; pw?: string | { error: string }; db?: ReturnType<typeof fakeDb>; fetchOk?: boolean; tty?: boolean } = {}) {
  const fdb = o.db ?? fakeDb(rows);
  const ff = fakeFetch(o.fetchOk ?? true);
  let out = '', err = '', pwReads = 0, hashed = '';
  const issued: Issued[] = [];
  const code = await runReset({
    argv: o.argv ?? ['--email', EMAIL],
    env: { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x', NEXT_PUBLIC_SITE_URL: 'https://geiom.com', ...(o.env ?? {}) },
    stdoutIsTTY: o.tty ?? true,
    issueToken: (now: number, start: number) => { const t = newEnrollToken(now, start); issued.push(t); return t; },
    readPassword: async () => { pwReads++; return o.pw ?? PW; },
    db: async () => fdb.db,
    hash: async (p) => (hashed = await argonHash(p, ARGON)),
    fetchImpl: ff.f as never,
    now: () => NOW,
    out: (s) => { out += s; }, err: (s) => { err += s; },
  });
  const all = out + err + JSON.stringify(fdb.audits) + JSON.stringify(ff.calls.map((c) => c.body));
  // 任何输出、审计、发给 Redis 的命令里都不能出现密码、哈希、待确认密钥或邮箱明文
  for (const s of [PW, SECRET, EMAIL, ...(hashed ? [hashed] : [])]) assert.ok(!all.includes(s), `leaked ${s === PW ? 'password' : s === SECRET ? 'secret' : s === EMAIL ? 'email' : 'hash'}`);
  // #347：令牌只出现在 stdout 一次；不进 stderr、审计、发给 Redis 的命令
  for (const t of issued) {
    assert.equal(out.split(t.token).length - 1, code === 0 ? 1 : 0, 'token printed exactly once on stdout, and only on success');
    const elsewhere = err + JSON.stringify(fdb.audits) + JSON.stringify(ff.calls.map((c) => c.body));
    assert.ok(!elsewhere.includes(t.token) && !elsewhere.includes(t.data.enrollTokenHash), 'token / hash leaked outside stdout');
  }
  return { code, out, err, pwReads, hashed, fdb, ff, issued };
}

// ---------------- 与应用代码一致 ----------------

test('常量、限流 key 推导、argon2 参数与应用代码一致', async () => {
  const guard = await import('../src/lib/server/admin/enroll-guard');
  assert.equal(ENROLL_WINDOW_MS, guard.ENROLL_WINDOW_MS);
  const login = readFileSync('src/lib/server/admin/login.ts', 'utf8');
  assert.match(login, new RegExp(`const LOGIN_WINDOW_MS = ${LOGIN_WINDOW_MS / 60_000} \\* 60_000;`));
  // loginKeys：单账号桶 = login-acct:<rateLimitKeyHash(email.trim().toLowerCase())>
  assert.match(login, /const e = rateLimitKeyHash\(email\.trim\(\)\.toLowerCase\(\)\);/);
  assert.match(login, /acct: `login-acct:\$\{e\}`/);
  for (const env of [{}, { AUTH_SECRET: 's3cret' }, { APP_ENV: 'production', AUTH_SECRET: 'x' }, { VERCEL_ENV: 'preview' }, { NODE_ENV: 'test' }, { APP_ENV: 'stag ing!' }]) {
    assert.equal(rateLimitEnv(env), appEnv(env));
    for (const v of ['ryan@example.com', 'a@b.de', '']) assert.equal(rateLimitKeyHash(v, env), appKeyHash(v, env));
  }
  assert.equal(guard.ENROLL_CONFIRM_WINDOW_MS, ENROLL_CONFIRM_WINDOW_MS);
  assert.equal(UNTRUSTED, APP_UNTRUSTED); assert.equal(rateLimitSubject(null), UNTRUSTED);
  // loginKeys().ipAcct = login:<rateLimitSubject(ip)>:<e>；enrollConfirmRateOk = enroll-confirm:<rateLimitSubject(ip)>:<rateLimitKeyHash(email.trim().toLowerCase())>
  assert.match(login, /ipAcct: `login:\$\{rateLimitSubject\(ip\)\}:\$\{e\}`/);
  const eg = readFileSync('src/lib/server/admin/enroll-guard.ts', 'utf8');
  assert.match(eg, /enrollConfirmKey = \(ip: string \| null, email: string\) => `enroll-confirm:\$\{rateLimitSubject\(ip\)\}:\$\{rateLimitKeyHash\(email\.trim\(\)\.toLowerCase\(\)\)\}`;/);
  assert.match(eg, /hitRateLimit\(enrollConfirmKey\(ip, email\), ENROLL_CONFIRM_LIMIT, ENROLL_CONFIRM_WINDOW_MS/);
  const e0 = appKeyHash('ryan@example.com', {});
  assert.deepEqual(accountOnlyRateKeys(' Ryan@Example.com ', {}), [
    { key: `login-acct:${e0}`, windowMs: LOGIN_WINDOW_MS },
    { key: `login:untrusted:${e0}`, windowMs: LOGIN_WINDOW_MS },
    { key: `enroll-confirm:untrusted:${e0}`, windowMs: ENROLL_CONFIRM_WINDOW_MS },
  ]);
  assert.match(readFileSync('src/lib/server/admin/crypto.ts', 'utf8'), new RegExp(`memoryCost: ${ARGON.memoryCost}, timeCost: ${ARGON.timeCost}, parallelism: ${ARGON.parallelism}`));
});

test('Upstash 实际 key 与 hitRateLimit → UpstashStore.hit 计数用的 key 完全相同（三个账号 key，固定窗口带序号）', async () => {
  const env = { APP_ENV: 'production', AUTH_SECRET: 'k' };
  const realFetch = globalThis.fetch; const realNow = Date.now;
  let sent: string[][] = [];
  globalThis.fetch = (async (_u: string, init: { body: string }) => { sent = JSON.parse(init.body); return new Response(JSON.stringify([{ result: 1 }, { result: 1 }])); }) as typeof fetch;
  Date.now = () => NOW;
  try {
    for (const { key, windowMs } of accountOnlyRateKeys(EMAIL, env)) {
      await new UpstashStore('https://x.example', 't').hit(`${appEnv(env)}:${key}`, 10, windowMs);
      assert.equal(sent[0][0], 'INCR');
      assert.equal(sent[0][1], upstashKey(key, env, NOW, windowMs));
      // 上一个窗口：时间往回拨一个窗口，hit 用的 key 就是 offset=-1
      Date.now = () => NOW - windowMs;
      await new UpstashStore('https://x.example', 't').hit(`${appEnv(env)}:${key}`, 10, windowMs);
      assert.equal(sent[0][1], upstashKey(key, env, NOW, windowMs, -1));
      Date.now = () => NOW;
    }
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
});

test('哈希与登录校验（checkPassword → verifySecret）兼容', async () => {
  const h = await argonHash(PW, ARGON);
  assert.ok(await verifySecret(h, PW));
  assert.ok(!(await verifySecret(h, PW + 'x')));
});

// ---------------- 参数 ----------------

test('参数：密码不能出现在命令行参数里（任何写法），目标二选一，未知参数拒绝，错误码不带参数值', () => {
  for (const argv of [['--email', EMAIL, '--password', PW], [`--password=${PW}`], ['-p', PW], ['--new-pass', PW], ['--id', 'x', `--secret=${PW}`]])
    assert.deepEqual(parseArgs(argv), { error: 'password_in_argv' }, argv.join(' '));
  assert.deepEqual(parseArgs(['--email', EMAIL, PW]), { error: 'unknown_arg' });
  assert.deepEqual(parseArgs([]), { error: 'no_target' });
  assert.deepEqual(parseArgs(['--email', EMAIL, '--id', 'abc']), { error: 'both_targets' });
  assert.deepEqual(parseArgs(['--email', 'nope']), { error: 'invalid_email' });
  assert.deepEqual(parseArgs(['--id', 'a b']), { error: 'invalid_id' });
  assert.deepEqual(parseArgs([`${CLEAR_FLAG}=yes`, '--email', EMAIL]), { error: 'unknown_arg' });
  assert.deepEqual(parseArgs(['--email', ' Ryan@Example.COM ', CLEAR_FLAG]), { email: EMAIL, id: undefined, clearPendingEnroll: true, help: false });
  assert.deepEqual(parseArgs(['--id=cuid_1']), { email: undefined, id: 'cuid_1', clearPendingEnroll: false, help: false });
  for (const m of Object.values(MESSAGES)) assert.doesNotMatch(m, /\$\{/);
});

test('环境变量里的密码只删不读：stripPasswordEnv 只返回变量名；读不到标准输入时不会退回去用环境变量', async () => {
  const env: Record<string, string | undefined> = { ADMIN_RESET_PASSWORD: PW, ADMIN_CREATE_PASSWORD: PW, OTHER: '1' };
  assert.deepEqual(stripPasswordEnv(env), ['ADMIN_RESET_PASSWORD', 'ADMIN_CREATE_PASSWORD']);
  assert.deepEqual(env, { OTHER: '1' });
  // 即使 runReset 拿到的 env 里还有密码变量，也只认 readPassword
  const r = await run([user()], { env: { ADMIN_RESET_PASSWORD: PW, ADMIN_CREATE_PASSWORD: PW }, pw: '' });
  assert.equal(r.code, 1); assert.match(r.err, /没有读到密码/);
  assert.equal(r.fdb.log.txs, 0); assert.equal(r.fdb.rows[0].passwordHash, 'OLD-HASH');
});

// ---------------- 判定 ----------------

test('TOTP 已启用：带 --clear-pending-enroll 也拒绝（退出 3），不读密码、不写库', async () => {
  for (const argv of [['--email', EMAIL], ['--email', EMAIL, CLEAR_FLAG], ['--id', 'cuid_admin_1', CLEAR_FLAG]]) {
    const r = await run([user({ totpEnabled: true, totpSecret: SECRET })], { argv });
    assert.equal(r.code, 3, argv.join(' ')); assert.match(r.err, /已经绑定 2FA/);
    assert.equal(r.pwReads, 0); assert.equal(r.fdb.log.txs, 0); assert.equal(r.fdb.audits.length, 0);
  }
  assert.equal(decide(user({ totpEnabled: true }) as ResetUser, { clearPendingEnroll: true, now: NOW }), 'totp_enabled');
});

test('角色不是 ADMIN：拒绝（退出 3），带参数也一样；账号不存在、已停用也拒绝', async () => {
  for (const role of ['SALES', 'EDITOR']) {
    const r = await run([user({ role })], { argv: ['--email', EMAIL, CLEAR_FLAG] });
    assert.equal(r.code, 3); assert.match(r.err, /不是 ADMIN/); assert.equal(r.fdb.log.txs, 0); assert.equal(r.pwReads, 0);
  }
  const nf = await run([user()], { argv: ['--email', 'other@example.com'] });
  assert.equal(nf.code, 3); assert.match(nf.err, /没有找到/);
  const dis = await run([user({ disabled: true })], { argv: ['--email', EMAIL, CLEAR_FLAG] });
  assert.equal(dis.code, 3); assert.match(dis.err, /已停用/); assert.equal(dis.fdb.log.txs, 0);
});

test('有待确认的绑定但没带参数：拒绝（退出 3），提示加 --clear-pending-enroll，什么都不改', async () => {
  const pendings: Partial<ResetUser>[] = [
    { totpSecret: SECRET, totpPendingUntil: new Date(NOW + 5 * 60_000) },
    { totpPendingUntil: new Date(NOW + 60_000) }, // 作废后冷却中
    { totpEnrollFails: 2 },
    { enrollIssuedAt: new Date(NOW - H) },
    { totpSecret: SECRET }, // 旧数据：没有有效期的待确认密钥
  ];
  for (const p of pendings) {
    const r = await run([user(p)]);
    assert.equal(r.code, 3, JSON.stringify(p)); assert.ok(r.err.includes(CLEAR_FLAG)); assert.match(r.err, /未完成的 2FA 绑定/);
    assert.equal(r.pwReads, 0); assert.equal(r.fdb.log.txs, 0); assert.equal(r.fdb.audits.length, 0);
    assert.equal(r.fdb.rows[0].passwordHash, 'OLD-HASH'); assert.equal(r.fdb.rows[0].sessionVersion, 3);
    assert.equal(r.ff.calls.length, 0);
    assert.ok(hasPendingEnroll(p));
  }
  assert.ok(!hasPendingEnroll(user()));
});

test('绑定窗口已关闭（建号超过 72 小时、从没绑定）且没带参数：拒绝，提示加参数', async () => {
  const r = await run([user({ createdAt: new Date(NOW - 80 * H) })]);
  assert.equal(r.code, 3); assert.match(r.err, /绑定窗口已关闭/); assert.ok(r.err.includes(CLEAR_FLAG)); assert.equal(r.fdb.log.txs, 0);
});

// ---------------- 成功路径 ----------------

test('带 --clear-pending-enroll：同一事务里改密码、清待确认状态、会话失效、解除锁定、写两条审计；之后可以从头绑定', async () => {
  const guard = await import('../src/lib/server/admin/enroll-guard');
  const u = user({ totpSecret: SECRET, totpPendingUntil: new Date(NOW + 5 * 60_000), totpEnrollFails: 3, totpLastStep: 123, enrollIssuedAt: new Date(NOW - 100 * H), createdAt: new Date(NOW - 200 * H) });
  // 参数生效之前，这个账号确实不能重新 enroll（窗口已关、在冷却中）
  assert.ok(!guard.enrollWindowOpen(u, NOW)); assert.ok(guard.enrollCoolingDown(u, NOW));
  const r = await run([u], { argv: ['--email', EMAIL, CLEAR_FLAG], env: { RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'https://r.example/', UPSTASH_REDIS_REST_TOKEN: 'tok', AUTH_SECRET: 'a', APP_ENV: 'production' } });
  assert.equal(r.code, 0, r.err);
  const row = r.fdb.rows[0];
  assert.equal(r.fdb.log.txs, 1); assert.equal(r.fdb.log.updates, 1); assert.equal(r.fdb.log.disconnected, 1);
  assert.match(r.fdb.raw[0], /FOR UPDATE/); assert.match(r.fdb.raw[0], /cuid_admin_1/);
  assert.ok(await verifySecret(row.passwordHash, PW), 'new hash verifies like checkPassword');
  assert.equal(row.sessionVersion, 4);
  assert.equal(row.failedLogins, 0); assert.equal(row.lockedUntil, null);
  assert.equal(row.totpSecret, null); assert.equal(row.totpLastStep, null); assert.equal(row.totpPendingUntil, null); assert.equal(row.totpEnrollFails, 0);
  assert.deepEqual(row.recoveryCodes, []); assert.equal(row.totpEnabled, false);
  assert.equal(row.enrollIssuedAt?.getTime(), NOW);
  // 可以从头绑定：窗口打开、不在冷却期、没有可确认的旧密钥（下一次 enroll 会发新密钥）
  assert.ok(guard.enrollWindowOpen(row, NOW)); assert.ok(!guard.enrollCoolingDown(row, NOW)); assert.ok(!guard.pendingSecretUsable(row, NOW));
  // 审计：actor=cli、目标 id；没有密码、哈希、密钥、邮箱（run() 里已统一检查）
  assert.deepEqual(r.fdb.audits.map((a) => a.action), ['user.password_reset', 'user.pending_enroll_cleared', 'auth.enroll_token_issued']);
  // #347：同一次 update 里写了新令牌哈希；clearPending 重新打开窗口 → 24 小时、不截短
  assert.equal(r.issued.length, 1);
  assert.equal(row.enrollTokenHash, hashEnrollToken(r.issued[0].token)); assert.equal(row.enrollTokenExpiresAt?.getTime(), NOW + 24 * H);
  assert.deepEqual(r.fdb.audits[2].meta, { actor: 'cli', source: 'cli', via: VIA, truncated: false });
  for (const a of r.fdb.audits) { assert.equal(a.actorId, null); assert.equal(a.target, 'cuid_admin_1'); assert.equal((a.meta as { actor: string }).actor, 'cli'); assert.equal((a.meta as { via: string }).via, VIA); }
  for (const a of r.fdb.audits) for (const k of [...Object.keys(a), ...Object.keys(a.meta as object)]) assert.doesNotMatch(k, /hash|secret|password|email|totp/i, k);
  // 限流：提交后只 DEL login-acct:<e> 当前窗口，一条命令，不 SCAN/KEYS，不碰 login-ip / login:<ip>:<e> / enroll-confirm
  assert.equal(r.ff.calls.length, 1);
  assert.equal(r.ff.calls[0].url, 'https://r.example/pipeline'); assert.equal(r.ff.calls[0].auth, 'Bearer tok');
  const env = { AUTH_SECRET: 'a', APP_ENV: 'production' };
  // 删除的 key 恰好是这 6 个（3 个账号 key × 当前 / 上一个窗口），一条 pipeline 里全是 DEL
  const e = appKeyHash(EMAIL, env), w = Math.floor(NOW / LOGIN_WINDOW_MS), cw = Math.floor(NOW / ENROLL_CONFIRM_WINDOW_MS);
  const expected = [
    `rl:production:login-acct:${e}:${w}`, `rl:production:login-acct:${e}:${w - 1}`,
    `rl:production:login:untrusted:${e}:${w}`, `rl:production:login:untrusted:${e}:${w - 1}`,
    `rl:production:enroll-confirm:untrusted:${e}:${cw}`, `rl:production:enroll-confirm:untrusted:${e}:${cw - 1}`,
  ];
  assert.deepEqual(r.ff.calls[0].body, expected.map((k) => ['DEL', k]));
  assert.deepEqual(rateKeysToDelete(EMAIL, env, NOW), expected);
  const sentText = JSON.stringify(r.ff.calls);
  assert.doesNotMatch(sentText, /SCAN|KEYS|login-ip|enroll-ip/);
  // 没有任何真实 IP 的桶：login:/enroll-confirm: 后面只能是 untrusted
  for (const [, k] of r.ff.calls[0].body as string[][]) assert.match(k, /^rl:production:(login-acct|login:untrusted|enroll-confirm:untrusted):/);
  assert.match(r.out, /rate_limit=cleared/); assert.match(r.out, /72 小时绑定窗口重新开始/);
  assert.ok(r.out.includes('cuid_admin_1'));
});

test('没有待确认状态的新账号：不带参数即可，只写 password_reset 一条审计、不动绑定字段；内存限流跳过', async () => {
  const r = await run([user()], { argv: ['--id', 'cuid_admin_1'] });
  assert.equal(r.code, 0, r.err);
  const row = r.fdb.rows[0];
  assert.deepEqual(r.fdb.audits.map((a) => a.action), ['user.password_reset', 'auth.enroll_token_issued']);
  assert.equal(row.enrollTokenHash, hashEnrollToken(r.issued[0].token)); // 不带参数也签发
  assert.equal(row.enrollIssuedAt, null); assert.equal(row.sessionVersion, 4); assert.ok(await verifySecret(row.passwordHash, PW));
  assert.equal(r.ff.calls.length, 0); assert.match(r.out, /rate_limit=skipped_memory/);
});

test('清限流失败不影响已提交的改密（退出 0，给提示，不输出 key/token）', async () => {
  const r = await run([user()], { env: { RATE_LIMIT_STORE: 'upstash', UPSTASH_REDIS_REST_URL: 'https://r.example', UPSTASH_REDIS_REST_TOKEN: 'tok-SHOULD-NOT-LEAK' }, fetchOk: false });
  assert.equal(r.code, 0); assert.match(r.out, /rate_limit=failed/); assert.match(r.err, /10 分钟/);
  assert.ok(!(r.out + r.err).includes('tok-SHOULD-NOT-LEAK')); assert.ok(!(r.out + r.err).includes('login-acct'));
});

async function closedPort() {
  const srv = net.createServer();
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((ok, err) => srv.close((e) => (e ? err(e) : ok())));
  return port;
}

test('#432 redis：清掉与 Upstash 相同的 6 个 key，打印 rate_limit=cleared，不输出密码', async () => {
  const redisPw = 'redis-secret-SHOULD-NOT-LEAK';
  const fake = await startFakeRedis({ password: redisPw });
  try {
    const env = { AUTH_SECRET: 'a', APP_ENV: 'production' };
    const r = await run([user()], {
      env: { ...env, RATE_LIMIT_STORE: 'redis', REDIS_URL: `redis://:${redisPw}@127.0.0.1:${fake.port}/2` },
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /rate_limit=cleared/);
    assert.equal(r.ff.calls.length, 0);
    assert.ok(fake.commands().some((c) => c[0] === 'SELECT' && c[1] === '2'));
    assert.deepEqual(fake.auths(), [redisPw]);
    assert.deepEqual(fake.commands().filter((c) => c[0] === 'DEL').map((c) => c[1]), rateKeysToDelete(EMAIL, env, NOW));
    assert.ok(fake.commands().every((c) => c[0] === 'AUTH' || c[0] === 'SELECT' || c[0] === 'DEL'));
    const blob = r.out + r.err + JSON.stringify(fake.commands());
    assert.equal(blob.includes(redisPw), false);
    assert.equal(blob.includes(EMAIL), false);
  } finally { await fake.close(); }
});

test('#432 redis：连不上或 URL 无效时 rate_limit=failed，不抛错、不泄露', async () => {
  const redisPw = 'redis-secret-SHOULD-NOT-LEAK';
  const port = await closedPort();
  const r = await run([user()], {
    env: { RATE_LIMIT_STORE: 'redis', REDIS_URL: `redis://:${redisPw}@127.0.0.1:${port}` },
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /rate_limit=failed/);
  assert.match(r.err, /10 分钟/);
  const blob = r.out + r.err;
  for (const s of [redisPw, EMAIL, 'login-acct', String(port)]) assert.equal(blob.includes(s), false, s);
  assert.equal(await clearAccountRateLimits({ email: EMAIL, env: { RATE_LIMIT_STORE: 'redis', REDIS_URL: 'http://x' }, now: NOW }), 'failed');
  assert.equal(await clearAccountRateLimits({ email: EMAIL, env: { RATE_LIMIT_STORE: 'redis' }, now: NOW }), 'failed');
});

// ---------------- 失败路径 ----------------

test('弱密码 / 等于邮箱 / 两次不一致：退出 1，不写库，输出不含密码', async () => {
  for (const pw of ['short', EMAIL.toUpperCase(), 'x'.repeat(201)]) {
    const r = await run([user()], { pw });
    assert.equal(r.code, 1); assert.match(r.err, /密码不符合/); assert.equal(r.fdb.log.txs, 0);
    assert.ok(!(r.out + r.err).includes(pw));
  }
  const mm = await run([user()], { pw: { error: 'password_mismatch' } });
  assert.equal(mm.code, 1); assert.match(mm.err, /不一致/); assert.equal(mm.fdb.log.txs, 0);
});

test('事务里写审计失败：整体回滚（密码、会话、绑定字段都不变），只输出错误码，不输出底层 message', async () => {
  const fdb = fakeDb([user({ totpSecret: SECRET })], { failAudit: true });
  const r = await run([], { argv: ['--email', EMAIL, CLEAR_FLAG], db: fdb });
  assert.equal(r.code, 1); assert.match(r.err, /数据库操作失败.*（P2010）/);
  const row = fdb.rows[0];
  assert.equal(row.passwordHash, 'OLD-HASH'); assert.equal(row.sessionVersion, 3); assert.equal(row.totpSecret, SECRET);
  assert.equal(fdb.audits.length, 0); assert.equal(r.ff.calls.length, 0);
  assert.equal(row.enrollTokenHash, null, 'token hash rolled back too');
});

test('#347 stdout 不是终端 → 退出 2，读密码、连库之前就拒绝，什么都不改、不签发', async () => {
  let dbOpened = 0;
  const fdb = fakeDb([user()]);
  const r = await run([], { tty: false, db: { ...fdb, db: new Proxy(fdb.db, { get: (o, k) => { dbOpened++; return (o as never)[k]; } }) } as never });
  assert.equal(r.code, 2); assert.match(r.err, /^没有检测到交互终端，未生成绑定链接，之前的链接仍然有效。请用 -it 重新运行$/m); assert.equal(r.pwReads, 0); assert.equal(dbOpened, 0);
  assert.equal(r.issued.length, 0); assert.equal(fdb.rows[0].passwordHash, 'OLD-HASH');
});

test('#347 NEXT_PUBLIC_SITE_URL 不合格（http 生产、带路径、缺失）→ 退出 1，读密码、连库之前拒绝', async () => {
  for (const env of [{ NEXT_PUBLIC_SITE_URL: 'http://geiom.com' }, { NEXT_PUBLIC_SITE_URL: 'http://localhost:3000', APP_ENV: 'production' }, { NEXT_PUBLIC_SITE_URL: 'https://geiom.com/x' }, { NEXT_PUBLIC_SITE_URL: '' }]) {
    const r = await run([user()], { env });
    assert.equal(r.code, 1, JSON.stringify(env)); assert.match(r.err, /NEXT_PUBLIC_SITE_URL 不合格/); assert.equal(r.pwReads, 0); assert.equal(r.fdb.log.txs, 0);
  }
});

test('#347 终端输出三行：链接（#t= fragment）/ 有效至 PT（窗口截短时追加一句）/ 只私信给本人；重新签发覆盖旧令牌', async () => {
  // 不带参数、窗口从 createdAt 起已过 60 小时 → 令牌只剩 12 小时，截短
  const old = newEnrollToken(NOW - H, NOW - 60 * H);
  const r = await run([user({ createdAt: new Date(NOW - 60 * H), ...old.data })]);
  assert.equal(r.code, 0, r.err);
  const t = r.issued[0];
  assert.equal(t.expiresAt.getTime(), NOW + 12 * H); assert.equal(t.expiresTruncated, true);
  const lines = r.out.trimEnd().split('\n').slice(-3);
  assert.equal(lines[0], `https://geiom.com/admin-enroll#t=${t.token}`);
  assert.match(lines[1], /^有效至 \d{4}-\d{2}-\d{2} \d{2}:\d{2} PT 已按账号绑定截止时间缩短$/);
  assert.equal(lines[2], '只私信发给本人，不要贴到群里或工单里');
  const row = r.fdb.rows[0] as Record<string, unknown>;
  assert.notEqual(row.enrollTokenHash, old.data.enrollTokenHash); assert.equal(row.enrollTokenHash, hashEnrollToken(t.token));
  assert.ok(!r.out.includes(old.token));
});

test('#347 数据库打不开 → 退出 1，只给错误类型，不签发、不打印链接', async () => {
  let out = '', err = '';
  const code = await runReset({
    argv: ['--email', EMAIL], env: { DATABASE_URL: 'set', NEXT_PUBLIC_SITE_URL: 'https://geiom.com' }, stdoutIsTTY: true,
    readPassword: async () => PW, db: async () => { throw Object.assign(new Error(`connect failed postgresql://u:dbpass-SHOULD-NOT-LEAK@h/x ${EMAIL}`), { name: 'PrismaClientInitializationError' }); },
    hash: async () => 'H', fetchImpl: (async () => { throw new Error('x'); }) as never, out: (s) => { out += s; }, err: (s) => { err += s; },
  });
  assert.equal(code, 1); assert.match(err, /数据库操作失败.*（PrismaClientInitializationError）/);
  for (const s of ['dbpass-SHOULD-NOT-LEAK', EMAIL, '#t=']) assert.ok(!(out + err).includes(s), s);
});

test('读完密码后、加锁之前账号被并发绑定了 2FA：锁内重新判定后拒绝，什么都不写', async () => {
  const fdb = fakeDb([user()], { beforeLock: (rows) => { rows[0].totpEnabled = true; } });
  const r = await run([], { db: fdb });
  assert.equal(r.code, 3); assert.match(r.err, /已经绑定 2FA/);
  assert.equal(fdb.rows[0].passwordHash, 'OLD-HASH'); assert.equal(fdb.audits.length, 0); assert.equal(r.ff.calls.length, 0);
});

// ---------------- 子进程 ----------------

function cli(args: string[], env: Record<string, string> = {}, input = '') {
  const r = spawnSync(process.execPath, ['scripts/admin-reset-initial-password.mjs', ...args], {
    env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv, input, encoding: 'utf8', timeout: 30_000,
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('CLI：命令行带密码 → 退出 2，不回显；环境变量密码被忽略并删除，输出里只有变量名', () => {
  const a = cli(['--email', EMAIL, '--password', PW], { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x' });
  assert.equal(a.code, 2); assert.match(a.out, /命令行参数/); assert.ok(!a.out.includes(PW));
  const b = cli(['--email', EMAIL], { ADMIN_RESET_PASSWORD: PW, ADMIN_CREATE_PASSWORD: PW });
  // #347：子进程的 stdout 是管道（不是终端）→ 先报 stdout_not_tty（退出 2），不读密码、不连库
  assert.equal(b.code, 2); assert.match(b.out, /已忽略并删除环境变量 ADMIN_RESET_PASSWORD, ADMIN_CREATE_PASSWORD/); assert.match(b.out, /^没有检测到交互终端，未生成绑定链接，之前的链接仍然有效。请用 -it 重新运行$/m);
  assert.ok(!b.out.includes(PW));
});

test('CLI：stdout 不是终端（管道 / 重定向）→ 退出 2，不读标准输入的密码、不连库，不输出密码、邮箱或连接串', () => {
  // 数据库不可达的路径改由上面的 runReset 单测覆盖（子进程拿不到终端）
  const r = cli(['--email', EMAIL], { DATABASE_URL: 'postgresql://dbuser:dbpass-SHOULD-NOT-LEAK@127.0.0.1:1/x', ADMIN_RESET_PASSWORD: PW, NEXT_PUBLIC_SITE_URL: 'https://geiom.com' }, `${PW}\n`);
  assert.equal(r.code, 2); assert.match(r.out, /^没有检测到交互终端，未生成绑定链接，之前的链接仍然有效。请用 -it 重新运行$/m); assert.doesNotMatch(r.out, /数据库操作失败/);
  for (const s of [PW, 'dbpass-SHOULD-NOT-LEAK', 'dbuser', EMAIL]) assert.ok(!r.out.includes(s), s);
});

test('只有 CLI；会进 standalone 产物；源码里没有 SCAN/KEYS、没有清 login-ip，没有把密码交给 console', () => {
  const lib = readFileSync('scripts/admin-reset-initial-password-lib.mjs', 'utf8');
  const entry = readFileSync('scripts/admin-reset-initial-password.mjs', 'utf8');
  for (const src of [lib, entry]) {
    assert.doesNotMatch(src, /'SCAN'|'KEYS'|"SCAN"|"KEYS"/);
    assert.doesNotMatch(src, /console\./);
    assert.doesNotMatch(src, /process\.env\.ADMIN_(RESET|CREATE)_PASSWORD/);
  }
  assert.doesNotMatch(lib, /`login-ip:|`enroll-ip:/);
  assert.doesNotMatch(lib.slice(lib.indexOf('export function accountOnlyRateKeys')), /`login:\$\{(?!UNTRUSTED)|`enroll-confirm:\$\{(?!UNTRUSTED)/);
  assert.match(readFileSync('next.config.ts', 'utf8'), /'\.\/scripts\/admin-reset-initial-password\.mjs', '\.\/scripts\/admin-reset-initial-password-lib\.mjs'/);
  assert.match(readFileSync('next.config.ts', 'utf8'), /'\.\/scripts\/enroll-token-lib\.mjs'/); // #347 reset 脚本 import 了它
  assert.match(readFileSync('Dockerfile', 'utf8'), /test -f scripts\/admin-reset-initial-password\.mjs && test -f scripts\/admin-reset-initial-password-lib\.mjs/);
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).scripts['admin:reset-initial-password'], 'node scripts/admin-reset-initial-password.mjs');
});
