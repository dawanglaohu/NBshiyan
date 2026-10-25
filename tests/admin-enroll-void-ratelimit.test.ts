import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authenticator } from 'otplib';
import { setRateLimitStore, MemoryStore, type RateLimitStore } from '../src/lib/server/ratelimit/index';
import { hashSecret } from '../src/lib/server/admin/crypto';
import type * as Login from '../src/lib/server/admin/login';
import type * as Sec from '../src/lib/server/security';

// P2「enroll 作废状态到不了」（全栈方案）：登录桶照常原子 hit；enroll 两个接口密码正确后退回 IP+账号、单账号两个桶（单 IP 桶、enrollIpRateOk 不退）。
// confirm 里密码对、码错只计入作废计数和 enroll-confirm 桶。真实限流（内存存储）+ 内存版 prisma，不连任何数据库。
const PASSWORD = 'correct-horse-battery-staple';
const EMAIL = 'owner@example.test';
const EDGE = 'e'.repeat(40);
// #347 方案 A：测试用的一次性绑定令牌（假值，43 字符 base64url）；库里只放它的 sha256。post() 默认把它放进请求体
const TOKEN = 'T'.repeat(43);
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
Object.assign(process.env, { APP_ENV: 'test', ADMIN_TOTP_KEY: Buffer.alloc(32, 7).toString('base64'), EDGE_AUTH_SECRET: EDGE });
delete process.env.ADMIN_ALERT_EMAIL; delete process.env.INQUIRY_NOTIFY_EMAIL;

type Row = Record<string, unknown> & { id: string; email: string };
let users: Row[] = [];
let audits: { actorId: string | null; action: string; target: string | null; meta?: unknown; ip: string }[] = [];
let lookups = 0; // prisma.user.findUnique 次数：只有查到用户之后才会验密码，所以它也是「到达密码校验」的次数
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
    findUnique: async ({ where }: { where: { email?: string; id?: string } }) => { lookups++; const u = users.find((x) => (where.email ? x.email === where.email : x.id === where.id)); return u ? copy(u) : null; },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const u = users.find((x) => x.id === where.id)!; apply(u, data); return copy(u); },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = users.filter((u) => match(u, where)); hit.forEach((u) => apply(u, data)); return { count: hit.length };
    },
  },
  auditLog: { create: async ({ data }: { data: (typeof audits)[number] }) => { audits.push(data); return {}; } },
};
(globalThis as { prisma?: unknown }).prisma = db;

/** 真的 MemoryStore 外面包一层，记录每个 key 的净计数和 refund 调用；refundFails 时 refund 抛错 */
class CountingStore implements RateLimitStore {
  m = new MemoryStore(); n = new Map<string, number>(); refunds: string[] = []; refundFails = false;
  async hit(k: string, l: number, w: number) { this.n.set(k, (this.n.get(k) ?? 0) + 1); return this.m.hit(k, l, w); }
  async refund(k: string, w: number) {
    this.refunds.push(k);
    if (this.refundFails) throw new Error(`down ${k}`);
    await this.m.refund(k, w); this.n.set(k, Math.max(0, (this.n.get(k) ?? 0) - 1));
  }
  count(k: string) { return this.n.get(k) ?? 0; }
}

let hash = '';
const newUser = (over: Partial<Row> = {}): Row => ({
  id: 'u_owner', email: EMAIL, name: 'Owner', passwordHash: hash, role: 'SALES', totpSecret: null, totpEnabled: false, totpLastStep: null,
  recoveryCodes: [], sessionVersion: 0, disabled: false, failedLogins: 0, lockedUntil: null, lastLoginAt: null, reactivatedAt: null,
  enrollIssuedAt: null, totpPendingUntil: null, totpEnrollFails: 0,
  enrollTokenHash: TOKEN_HASH, enrollTokenExpiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), ...over,
});
const owner = () => users.find((u) => u.id === 'u_owner')!;

const IP = '198.51.100.77'; // 都用同一个 IP：UX 复现的就是同 IP 下第 5 次先撞上 429
type H = (req: Request) => Promise<Response>;
let enrollR: { POST: H }; let confirmR: { POST: H };
let authorizeLogin: typeof Login.authorizeLogin;
let ENROLL_MAX_BAD_TOTP: number, ENROLL_CONFIRM_LIMIT: number;
let K: { ipAcct: string; acct: string; ip: string; enrollIp: string; confirmIp: string; enrollConfirm: string };
let store: CountingStore;
before(async () => {
  hash = await hashSecret(PASSWORD);
  ({ authorizeLogin } = await import('../src/lib/server/admin/login'));
  ({ ENROLL_MAX_BAD_TOTP, ENROLL_CONFIRM_LIMIT } = await import('../src/lib/server/admin/enroll-guard'));
  const sec: typeof Sec = await import('../src/lib/server/security');
  const env = sec.rateLimitEnv(), e = sec.rateLimitKeyHash(EMAIL);
  K = {
    ipAcct: `${env}:login:${IP}:${e}`, acct: `${env}:login-acct:${e}`, ip: `${env}:login-ip:${IP}`,
    enrollIp: `${env}:enroll-ip:enroll:${IP}`, confirmIp: `${env}:enroll-ip:confirm:${IP}`, enrollConfirm: `${env}:enroll-confirm:${IP}:${e}`,
  };
  enrollR = await import('../src/app/api/auth-admin/enroll/route');
  confirmR = await import('../src/app/api/auth-admin/enroll/confirm/route');
});
beforeEach(() => { store = new CountingStore(); setRateLimitStore(store); users = [newUser()]; audits = []; lookups = 0; });

