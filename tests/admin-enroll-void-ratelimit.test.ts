import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { authenticator } from 'otplib';
import { setRateLimitStore, MemoryStore } from '../src/lib/server/ratelimit/index';
import { hashSecret } from '../src/lib/server/admin/crypto';
import type * as Login from '../src/lib/server/admin/login';
import type * as Guard from '../src/lib/server/admin/enroll-guard';

// P2「enroll 作废状态到不了」（全栈方案）：登录桶只统计密码错，进来先只读检查；密码对、码错只计入作废计数和 enroll-confirm 桶。
// 真实限流（内存存储）+ 内存版 prisma，不连任何数据库。
const PASSWORD = 'correct-horse-battery-staple';
const EMAIL = 'owner@example.test';
const EDGE = 'e'.repeat(40);
Object.assign(process.env, { APP_ENV: 'test', ADMIN_TOTP_KEY: Buffer.alloc(32, 7).toString('base64'), EDGE_AUTH_SECRET: EDGE });
delete process.env.ADMIN_ALERT_EMAIL; delete process.env.INQUIRY_NOTIFY_EMAIL;

type Row = Record<string, unknown> & { id: string; email: string };
let users: Row[] = [];
let audits: { actorId: string | null; action: string; target: string | null; meta?: unknown; ip: string }[] = [];
let lookups = 0; // prisma.user.findUnique 次数：429 时不能查用户（也就不会验密码）
const match = (u: Row, where: Record<string, unknown>): boolean => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => match(u, w));
  if (v === null) return u[k] === null || u[k] === undefined;
  if (v instanceof Date) return (u[k] as Date)?.getTime() === v.getTime();
  if (typeof v === 'object') {
    const c = v as { lt?: number | Date; lte?: number | Date };
    const x = u[k] as number | Date | null; if (x === null || x === undefined) return false;
    if (c.lt !== undefined && !(+x < +c.lt)) return false;
    if (c.lte !== undefined && !(+x <= +c.lte)) return false;
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
    findUnique: async ({ where }: { where: { email?: string; id?: string } }) => { lookups++; const u = users.find((x) => (where.email ? x.email === where.email : x.id === where.id)); return u ? copy(u) : null; },
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
  enrollIssuedAt: null, totpPendingUntil: null, totpEnrollFails: 0, createdAt: new Date(), ...over,
});
const owner = () => users.find((u) => u.id === 'u_owner')!;

type H = (req: Request) => Promise<Response>;
let enrollR: { POST: H }; let confirmR: { POST: H };
let checkPassword: typeof Login.checkPassword, authorizeLogin: typeof Login.authorizeLogin, loginRateOk: typeof Login.loginRateOk;
let ENROLL_MAX_BAD_TOTP: number, ENROLL_CONFIRM_LIMIT: number;
let hitEnrollConfirmRate: typeof Guard.hitEnrollConfirmRate;
before(async () => {
  hash = await hashSecret(PASSWORD);
  ({ checkPassword, authorizeLogin, loginRateOk } = await import('../src/lib/server/admin/login'));
  ({ ENROLL_MAX_BAD_TOTP, ENROLL_CONFIRM_LIMIT, hitEnrollConfirmRate } = await import('../src/lib/server/admin/enroll-guard'));
  enrollR = await import('../src/app/api/auth-admin/enroll/route');
  confirmR = await import('../src/app/api/auth-admin/enroll/confirm/route');
});
beforeEach(() => { setRateLimitStore(new MemoryStore()); users = [newUser()]; audits = []; lookups = 0; });

const IP = '198.51.100.77'; // 这里都用同一个 IP：UX 复现的就是同 IP 下第 5 次先撞上 429
const post = (path: string, body: unknown, ip = IP) => new Request(`http://localhost${path}`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'x-edge-auth': EDGE, 'cf-connecting-ip': ip, origin: 'http://localhost' },
});
const call = async (r: Promise<Response>) => { const res = await r; return { status: res.status, body: await res.json() as Record<string, unknown> }; };
const enroll = (password = PASSWORD) => call(enrollR.POST(post('/api/auth-admin/enroll', { email: EMAIL, password })));
const confirm = (totp: string, password = PASSWORD) => call(confirmR.POST(post('/api/auth-admin/enroll/confirm', { email: EMAIL, password, totp })));
const secretOf = (uri: unknown) => new URL(String(uri)).searchParams.get('secret')!;
const wrongCode = (secret: string) => { for (let i = 0; ; i++) { const c = String(i).padStart(6, '0'); if (authenticator.checkDelta(c, secret) === null) return c; } };
const RL = { status: 429, body: { error: 'rate_limited' } };
const BAD = { status: 401, body: { error: 'bad_credentials' } };
async function quiet<T>(f: () => Promise<T>) { const e = console.error; console.error = () => {}; try { return await f(); } finally { console.error = e; } }

test('1. correct password + wrong TOTP ×5 from the same IP → 1-4 bad_totp, 5th enroll_reset (not 429)', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  for (let i = 1; i < ENROLL_MAX_BAD_TOTP; i++) assert.deepEqual(await confirm(wrongCode(secret)), { status: 401, body: { error: 'bad_totp' } }, `attempt ${i}`);
  assert.deepEqual(await confirm(wrongCode(secret)), { status: 401, body: { error: 'enroll_reset' } });
  assert.equal(owner().totpSecret, null);
  assert.equal(await loginRateOk(IP, EMAIL), true, 'login buckets untouched by password-correct attempts');
});

