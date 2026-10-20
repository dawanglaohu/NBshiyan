import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { authenticator } from 'otplib';
import { setRateLimitStore, MemoryStore } from '../src/lib/server/ratelimit/index';
import { hashSecret } from '../src/lib/server/admin/crypto';
import type * as Guard from '../src/lib/server/admin/enroll-guard';

// #347 绑定窗口 + 待确认密钥不可覆盖；#348 只按账号、只统计密码已通过的错码。prisma 换成内存库，不连任何数据库。
const PASSWORD = 'correct-horse-battery-staple';
const EMAIL = 'owner@example.test';
const EDGE = 'e'.repeat(40); // 假的 EDGE_AUTH_SECRET，只为了让测试能模拟不同客户端 IP
// #347 方案 A：测试用的一次性绑定令牌（假值，43 字符 base64url）；库里只放它的 sha256。post() 默认把它放进请求体
const TOKEN = 'T'.repeat(43);
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
Object.assign(process.env, { APP_ENV: 'test', ADMIN_TOTP_KEY: Buffer.alloc(32, 7).toString('base64'), EDGE_AUTH_SECRET: EDGE });
delete process.env.ADMIN_ALERT_EMAIL; delete process.env.INQUIRY_NOTIFY_EMAIL;

type Row = Record<string, unknown> & { id: string; email: string };
let users: Row[] = [];
let audits: { actorId: string | null; action: string; target: string | null; meta?: unknown; ip: string }[] = [];
const match = (u: Row, where: Record<string, unknown>): boolean => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => match(u, w));
  if (v === null) return u[k] === null || u[k] === undefined;
  if (v instanceof Date) return (u[k] as Date)?.getTime() === v.getTime();
  if (typeof v === 'object') {
    const c = v as { lt?: number | Date; lte?: number | Date; gt?: number | Date };
    const x = u[k] as number | Date | null; if (x === null || x === undefined) return false;
    if (c.lt !== undefined && !(+x < +c.lt)) return false;
    if (c.lte !== undefined && !(+x <= +c.lte)) return false;
    if (c.gt !== undefined && !(+x > +c.gt)) return false;
    return true;
  }
  return u[k] === v;
});
const apply = (u: Row, data: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && 'increment' in v) u[k] = (u[k] as number) + (v as { increment: number }).increment;
    else u[k] = v;
  }
};
const copy = (u: Row) => ({ ...u });
const db = {
  user: {
    findUnique: async ({ where }: { where: { email?: string; id?: string } }) => { const u = users.find((x) => (where.email ? x.email === where.email : x.id === where.id)); return u ? copy(u) : null; },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const u = users.find((x) => x.id === where.id)!; apply(u, data); return copy(u); },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = users.filter((u) => match(u, where)); hit.forEach((u) => apply(u, data)); return { count: hit.length };
    },
  },
  auditLog: { create: async ({ data }: { data: (typeof audits)[number] }) => { audits.push(data); return {}; } },
};
(globalThis as { prisma?: unknown }).prisma = db;

let hash = '';
const newUser = (over: Partial<Row> = {}): Row => ({
  id: 'u_owner', email: EMAIL, name: 'Owner', passwordHash: hash, role: 'SALES', totpSecret: null, totpEnabled: false, totpLastStep: null,
  recoveryCodes: [], sessionVersion: 0, disabled: false, failedLogins: 0, lockedUntil: null, lastLoginAt: null, reactivatedAt: null,
  enrollIssuedAt: null, totpPendingUntil: null, totpEnrollFails: 0,
  enrollTokenHash: TOKEN_HASH, enrollTokenExpiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), ...over,
});
const owner = () => users.find((u) => u.id === 'u_owner')!;