/** 对象请求体默认带上 TOKEN；显式写了 token 键（包括 undefined）的保持原样 */
const withToken = (body: unknown) => (body && typeof body === 'object' && !Array.isArray(body) && !('token' in body) ? { ...body, token: TOKEN } : body);
const post = (path: string, body: unknown, ip = IP) => new Request(`http://localhost${path}`, {
  method: 'POST', body: JSON.stringify(withToken(body)),
  headers: { 'content-type': 'application/json', 'x-edge-auth': EDGE, 'cf-connecting-ip': ip, origin: 'http://localhost' },
});
const call = async (r: Promise<Response>) => { const res = await r; return { status: res.status, body: await res.json() as Record<string, unknown> }; };
const enroll = (password = PASSWORD) => call(enrollR.POST(post('/api/auth-admin/enroll', { email: EMAIL, password })));
const confirm = (totp: string, password = PASSWORD) => call(confirmR.POST(post('/api/auth-admin/enroll/confirm', { email: EMAIL, password, totp })));
const secretOf = (uri: unknown) => new URL(String(uri)).searchParams.get('secret')!;
const wrongCode = (secret: string) => { for (let i = 0; ; i++) { const c = String(i).padStart(6, '0'); if (authenticator.checkDelta(c, secret) === null) return c; } };
const RL = { status: 429, body: { error: 'rate_limited' } };
const BAD = { status: 401, body: { error: 'bad_credentials' } };
const BAD_TOTP = { status: 401, body: { error: 'bad_totp' } };
async function quiet<T>(f: () => Promise<T>) { const e = console.error; console.error = () => {}; try { return await f(); } finally { console.error = e; } }

test('(a) right password + wrong TOTP ×5 from one IP → 1-4 bad_totp, 5th enroll_reset; login IP+account buckets back to 0', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  for (let i = 1; i < ENROLL_MAX_BAD_TOTP; i++) assert.deepEqual(await confirm(wrongCode(secret)), BAD_TOTP, `attempt ${i}`);
  assert.deepEqual(await confirm(wrongCode(secret)), { status: 401, body: { error: 'enroll_reset' } });
  assert.equal(owner().totpSecret, null);
  assert.equal(store.count(K.ipAcct), 0); assert.equal(store.count(K.acct), 0);
  assert.equal(store.count(K.enrollConfirm), ENROLL_MAX_BAD_TOTP, 'each password-correct TOTP check counted once');
});

test('enroll step 1: right password refunds the two login buckets; wrong password keeps its count', async () => {
  assert.equal((await enroll()).status, 200);
  assert.equal(store.count(K.ipAcct), 0); assert.equal(store.count(K.acct), 0);
  assert.equal(store.count(K.ip), 1, 'login-ip not refunded'); assert.equal(store.count(K.enrollIp), 1, 'enrollIpRateOk not refunded');
  assert.deepEqual(await enroll('wrong'), BAD);
  assert.equal(store.count(K.ipAcct), 1); assert.equal(store.count(K.acct), 1);
  // 还在 pending（429 rate_limited）也是密码正确之后：照样退回
  assert.deepEqual(await enroll(), RL);
  assert.equal(store.count(K.ipAcct), 1); assert.equal(store.count(K.acct), 1);
});

test('(b) 5 wrong passwords at confirm → 6th is 429 with no user lookup (password not verified)', async () => {
  await quiet(async () => {
    await enroll();
    for (let i = 0; i < 5; i++) assert.deepEqual(await confirm('123456', 'wrong-' + i), BAD, `attempt ${i + 1}`);
    const before = lookups;
    assert.deepEqual(await confirm('123456', PASSWORD), { status: 429, body: { error: 'rate_limited', retryAfter: 600 } }, '6th is 429 even with the right password');
    const limited = await confirmR.POST(post('/api/auth-admin/enroll/confirm', { email: EMAIL, password: PASSWORD, totp: '123456' }));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '600');
    assert.match(limited.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(lookups, before, 'no user lookup on 429');
    assert.ok(audits.some((a) => a.action === 'auth.login_fail' && (a.meta as { reason: string }).reason === 'rate_limited'));
    assert.equal(owner().totpEnrollFails, 0);
  });
});

