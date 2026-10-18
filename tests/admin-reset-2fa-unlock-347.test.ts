import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { authenticator } from 'otplib';
import * as authStub from './fixtures/auth-stub';
import { setRateLimitStore, MemoryStore, UpstashStore, type RateLimitStore } from '../src/lib/server/ratelimit/index';
import { hashSecret } from '../src/lib/server/admin/crypto';
import { rateLimitEnv } from '../src/lib/server/security';
import type * as ARL from '../src/lib/server/admin/account-rate-limits';
import { RESET_2FA_CONFIRM } from '../src/lib/admin/enroll';
import * as ResetLib from '../scripts/admin-reset-initial-password-lib.mjs';

// #347：后台「重置 2FA」同时解除锁定。真实路由（reset-2fa、enroll、confirm）；'@/auth' 换成测试桩，prisma 换成内存对象，不连数据库。
const authFile = path.resolve('src/auth.ts');
const am = new Module(authFile); am.filename = authFile; am.loaded = true; am.exports = authStub;
(createRequire(authFile).cache as Record<string, unknown>)[authFile] = am;

const PASSWORD = 'correct-horse-battery-staple';
const EMAIL = 'locked@example.test';
const EDGE = 'e'.repeat(40);
Object.assign(process.env, { APP_ENV: 'test', NEXT_PUBLIC_SITE_URL: 'http://localhost:3100', ADMIN_TOTP_KEY: Buffer.alloc(32, 7).toString('base64'), EDGE_AUTH_SECRET: EDGE });
delete process.env.ADMIN_ALERT_EMAIL; delete process.env.INQUIRY_NOTIFY_EMAIL; delete process.env.RATE_LIMIT_STORE;

type Row = Record<string, unknown> & { id: string; email: string };
let users: Row[] = [];
let audits: { actorId: string | null; action: string; target: string | null; meta?: unknown; ip: string }[] = [];
const match = (u: Row, where: Record<string, unknown>): boolean => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => match(u, w));
  if (v === null) return u[k] === null || u[k] === undefined;
  if (v instanceof Date) return (u[k] as Date)?.getTime() === v.getTime();
  if (typeof v === 'object') {
    const c = v as { lte?: number | Date; gt?: number | Date };
    const x = u[k] as number | Date | null; if (x === null || x === undefined) return false;
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
let failUpdate = false;
const userApi = {
  findUnique: async ({ where }: { where: { email?: string; id?: string } }) => { const u = users.find((x) => (where.email ? x.email === where.email : x.id === where.id)); return u ? { ...u } : null; },
  update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { if (failUpdate) throw new Error('db down'); const u = users.find((x) => x.id === where.id)!; apply(u, data); return { ...u }; },
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { const hit = users.filter((u) => match(u, where)); hit.forEach((u) => apply(u, data)); return { count: hit.length }; },
};
const db = {
  user: userApi,
  auditLog: { create: async ({ data }: { data: (typeof audits)[number] }) => { audits.push(data); return {}; } },
  $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
    const snap = structuredClone(users);
    try { return await fn({ user: userApi, $executeRaw: async () => 0, $queryRaw: async () => users.filter((u) => u.role === 'ADMIN' && !u.disabled).map((u) => ({ id: u.id })) }); }
    catch (e) { users = snap; throw e; }
  },
};
const g = globalThis as { prisma?: unknown; __testSession?: unknown };
g.prisma = db;

let hash = '';
const admin = (id: string, role = 'ADMIN'): Row => ({
  id, email: `${id}@example.test`, name: id, passwordHash: 'x', role, totpSecret: 'x', totpEnabled: true, totpLastStep: null, recoveryCodes: [], sessionVersion: 1,
  disabled: false, failedLogins: 0, lockedUntil: null, lastLoginAt: null, reactivatedAt: null, enrollIssuedAt: null, totpPendingUntil: null, totpEnrollFails: 0,
  enrollTokenHash: null, enrollTokenExpiresAt: null, createdAt: new Date(),
});
const target = (): Row => ({
  ...admin('ulocked00000000000000000'), email: EMAIL, passwordHash: hash, failedLogins: 5, lockedUntil: new Date(Date.now() + 10 * 60_000), sessionVersion: 7,
  enrollTokenHash: 'f'.repeat(64), enrollTokenExpiresAt: new Date(Date.now() + 3_600_000), // 旧令牌（假值）
});
const row = (id: string) => users.find((u) => u.id === id)!;