type H = (req: Request) => Promise<Response>;
let enrollR: { POST: H }; let confirmR: { POST: H };
// 引用 db 的模块都在 globalThis.prisma 换好之后再动态 import（静态 import 会先求值，拿到真的 PrismaClient）
let ENROLL_IP_LIMIT: number, ENROLL_MAX_BAD_TOTP: number, ENROLL_PENDING_MS: number, ENROLL_WINDOW_MS: number;
let enrollWindowOpen: typeof Guard.enrollWindowOpen;
let reset2faData: () => unknown;
before(async () => {
  hash = await hashSecret(PASSWORD);
  ({ ENROLL_IP_LIMIT, ENROLL_MAX_BAD_TOTP, ENROLL_PENDING_MS, ENROLL_WINDOW_MS, enrollWindowOpen } = await import('../src/lib/server/admin/enroll-guard'));
  ({ reset2faData } = await import('../src/lib/server/admin/accounts'));
  enrollR = await import('../src/app/api/auth-admin/enroll/route');
  confirmR = await import('../src/app/api/auth-admin/enroll/confirm/route');
});
beforeEach(() => { setRateLimitStore(new MemoryStore()); users = [newUser()]; audits = []; });

let ipN = 0;
const freshIp = () => `198.51.100.${(++ipN % 250) + 1}`; // 每次换一个 IP（文档保留段）
/** 对象请求体默认带上 TOKEN；显式写了 token 键（包括 undefined）的保持原样 */
const withToken = (body: unknown) => (body && typeof body === 'object' && !Array.isArray(body) && !('token' in body) ? { ...body, token: TOKEN } : body);
const post = (path: string, body: unknown, ip = freshIp(), origin: string | null = 'http://localhost') => new Request(`http://localhost${path}`, {
  method: 'POST', body: JSON.stringify(withToken(body)),
  headers: { 'content-type': 'application/json', 'x-edge-auth': EDGE, 'cf-connecting-ip': ip, ...(origin ? { origin } : {}) },
});
const call = async (r: Promise<Response>) => { const res = await r; return { status: res.status, body: await res.json() as Record<string, unknown> }; };
const enroll = (body: unknown = { email: EMAIL, password: PASSWORD }, ip?: string) => call(enrollR.POST(post('/api/auth-admin/enroll', body, ip)));
const confirm = (totp: string, password = PASSWORD, email = EMAIL, ip?: string) => call(confirmR.POST(post('/api/auth-admin/enroll/confirm', { email, password, totp }, ip)));
const secretOf = (uri: unknown) => new URL(String(uri)).searchParams.get('secret')!;
/** 当前对这个密钥一定无效的 6 位码（排除 ±1 个时间步内的有效码） */
const wrongCode = (secret: string) => { for (let i = 0; ; i++) { const c = String(i).padStart(6, '0'); if (authenticator.checkDelta(c, secret) === null) return c; } };
const KNOWN_CODES = new Set(['bad_credentials', 'bad_totp', 'invalid', 'rate_limited', 'forbidden_origin', 'enroll_reset']);

test('contract unchanged for #353 page: enroll → {otpauthUri}, confirm → {recoveryCodes[10]}', async () => {
  const e = await enroll();
  assert.equal(e.status, 200); assert.deepEqual(Object.keys(e.body), ['otpauthUri']);
  const c = await confirm(authenticator.generate(secretOf(e.body.otpauthUri)));
  assert.equal(c.status, 200); assert.deepEqual(Object.keys(c.body), ['recoveryCodes']);
  assert.equal((c.body.recoveryCodes as string[]).length, 10);
  assert.equal(owner().totpEnabled, true); assert.equal(owner().totpPendingUntil, null); assert.equal(owner().totpEnrollFails, 0);
});