test('(c) after void, old secret + a correct code does not enable 2FA', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  for (let i = 0; i < ENROLL_MAX_BAD_TOTP; i++) await confirm(wrongCode(secret));
  assert.deepEqual(await confirm(authenticator.generate(secret)), { status: 401, body: { error: 'enroll_reset' } });
  assert.equal(owner().totpEnabled, false);
});

test('(d) mixed: 2 wrong passwords + 3 wrong TOTP → no early 429, totpEnrollFails = 3, secret survives', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  const enc = owner().totpSecret;
  for (const step of ['pw', 'totp', 'pw', 'totp', 'totp']) {
    const r = step === 'pw' ? await confirm(wrongCode(secret), 'wrong-password') : await confirm(wrongCode(secret));
    assert.deepEqual(r, step === 'pw' ? BAD : BAD_TOTP, step);
  }
  assert.equal(owner().totpEnrollFails, 3, 'password errors do not increment the void counter');
  assert.equal(owner().totpSecret, enc);
  assert.equal(store.count(K.ipAcct), 2, 'only the 2 wrong passwords stay in the login bucket');
  assert.equal(store.count(K.enrollConfirm), 3);
  assert.equal((await confirm(authenticator.generate(secret))).status, 200, 'owner can still finish');
});

test('(e) login and confirm share the login bucket: alternating wrong passwords, combined 6th → 429', async () => {
  await quiet(async () => {
    await enroll();
    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) assert.equal(await authorizeLogin({ email: EMAIL, password: 'wrong-' + i, totp: '123456' }, IP), null);
      else assert.deepEqual(await confirm('123456', 'wrong-' + i), BAD);
    }
    const before = lookups;
    assert.deepEqual(await confirm('123456', 'wrong-6'), { status: 429, body: { error: 'rate_limited', retryAfter: 600 } }, 'confirm is the 6th');
    assert.equal(await authorizeLogin({ email: EMAIL, password: PASSWORD, totp: '123456' }, IP), null);
    assert.equal(lookups, before, 'neither reached the user lookup');
  });
});

test('login route unchanged: correct-password logins count every time and are never refunded', async () => {
  users = [newUser({ totpEnabled: true, totpSecret: null })];
  await quiet(async () => { for (let i = 0; i < 3; i++) await authorizeLogin({ email: EMAIL, password: PASSWORD, totp: '123456' }, IP); });
  assert.equal(store.count(K.ipAcct), 3); assert.deepEqual(store.refunds, []);
});

test('(f) 6 concurrent wrong-password confirms → at most 5 reach password verification, the rest 429', async () => {
  await quiet(async () => {
    await enroll();
    const before = lookups;
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => confirm('123456', 'wrong-' + i)));
    assert.ok(lookups - before <= 5, `reached verification: ${lookups - before}`);
    assert.equal(lookups - before, 5, 'in-memory hits are atomic: exactly the 5 allowed ones get through');
    assert.equal(rs.filter((r) => r.status === 429).length, 6 - (lookups - before));
    assert.ok(rs.every((r) => r.status === 429 || r.body.error === 'bad_credentials'));
  });
});

test('(g) refund store errors are swallowed: request still answers normally, count stays, nothing logged', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  store.refundFails = true;
  const logs: unknown[] = []; const e = console.error; console.error = (...a: unknown[]) => { logs.push(a); };
  try { assert.deepEqual(await confirm(wrongCode(secret)), BAD_TOTP); } finally { console.error = e; }
  assert.ok(store.refunds.includes(K.ipAcct) && store.refunds.includes(K.acct), 'refund was attempted');
  assert.equal(store.count(K.ipAcct), 1, 'count kept (fail-strict)'); assert.equal(store.count(K.acct), 1);
  assert.deepEqual(logs, []);
  assert.equal(owner().totpEnrollFails, 1);
});

test('(h) login-ip bucket and enrollIpRateOk are never refunded', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  for (let i = 0; i < 3; i++) await confirm(wrongCode(secret));
  assert.equal(store.count(K.ip), 4); assert.equal(store.count(K.enrollIp), 1); assert.equal(store.count(K.confirmIp), 3);
  assert.ok(store.refunds.every((k) => k === K.ipAcct || k === K.acct), store.refunds.join());
});

test('enroll-confirm bucket (IP+account, atomic hit): over the limit → 429 before TOTP verify; other IPs unaffected', async () => {
  const secret = secretOf((await enroll()).body.otpauthUri);
  for (let i = 0; i < ENROLL_CONFIRM_LIMIT; i++) await store.hit(K.enrollConfirm, ENROLL_CONFIRM_LIMIT, 10 * 60_000);
  assert.deepEqual(await confirm(authenticator.generate(secret)), RL);
  assert.equal(owner().totpEnabled, false); assert.equal(owner().totpEnrollFails, 0, 'TOTP not checked');
  assert.equal((await call(confirmR.POST(post('/api/auth-admin/enroll/confirm', { email: EMAIL, password: PASSWORD, totp: authenticator.generate(secret) }, '198.51.100.78')))).status, 200);
});