type H = (req: Request, ctx?: unknown) => Promise<Response>;
let accountRateKeys: typeof ARL.accountRateKeys;
let resetR: { POST: H }; let enrollR: { POST: H }; let confirmR: { POST: H };
before(async () => {
  hash = await hashSecret(PASSWORD);
  ({ accountRateKeys } = await import('../src/lib/server/admin/account-rate-limits'));
  resetR = await import('../src/app/api/admin/users/[id]/reset-2fa/route') as never;
  enrollR = await import('../src/app/api/auth-admin/enroll/route') as never;
  confirmR = await import('../src/app/api/auth-admin/enroll/confirm/route') as never;
});

/** MemoryStore + 记录 clear 调用 */
class SpyStore extends MemoryStore {
  cleared: { key: string; windowMs: number }[][] = [];
  failClear = false;
  async clear(entries: { key: string; windowMs: number }[]) { this.cleared.push(entries); if (this.failClear) throw new Error('upstash 503'); return super.clear(entries); }
}
let store: SpyStore;
let warns: string[] = [];
const realWarn = console.warn;
beforeEach(() => {
  users = [admin('aone0000000000000000000000'), admin('atwo0000000000000000000000'), admin('sone0000000000000000000000', 'SALES'), target()]; audits = []; failUpdate = false;
  store = new SpyStore(); setRateLimitStore(store);
  g.__testSession = { user: { id: 'aone0000000000000000000000' }, sv: 1 };
  warns = []; console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
});
afterEach(() => { console.warn = realWarn; });

const P = (id: string) => ({ params: Promise.resolve({ id }) });
const resetReq = (origin: string | null = 'http://localhost') =>
  new Request('http://localhost/api/admin/users/ulocked00000000000000000/reset-2fa', { method: 'POST', headers: { ...(origin ? { origin } : {}) } });
let ipN = 0;
const authPost = (p: string, body: unknown) => new Request(`http://localhost${p}`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'x-edge-auth': EDGE, 'cf-connecting-ip': `203.0.113.${(++ipN % 250) + 1}`, origin: 'http://localhost' },
});
const tokenOf = (link: string) => new URLSearchParams(new URL(link).hash.slice(1)).get('t')!;
const E = rateLimitEnv();
const LOGIN_IP = `${E}:login-ip:untrusted`;

test('locked account (failedLogins=5, lockedUntil in future): admin Reset 2FA unlocks in the same write; new link completes enroll + confirm', async () => {
  // 先把账号的 3 个限流 key 和 login-ip 打满（limit 1：再 hit 一次就超限）
  for (const { key, windowMs } of accountRateKeys(EMAIL)) await store.hit(`${E}:${key}`, 1, windowMs);
  await store.hit(LOGIN_IP, 1, 600_000);

  const before = { ...row('ulocked00000000000000000') };
  const res = await resetR.POST(resetReq(), P('ulocked00000000000000000'));
  assert.equal(res.status, 200);
  const body = await res.json() as { enrollLink: string; locked: boolean };
  assert.equal(body.locked, false);
  const u = row('ulocked00000000000000000');
  assert.equal(u.failedLogins, 0); assert.equal(u.lockedUntil, null);
  assert.equal(u.sessionVersion, (before.sessionVersion as number) + 1);
  assert.notEqual(u.enrollTokenHash, before.enrollTokenHash, 'old token voided');
  assert.equal(u.totpEnabled, false);

  const r2fa = audits.filter((a) => a.action === 'user.reset_2fa');
  assert.deepEqual(r2fa.map((a) => [a.actorId, a.target, a.meta]), [['aone0000000000000000000000', 'ulocked00000000000000000', { unlocked: true }]]);
  assert.deepEqual(audits.find((a) => a.action === 'auth.enroll_token_issued')?.meta, { source: 'admin_reset_2fa', truncated: false });

  // 提交之后删掉账号的 3 个 key（当前 + 上一个窗口由存储负责），login-ip 不碰
  assert.equal(store.cleared.length, 1);
  assert.deepEqual(store.cleared[0].map((e) => e.key), accountRateKeys(EMAIL).map((k) => `${E}:${k.key}`));
  assert.ok(!store.cleared.flat().some((e) => e.key.includes('login-ip')));
  for (const { key, windowMs } of accountRateKeys(EMAIL)) assert.equal(await store.hit(`${E}:${key}`, 1, windowMs), true, `${key} cleared`);
  assert.equal(await store.hit(LOGIN_IP, 1, 600_000), false, 'login-ip untouched');
  setRateLimitStore(store = new SpyStore()); // 上面为了验证又 hit 了一次，换个干净的存储再走绑定
  assert.deepEqual(warns, []);

  const token = tokenOf(body.enrollLink);
  const e = await enrollR.POST(authPost('/api/auth-admin/enroll', { email: EMAIL, password: PASSWORD, token }));
  assert.equal(e.status, 200);
  const secret = new URL(String((await e.json()).otpauthUri)).searchParams.get('secret')!;
  const c = await confirmR.POST(authPost('/api/auth-admin/enroll/confirm', { email: EMAIL, password: PASSWORD, token, totp: authenticator.generate(secret) }));
  assert.equal(c.status, 200);
  assert.equal(((await c.json()).recoveryCodes as string[]).length, 10);
  assert.equal(row('ulocked00000000000000000').totpEnabled, true); assert.equal(row('ulocked00000000000000000').enrollTokenHash, null);
  assert.ok(!JSON.stringify(audits).includes(token), 'token never in audit');
});