test('2. wrong password ×5 → 6th is 429 and the password is not verified (no user lookup)', async () => {
  await quiet(async () => {
    await enroll();
    for (let i = 0; i < 5; i++) assert.deepEqual(await confirm('123456', 'wrong-' + i), BAD, `attempt ${i + 1}`);
    const before = lookups;
    const auditsBefore = audits.filter((a) => a.action === 'auth.login_fail' && (a.meta as { reason: string }).reason !== 'rate_limited').length;
    assert.deepEqual(await confirm('123456', PASSWORD), RL, '6th is 429 even with the right password');
    assert.equal(lookups, before, 'no user lookup on 429 → password not verified');
    assert.equal(audits.filter((a) => a.action === 'auth.login_fail' && (a.meta as { reason: string }).reason !== 'rate_limited').length, auditsBefore);
    assert.ok(audits.some((a) => a.action === 'auth.login_fail' && (a.meta as { reason: string }).reason === 'rate_limited'));
    assert.equal(owner().totpEnrollFails, 0);
  });
});

test('3. after void, old secret + a correct code does not enable 2FA', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  for (let i = 0; i < ENROLL_MAX_BAD_TOTP; i++) await confirm(wrongCode(secret));
  assert.equal(owner().totpSecret, null);
  assert.deepEqual(await confirm(authenticator.generate(secret)), { status: 401, body: { error: 'enroll_reset' } });
  assert.equal(owner().totpEnabled, false);
});

test('4. mixed: 2 wrong passwords + 3 wrong TOTP → no early 429, void counter is 3 and the secret survives', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  const enc = owner().totpSecret;
  for (const step of ['pw', 'totp', 'pw', 'totp', 'totp']) {
    const r = step === 'pw' ? await confirm(wrongCode(secret), 'wrong-password') : await confirm(wrongCode(secret));
    assert.deepEqual(r, step === 'pw' ? BAD : { status: 401, body: { error: 'bad_totp' } }, step);
  }
  assert.equal(owner().totpEnrollFails, 3, 'password errors do not increment the void counter');
  assert.equal(owner().totpSecret, enc);
  assert.equal((await confirm(authenticator.generate(secret))).status, 200, 'owner can still finish');
});

test('5. login and confirm share the login bucket: alternating wrong passwords, combined 6th attempt → 429', async () => {
  await quiet(async () => {
    await enroll();
    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) assert.equal(await authorizeLogin({ email: EMAIL, password: 'wrong-' + i, totp: '123456' }, IP), null);
      else assert.deepEqual(await confirm('123456', 'wrong-' + i), BAD);
    }
    assert.deepEqual(await confirm('123456', 'wrong-6'), RL, 'confirm is the 6th');
    assert.equal(await checkPassword(EMAIL, 'wrong-7', IP), 'rate_limited', 'login side is limited too');
  });
});

test('6. correct-password checks do not consume the login buckets', async () => {
  for (let i = 0; i < 12; i++) assert.equal(typeof (await checkPassword(EMAIL, PASSWORD, IP)), 'object', `check ${i + 1}`);
  // 桶还是空的：接下来 5 次密码错都是 bad_credentials，第 6 次才 429
  await quiet(async () => {
    for (let i = 0; i < 5; i++) assert.equal(await checkPassword(EMAIL, 'wrong', IP), 'bad_credentials', `wrong ${i + 1}`);
    assert.equal(await checkPassword(EMAIL, 'wrong', IP), 'rate_limited');
  });
});

test('unknown account: wrong passwords still count (and still burn a verify)', async () => {
  for (let i = 0; i < 5; i++) assert.equal(await checkPassword('nobody@example.test', 'x', IP), 'bad_credentials');
  assert.equal(await checkPassword('nobody@example.test', 'x', IP), 'rate_limited');
});

test('login with correct password but wrong second factor still consumes the login bucket (unchanged)', async () => {
  users = [newUser({ totpEnabled: true, totpSecret: null })]; // 没有可用密钥 → 第二因素必错
  await quiet(async () => {
    for (let i = 0; i < 5; i++) assert.equal(await authorizeLogin({ email: EMAIL, password: PASSWORD, totp: '123456' }, IP), null);
    assert.equal(await loginRateOk(IP, EMAIL), false);
  });
});

test('enroll-confirm bucket (IP+account): full → 429 before password verify; only password-correct TOTP errors count', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  await confirm(wrongCode(secret));
  await confirm(wrongCode(secret), 'wrong-password');
  // 再直接计 LIMIT-2 次（真实场景是跨多次重新 enroll 的错码）：如果密码错也计数，这里就已经满了
  for (let i = 2; i < ENROLL_CONFIRM_LIMIT; i++) await hitEnrollConfirmRate(IP, EMAIL);
  assert.deepEqual(await confirm(wrongCode(secret)), { status: 401, body: { error: 'bad_totp' } }, 'password error was not counted in this bucket');
  const before = lookups;
  assert.deepEqual(await confirm(authenticator.generate(secret)), RL);
  assert.equal(lookups, before, 'no user lookup');
  assert.equal(owner().totpEnabled, false);
  // 别的 IP 不受影响
  assert.equal((await call(confirmR.POST(post('/api/auth-admin/enroll/confirm', { email: EMAIL, password: PASSWORD, totp: authenticator.generate(secret) }, '198.51.100.78')))).status, 200);
});