test('#348 cap: bad TOTP with correct password from rotating IPs → 5th voids the pending secret (401 enroll_reset), old secret can no longer be confirmed', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  const enc = owner().totpSecret;
  for (let i = 1; i < ENROLL_MAX_BAD_TOTP; i++) {
    assert.deepEqual(await confirm(wrongCode(secret)), { status: 401, body: { error: 'bad_totp' } }, `attempt ${i}`);
    assert.equal(owner().totpEnrollFails, i); assert.equal(owner().totpSecret, enc);
  }
  assert.deepEqual(await confirm(wrongCode(secret)), { status: 401, body: { error: 'enroll_reset' } });
  assert.equal(owner().totpSecret, null, 'pending secret cleared');
  assert.equal(owner().totpEnrollFails, 0);
  assert.ok((owner().totpPendingUntil as Date).getTime() > Date.now(), 'cooldown started');
  // 即使拿到了正确的码，被作废的密钥也不能再确认
  assert.deepEqual(await confirm(authenticator.generate(secret)), { status: 401, body: { error: 'enroll_reset' } });
  assert.equal(owner().totpEnabled, false);
  // 审计：每次错码 + 一次作废；不含邮箱明文、密钥、验证码
  assert.equal(audits.filter((a) => a.action === 'auth.totp_enroll_fail').length, ENROLL_MAX_BAD_TOTP - 1);
  const v = audits.filter((a) => a.action === 'auth.totp_enroll_voided');
  assert.equal(v.length, 1); assert.equal(v[0].actorId, 'u_owner');
  assert.deepEqual(v[0].meta, { reason: 'too_many_bad_totp', fails: ENROLL_MAX_BAD_TOTP, voided: true });
  const dump = JSON.stringify(audits);
  for (const s of [EMAIL, secret, String(enc), PASSWORD, authenticator.generate(secret), wrongCode(secret)]) assert.ok(!dump.includes(s), `audit leaks ${s.slice(0, 8)}`);
  // 不动登录锁定（错码计数是单独的）
  assert.equal(owner().lockedUntil, null); assert.equal(owner().failedLogins, 0);
});

test('#348 after void: enroll is 429 rate_limited during cooldown, then re-enroll gives a new secret that confirms', async () => {
  const s1 = secretOf((await enroll()).body.otpauthUri);
  for (let i = 0; i < ENROLL_MAX_BAD_TOTP; i++) await confirm(wrongCode(s1));
  assert.equal(owner().totpSecret, null);
  assert.deepEqual(await enroll(), { status: 429, body: { error: 'rate_limited' } });
  assert.ok(audits.some((a) => a.action === 'auth.totp_enroll_blocked' && (a.meta as { reason: string }).reason === 'cooldown'));
  owner().totpPendingUntil = new Date(Date.now() - 1); // 冷却结束（模拟时间过去 10 分钟）
  assert.deepEqual(await confirm(authenticator.generate(s1)), { status: 401, body: { error: 'enroll_reset' } }, 'still voided until re-enroll');
  const e = await enroll();
  assert.equal(e.status, 200);
  const s2 = secretOf(e.body.otpauthUri);
  assert.notEqual(s2, s1);
  assert.equal(owner().totpEnrollFails, 0);
  const c = await confirm(authenticator.generate(s2));
  assert.equal(c.status, 200); assert.equal(owner().totpEnabled, true);
});

test('#348 reset on success: a few bad codes, then the right one → enabled and counter back to 0', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  for (let i = 0; i < ENROLL_MAX_BAD_TOTP - 2; i++) await confirm(wrongCode(secret));
  assert.equal(owner().totpEnrollFails, ENROLL_MAX_BAD_TOTP - 2);
  assert.equal((await confirm(authenticator.generate(secret))).status, 200);
  assert.equal(owner().totpEnrollFails, 0); assert.equal(owner().totpPendingUntil, null);
});

test('#348 wrong-password spam (rotating IPs) does not count, does not void the pending secret and does not block the owner', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  const enc = owner().totpSecret;
  for (let i = 0; i < 2; i++) { // 共 4 次密码错（confirm 2 + enroll 2）：低于原有登录锁定阈值 5
    assert.deepEqual(await confirm(wrongCode(secret), 'wrong-password-' + i), { status: 401, body: { error: 'bad_credentials' } });
    assert.deepEqual(await enroll({ email: EMAIL, password: 'nope-' + i }), { status: 401, body: { error: 'bad_credentials' } });
  }
  assert.equal(owner().totpEnrollFails, 0); assert.equal(owner().totpSecret, enc, 'not voided, not overwritten');
  assert.ok(!audits.some((a) => a.action === 'auth.totp_enroll_voided' || a.action === 'auth.totp_enroll_fail'));
  assert.equal((await confirm(authenticator.generate(secret))).status, 200, 'owner still completes binding');
});