test('unlocked=false when the account had no lockout state; unlocked=true for failedLogins>0 alone or an expired lock with failures', async () => {
  apply(row('ulocked00000000000000000'), { failedLogins: 0, lockedUntil: null });
  assert.equal((await resetR.POST(resetReq(), P('ulocked00000000000000000'))).status, 200);
  apply(row('ulocked00000000000000000'), { failedLogins: 2, lockedUntil: null });
  assert.equal((await resetR.POST(resetReq(), P('ulocked00000000000000000'))).status, 200);
  apply(row('ulocked00000000000000000'), { failedLogins: 0, lockedUntil: new Date(Date.now() - 1000) }); // 锁定已过期、没有失败次数：没有可清的
  assert.equal((await resetR.POST(resetReq(), P('ulocked00000000000000000'))).status, 200);
  assert.deepEqual(audits.filter((a) => a.action === 'user.reset_2fa').map((a) => a.meta), [{ unlocked: false }, { unlocked: true }, { unlocked: false }]);
  assert.equal(row('ulocked00000000000000000').lockedUntil, null);
});

test('rate-limit DEL failure after commit: reset still succeeds (200, unlocked, link returned); only rate_limit=failed is logged', async () => {
  store.failClear = true;
  const res = await resetR.POST(resetReq(), P('ulocked00000000000000000'));
  assert.equal(res.status, 200);
  const body = await res.json() as { enrollLink: string };
  assert.match(body.enrollLink, /^http:\/\/localhost:3100\/admin-enroll#t=[A-Za-z0-9_-]{43}$/);
  assert.equal(row('ulocked00000000000000000').failedLogins, 0); assert.equal(row('ulocked00000000000000000').lockedUntil, null);
  assert.equal(store.cleared.length, 1);
  assert.deepEqual(warns, ['[admin] users.reset_2fa target=ulocked00000000000000000 rate_limit=failed']);
  assert.ok(!warns.join().includes(EMAIL) && !warns.join().includes(tokenOf(body.enrollLink)));
  // 存储不支持 clear（测试替身等）同样只记 failed
  const bare: RateLimitStore = { hit: async () => true, refund: async () => {} };
  setRateLimitStore(bare); warns = [];
  assert.equal((await resetR.POST(resetReq(), P('ulocked00000000000000000'))).status, 200);
  assert.deepEqual(warns, ['[admin] users.reset_2fa target=ulocked00000000000000000 rate_limit=failed']);
});

test('DB write failure: nothing is unlocked and no keys are deleted', async () => {
  failUpdate = true;
  await assert.rejects(resetR.POST(resetReq(), P('ulocked00000000000000000')));
  assert.equal(row('ulocked00000000000000000').failedLogins, 5); assert.ok(row('ulocked00000000000000000').lockedUntil);
  assert.equal(store.cleared.length, 0);
  assert.equal(audits.filter((a) => a.action === 'user.reset_2fa').length, 0);
});

test('auth unchanged: non-admin 403, signed-out 401, cross-origin 403, self 409 — nothing unlocked, no keys deleted', async () => {
  for (const [sess, origin, status] of [[{ user: { id: 'sone0000000000000000000000' }, sv: 1 }, 'http://localhost', 403], [null, 'http://localhost', 401], [{ user: { id: 'aone0000000000000000000000' }, sv: 1 }, 'https://evil.example', 403], [{ user: { id: 'aone0000000000000000000000' }, sv: 1 }, null, 403]] as const) {
    g.__testSession = sess;
    assert.equal((await resetR.POST(resetReq(origin), P('ulocked00000000000000000'))).status, status, JSON.stringify([sess, origin]));
  }
  g.__testSession = { user: { id: 'ulocked00000000000000000' }, sv: 7 }; // 被锁定的账号自己的会话也进不来
  assert.equal((await resetR.POST(resetReq(), P('ulocked00000000000000000'))).status, 401);
  g.__testSession = { user: { id: 'aone0000000000000000000000' }, sv: 1 };
  assert.equal((await resetR.POST(new Request('http://localhost/api/admin/users/aone0000000000000000000000/reset-2fa', { method: 'POST', headers: { origin: 'http://localhost' } }), P('aone0000000000000000000000'))).status, 409);
  assert.equal(row('ulocked00000000000000000').failedLogins, 5); assert.ok(row('ulocked00000000000000000').lockedUntil);
  assert.equal(store.cleared.length, 0); assert.equal(audits.filter((a) => a.action === 'user.reset_2fa').length, 0);
  const src = readFileSync('src/app/api/admin/users/[id]/reset-2fa/route.ts', 'utf8');
  const order = ["requireAdmin(req, ['ADMIN'])", 'assertSameOrigin(req)', "enforceAdminRateLimit(req, 'users.reset_2fa', 10)", 'mutateUser(', 'clearAccountRateLimits('].map((s) => src.indexOf(s));
  assert.ok(order.every((x, n) => x >= 0 && (n === 0 || x > order[n - 1])), String(order));
});

test('account keys = reset script keys; Upstash clear sends exactly the 6 DELs the reset script computes (current + previous window), no login-ip', async () => {
  const env = { ...process.env } as Record<string, string | undefined>;
  assert.deepEqual(accountRateKeys(EMAIL), ResetLib.accountOnlyRateKeys(EMAIL, env));
  const calls: string[][][] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: { body: string }) => { const cmds = JSON.parse(init.body) as string[][]; calls.push(cmds); return new Response(JSON.stringify(cmds.map(() => ({ result: 1 })))); }) as never;
  try {
    const up = new UpstashStore('https://upstash.example', 'tok');
    setRateLimitStore(up);
    const now = Date.now();
    assert.equal((await resetR.POST(resetReq(), P('ulocked00000000000000000'))).status, 200);
    const dels = calls.find((c) => c.every((x) => x[0] === 'DEL'))!;
    assert.equal(dels.length, 6);
    assert.deepEqual(new Set(dels.map((d) => d[1])), new Set(ResetLib.rateKeysToDelete(EMAIL, env, now)));
    assert.ok(!dels.some((d) => d[1].includes('login-ip')));
  } finally { globalThis.fetch = realFetch; }
});

test('admin UI: Reset 2FA confirm copy has both sentences; link panel only in component state', () => {
  const c = RESET_2FA_CONFIRM('x@example.test');
  assert.ok(c.includes('之前发出的绑定链接会立即失效'));
  assert.ok(c.includes('同时会解除这个账号的登录锁定'));
  const ui = readFileSync('src/components/admin/users/UsersAdmin.tsx', 'utf8');
  assert.match(ui, /confirm\(RESET_2FA_CONFIRM\(u\.email\)\)/);
  assert.match(ui, /`\/\$\{u\.id\}\/reset-2fa`, \{ method: 'POST' \}/);
  assert.ok(!/localStorage|sessionStorage|console\.|history\./.test(ui));
});