test('#348 even when the pre-existing login lockout trips (5 wrong passwords), the pending secret and enroll counter are untouched', async () => {
  const orig = console.error; console.error = () => {}; // 锁定告警在测试里没有收件人
  try {
    await enroll();
    const enc = owner().totpSecret;
    for (let i = 0; i < 5; i++) await confirm('123456', 'wrong-' + i);
    assert.ok(owner().lockedUntil, 'existing login lockout (unchanged behaviour)');
    assert.equal(owner().totpSecret, enc); assert.equal(owner().totpEnrollFails, 0);
  } finally { console.error = orig; }
});

test('no enumeration: unknown account vs known account with wrong password look the same, also while the known one is voided / cooling down', async () => {
  const unknownE = await enroll({ email: 'nobody@example.test', password: 'x' });
  const knownE = await enroll({ email: EMAIL, password: 'x' });
  assert.deepEqual(unknownE, knownE); assert.deepEqual(knownE, { status: 401, body: { error: 'bad_credentials' } });
  const unknownC = await confirm('123456', 'x', 'nobody@example.test');
  const knownC = await confirm('123456', 'x');
  assert.deepEqual(unknownC, knownC); assert.deepEqual(knownC, { status: 401, body: { error: 'bad_credentials' } });
  // 被作废 + 冷却中：不知道密码的人看到的还是 bad_credentials（不是 429 / enroll_reset）
  Object.assign(owner(), { failedLogins: 0, totpSecret: null, totpPendingUntil: new Date(Date.now() + ENROLL_PENDING_MS) });
  assert.deepEqual(await enroll({ email: EMAIL, password: 'x' }), unknownE);
  assert.deepEqual(await confirm('123456', 'x'), unknownC);
  // 不存在的账号仍走 burnVerify（耗时与密码校验一致）
  const login = readFileSync('src/lib/server/admin/login.ts', 'utf8');
  assert.match(login, /if \(!user \|\| user\.disabled\) \{ await burnVerify\(password\);/);
});

test('#347 pending secret cannot be overwritten: second enroll within 10 min → 429, first secret still confirms', async () => {
  const s1 = secretOf((await enroll()).body.otpauthUri);
  const enc = owner().totpSecret;
  assert.deepEqual(await enroll(), { status: 429, body: { error: 'rate_limited' } });
  assert.equal(owner().totpSecret, enc);
  assert.ok(audits.some((a) => a.action === 'auth.totp_enroll_blocked' && (a.meta as { reason: string }).reason === 'pending'));
  assert.equal((await confirm(authenticator.generate(s1))).status, 200);
});

test('#347 expired pending secret (or one left from before this change) → bad_totp, not counted; enroll then issues a new one', async () => {
  await enroll();
  owner().totpPendingUntil = new Date(Date.now() - 1);
  const c = await confirm('123456');
  assert.deepEqual(c, { status: 401, body: { error: 'bad_totp' } });
  assert.equal(owner().totpEnrollFails, 0);
  owner().totpPendingUntil = null; // 加固前留下的待确认密钥
  assert.deepEqual(await confirm('123456'), { status: 401, body: { error: 'bad_totp' } });
  assert.equal((await enroll()).status, 200);
});

test('#347 enrollment window: 72h after createdAt (or last 2FA reset) enroll/confirm → bad_credentials + audit; a 2FA reset reopens it', async () => {
  users = [newUser({ createdAt: new Date(Date.now() - ENROLL_WINDOW_MS - 1000) })];
  assert.deepEqual(await enroll(), { status: 401, body: { error: 'bad_credentials' } });
  assert.deepEqual(await confirm('123456'), { status: 401, body: { error: 'bad_credentials' } });
  assert.equal(audits.filter((a) => a.action === 'auth.totp_enroll_blocked' && (a.meta as { reason: string }).reason === 'window_expired').length, 2);
  assert.equal(owner().totpSecret, null);
  const r = reset2faData() as Record<string, unknown>;
  assert.ok(r.enrollIssuedAt instanceof Date); assert.equal(r.totpPendingUntil, null); assert.equal(r.totpEnrollFails, 0); assert.equal(r.totpSecret, null);
  apply(owner(), r);
  assert.equal((await enroll()).status, 200);
  assert.equal(enrollWindowOpen({ createdAt: new Date(0), enrollIssuedAt: new Date(), totpPendingUntil: null, totpSecret: null }), true);
  for (const f of ['src/app/api/admin/users/[id]/reset-2fa/route.ts', 'src/app/api/admin/account/2fa/reset/route.ts'])
    assert.match(readFileSync(f, 'utf8'), /data: \{ \.\.\.reset2faData\(now\), \.\.\.t\.data(, failedLogins: 0, lockedUntil: null)? \}/, f);
});

test('per-IP limit on both routes (separate bucket), checked after same-origin and before body validation', async () => {
  for (const [path, R] of [['/api/auth-admin/enroll', () => enrollR], ['/api/auth-admin/enroll/confirm', () => confirmR]] as const) {
    setRateLimitStore(new MemoryStore());
    const ip = '203.0.113.9';
    assert.equal((await R().POST(post(path, {}, ip, null))).status, 403, 'origin first');
    for (let i = 0; i < ENROLL_IP_LIMIT; i++) assert.equal((await R().POST(post(path, { bad: 1 }, ip))).status, 400);
    const r = await R().POST(post(path, { bad: 1 }, ip));
    assert.equal(r.status, 429); assert.deepEqual(await r.json(), { error: 'rate_limited' });
    assert.equal((await R().POST(post(path, { bad: 1 }, '203.0.113.10'))).status, 400, 'other IPs unaffected');
  }
  for (const f of ['src/app/api/auth-admin/enroll/route.ts', 'src/app/api/auth-admin/enroll/confirm/route.ts']) {
    const s = readFileSync(f, 'utf8');
    const order = ['assertSameOrigin(req)', 'enrollIpRateOk(', 'Body.safeParse', 'checkPassword('].map((k) => s.indexOf(k));
    assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), `${f}: ${order}`);
  }
});

test('all error codes stay within the known set (enroll_reset is the only new one)', async () => {
  const seen = new Set<string>();
  const s = secretOf((await enroll()).body.otpauthUri);
  for (let i = 0; i < ENROLL_MAX_BAD_TOTP + 1; i++) seen.add(String((await confirm(wrongCode(s))).body.error));
  seen.add(String((await enroll()).body.error));
  seen.add(String((await enroll({ email: EMAIL, password: 'x' })).body.error));
  for (const c of seen) assert.ok(KNOWN_CODES.has(c), c);
  assert.ok(seen.has('enroll_reset'));
});

test('review-only SQL is exactly the additive migrate diff and passes deploy/plan-check.sh', async () => {
  const { execFileSync } = await import('node:child_process');
  const f = 'prisma/sql/2fa-enroll-hardening.sql';
  const sql = readFileSync(f, 'utf8');
  assert.match(sql, /review-only/);
  const stmts = sql.split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean).join(' ');
  assert.equal(stmts.replace(/\s+/g, ' '), 'ALTER TABLE "User" ADD COLUMN "enrollIssuedAt" TIMESTAMP(3), ADD COLUMN "totpEnrollFails" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "totpPendingUntil" TIMESTAMP(3);');
  const out = execFileSync('bash', ['-c', '. deploy/plan-check.sh; plan_problems "$1"', '_', f], { encoding: 'utf8' });
  assert.equal(out.trim(), '', out);
});
