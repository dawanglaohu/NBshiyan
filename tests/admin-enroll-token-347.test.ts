import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { authenticator } from 'otplib';
import { setRateLimitStore, MemoryStore } from '../src/lib/server/ratelimit/index';
import { hashSecret } from '../src/lib/server/admin/crypto';
import type * as Tok from '../src/lib/server/admin/enroll-token';
import * as CliTok from '../scripts/enroll-token-lib.mjs';
import { takeEnrollToken } from '../src/lib/admin/enroll';

// #347 方案 A：一次性绑定令牌。prisma 换成内存库、限流用内存存储，不连任何数据库。令牌都是测试里现生成的假值。
const PASSWORD = 'correct-horse-battery-staple';
const EMAIL = 'owner@example.test';
const EDGE = 'e'.repeat(40);
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
const db = {
  user: {
    findUnique: async ({ where }: { where: { email?: string; id?: string } }) => { const u = users.find((x) => (where.email ? x.email === where.email : x.id === where.id)); return u ? { ...u } : null; },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const u = users.find((x) => x.id === where.id)!; apply(u, data); return { ...u }; },
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
  enrollIssuedAt: new Date(), totpPendingUntil: null, totpEnrollFails: 0, enrollTokenHash: null, enrollTokenExpiresAt: null, createdAt: new Date(), ...over,
});
const owner = () => users.find((u) => u.id === 'u_owner')!;

type H = (req: Request) => Promise<Response>;
let enrollR: { POST: H }; let confirmR: { POST: H };
let T: typeof Tok;
let reset2faData: () => Record<string, unknown>;
before(async () => {
  hash = await hashSecret(PASSWORD);
  T = await import('../src/lib/server/admin/enroll-token');
  ({ reset2faData } = (await import('../src/lib/server/admin/accounts')) as unknown as { reset2faData: () => Record<string, unknown> });
  enrollR = await import('../src/app/api/auth-admin/enroll/route');
  confirmR = await import('../src/app/api/auth-admin/enroll/confirm/route');
});
/** 给 owner 签发一个新令牌（与签发接口同一函数），返回明文 */
const issue = (over: Partial<Row> = {}) => { const t = T.newEnrollToken({ enrollIssuedAt: owner().enrollIssuedAt as Date }); apply(owner(), { ...t.data, ...over }); return t.token; };
let token = '';
beforeEach(() => { setRateLimitStore(new MemoryStore()); users = [newUser()]; audits = []; token = issue(); });

let ipN = 0;
const freshIp = () => `198.51.100.${(++ipN % 250) + 1}`;
const post = (path: string, body: unknown, ip = freshIp()) => new Request(`http://localhost${path}`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'x-edge-auth': EDGE, 'cf-connecting-ip': ip, origin: 'http://localhost' },
});
const call = async (r: Promise<Response>) => { const res = await r; return { status: res.status, body: await res.json() as Record<string, unknown> }; };
const enroll = (tk: string | undefined, password = PASSWORD, ip?: string) => call(enrollR.POST(post('/api/auth-admin/enroll', { email: EMAIL, password, ...(tk === undefined ? {} : { token: tk }) }, ip)));
const confirm = (tk: string | undefined, totp: string, password = PASSWORD, ip?: string) =>
  call(confirmR.POST(post('/api/auth-admin/enroll/confirm', { email: EMAIL, password, totp, ...(tk === undefined ? {} : { token: tk }) }, ip)));
const secretOf = (uri: unknown) => new URL(String(uri)).searchParams.get('secret')!;
const wrongCode = (secret: string) => { for (let i = 0; ; i++) { const c = String(i).padStart(6, '0'); if (authenticator.checkDelta(c, secret) === null) return c; } };
const BAD = { status: 401, body: { error: 'bad_credentials' } };
const rejected = () => audits.filter((a) => a.action === 'auth.enroll_token_rejected').map((a) => (a.meta as { reason: string; route: string }));
const otherToken = () => T.newEnrollToken().token;

test('token format: 32 random bytes base64url (43 chars), DB stores sha256 hex only, never the token', () => {
  const a = T.newEnrollToken(), b = T.newEnrollToken();
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a.token, 'base64url').length, 32);
  assert.notEqual(a.token, b.token);
  assert.equal(a.data.enrollTokenHash, createHash('sha256').update(a.token).digest('hex'));
  assert.ok(!JSON.stringify(a.data).includes(a.token));
});

test('expiry = min(now + 24h, end of the 72h enroll window); expiresTruncated only when capped by the window', () => {
  const now = Date.UTC(2026, 9, 18, 13, 0, 0);
  const fresh = T.newEnrollToken({ enrollIssuedAt: new Date(now) }, now);
  assert.equal(fresh.expiresAt.getTime(), now + 24 * 3_600_000); assert.equal(fresh.expiresTruncated, false);
  const late = T.newEnrollToken({ enrollIssuedAt: new Date(now - 60 * 3_600_000) }, now); // 窗口还剩 12 小时
  assert.equal(late.expiresAt.getTime(), now + 12 * 3_600_000); assert.equal(late.expiresTruncated, true);
  const byCreated = T.newEnrollToken({ createdAt: new Date(now - 70 * 3_600_000), enrollIssuedAt: null }, now);
  assert.equal(byCreated.expiresAt.getTime(), now + 2 * 3_600_000); assert.equal(byCreated.expiresTruncated, true);
  const r = T.issueResponse(fresh, 'https://geiom.com');
  assert.deepEqual(Object.keys(r), ['enrollLink', 'expiresAt', 'expiresTruncated']);
  assert.equal(r.expiresAt, new Date(now + 24 * 3_600_000).toISOString());
  assert.ok(r.expiresAt.endsWith('Z'));
  assert.equal(r.enrollLink, `https://geiom.com/admin-enroll#t=${fresh.token}`); // fragment：不发给服务器、不进 Referer
  assert.ok(!r.enrollLink.includes('?'));
});

test('CLI lib (scripts/enroll-token-lib.mjs) hashes and caps expiry exactly like the server lib', () => {
  const now = Date.UTC(2026, 9, 18, 13, 0, 0);
  const c = CliTok.newEnrollToken(now, now - 60 * 3_600_000);
  assert.equal(c.data.enrollTokenHash, T.hashEnrollToken(c.token));
  assert.equal(c.expiresAt.getTime(), T.newEnrollToken({ enrollIssuedAt: new Date(now - 60 * 3_600_000) }, now).expiresAt.getTime());
  assert.equal(c.expiresTruncated, true);
  assert.equal(CliTok.ENROLL_WINDOW_MS, 72 * 3_600_000); assert.equal(CliTok.ENROLL_TOKEN_TTL_MS, T.ENROLL_TOKEN_TTL_MS);
  assert.equal(CliTok.enrollLink(c.token, 'https://geiom.com'), T.enrollLink(c.token, 'https://geiom.com'));
  assert.equal(CliTok.formatPt(new Date('2026-10-19T13:20:00Z')), '2026-10-19 06:20 PT');
  assert.equal(CliTok.formatPt(new Date('2026-12-01T08:05:00Z')), '2026-12-01 00:05 PT'); // 冬令时 UTC-8
});

test('link base: only NEXT_PUBLIC_SITE_URL, https bare origin; http only for localhost / 127.0.0.1 outside production; server and CLI agree', () => {
  const cases: [Record<string, string>, string | null][] = [
    [{ NEXT_PUBLIC_SITE_URL: 'https://geiom.com' }, 'https://geiom.com'],
    [{ NEXT_PUBLIC_SITE_URL: 'https://geiom.com/' }, 'https://geiom.com'],
    [{ NEXT_PUBLIC_SITE_URL: 'https://geiom.com', APP_ENV: 'production' }, 'https://geiom.com'],
    [{ NEXT_PUBLIC_SITE_URL: 'http://localhost:3100' }, 'http://localhost:3100'],
    [{ NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3000' }, 'http://127.0.0.1:3000'],
    [{ NEXT_PUBLIC_SITE_URL: 'http://localhost:3100', APP_ENV: 'production' }, null],
    [{ NEXT_PUBLIC_SITE_URL: 'http://localhost:3100', VERCEL_ENV: 'production' }, null],
    [{ NEXT_PUBLIC_SITE_URL: 'http://geiom.com' }, null],
    [{ NEXT_PUBLIC_SITE_URL: 'http://localhost.evil.com' }, null],
    [{ NEXT_PUBLIC_SITE_URL: 'https://geiom.com/en' }, null],
    [{ NEXT_PUBLIC_SITE_URL: 'https://u:p@geiom.com' }, null],
    [{ NEXT_PUBLIC_SITE_URL: 'https://geiom.com?x=1' }, null],
    [{ NEXT_PUBLIC_SITE_URL: 'https://geiom.com#a' }, null],
    [{ NEXT_PUBLIC_SITE_URL: 'javascript:alert(1)' }, null],
    [{ NEXT_PUBLIC_SITE_URL: '' }, null],
    [{}, null],
  ];
  for (const [env, want] of cases) {
    assert.equal(T.enrollLinkBase(env), want, JSON.stringify(env));
    assert.equal(CliTok.enrollLinkBase(env), want, `cli ${JSON.stringify(env)}`);
  }
  // 签发接口在写库之前检查，不合格 500 site_url_invalid；从不读请求的 Host
  for (const f of ['src/app/api/admin/users/route.ts', 'src/app/api/admin/users/[id]/reset-2fa/route.ts', 'src/app/api/admin/account/2fa/reset/route.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /const base = enrollLinkBase\(\);[^\n]*\n\s*if \(!base\) return jsonErr\('site_url_invalid', 500\);/, f);
    assert.ok(src.indexOf('enrollLinkBase()') < src.indexOf('newEnrollToken('), f);
    assert.ok(!/headers\.get\('host'\)|req\.url\)\.origin|x-forwarded-host/i.test(src), f);
  }
  assert.ok(!/headers|req\.url/.test(readFileSync('src/lib/server/admin/enroll-token.ts', 'utf8')));
});

test('checkEnrollToken: missing / invalid (wrong, malformed, nothing stored, corrupt hash) / expired / ok', () => {
  const t = T.newEnrollToken();
  const u = { enrollTokenHash: t.data.enrollTokenHash, enrollTokenExpiresAt: new Date(Date.now() + 60_000) };
  assert.equal(T.checkEnrollToken(u, t.token), 'ok');
  assert.equal(T.checkEnrollToken(u, undefined), 'missing');
  assert.equal(T.checkEnrollToken(u, ''), 'missing');
  assert.equal(T.checkEnrollToken(u, otherToken()), 'invalid');
  assert.equal(T.checkEnrollToken(u, t.token.slice(0, 42)), 'invalid');
  assert.equal(T.checkEnrollToken(u, t.token + 'x'), 'invalid');
  assert.equal(T.checkEnrollToken({ enrollTokenHash: null, enrollTokenExpiresAt: null }, t.token), 'invalid');
  assert.equal(T.checkEnrollToken({ ...u, enrollTokenHash: 'zz' }, t.token), 'invalid');
  assert.equal(T.checkEnrollToken({ ...u, enrollTokenExpiresAt: new Date(Date.now() - 1) }, t.token), 'expired');
  assert.equal(T.checkEnrollToken({ ...u, enrollTokenExpiresAt: null }, t.token), 'expired');
  // 常量时间：比较的是两个 32 字节哈希（timingSafeEqual），不是明文字符串
  const src = readFileSync('src/lib/server/admin/enroll-token.ts', 'utf8');
  assert.match(src, /timingSafeEqual\(given, stored \?\? Buffer\.alloc\(32\)\)/);
});

test('password only (no token) can neither enroll nor confirm: same 401 bad_credentials as a wrong password', async () => {
  const wrongPw = await enroll(token, 'wrong-password-123');
  assert.deepEqual(wrongPw, BAD);
  assert.deepEqual(await enroll(undefined), wrongPw);
  assert.deepEqual(await enroll(''), wrongPw);
  assert.equal(owner().totpSecret, null, 'no pending secret was issued');
  assert.deepEqual(await confirm(undefined, '123456'), wrongPw);
  assert.deepEqual(rejected(), [{ reason: 'missing', route: 'enroll' }, { reason: 'missing', route: 'enroll' }, { reason: 'missing', route: 'confirm' }]);
});

test('lockout (PM final): correct password + wrong/missing/expired token counts like a wrong password on enroll AND confirm; 5 → locked 15 min', async () => {
  assert.equal(T.WRONG_TOKEN_COUNTS_AS_FAILED_LOGIN, true);
  assert.deepEqual(await enroll(otherToken()), BAD);
  assert.equal(owner().failedLogins, 1);
  assert.deepEqual(await confirm(undefined, '123456'), BAD);
  assert.equal(owner().failedLogins, 2);
  assert.deepEqual(await enroll(''), BAD);
  assert.deepEqual(await confirm(otherToken(), '123456'), BAD);
  assert.equal(owner().failedLogins, 4); assert.equal(owner().lockedUntil, null);
  assert.deepEqual(await enroll(otherToken()), BAD); // 第 5 次 → 锁定
  assert.equal(owner().failedLogins, 0);
  const until = (owner().lockedUntil as Date).getTime();
  assert.ok(until > Date.now() + 14 * 60_000 && until <= Date.now() + 15 * 60_000);
  assert.equal(audits.filter((a) => a.action === 'auth.lockout').length, 1);
  assert.equal(audits.filter((a) => a.action === 'auth.login_fail' && (a.meta as { reason: string }).reason === 'bad_enroll_token').length, 5);
  assert.deepEqual(rejected().map((r) => r.route), ['enroll', 'confirm', 'enroll', 'confirm', 'enroll']);
  // 锁定期间：正确密码 + 正确令牌也是同一个 401 bad_credentials（与登录锁定一样不区分），不发密钥、不消耗令牌、不再加次数
  assert.deepEqual(await enroll(token), BAD);
  assert.deepEqual(await confirm(token, '123456'), BAD);
  assert.equal(owner().totpSecret, null); assert.ok(owner().enrollTokenHash);
  assert.equal(owner().failedLogins, 0); assert.equal(audits.filter((a) => a.action === 'auth.lockout').length, 1);
  assert.equal(audits.filter((a) => a.action === 'auth.login_fail' && (a.meta as { reason: string }).reason === 'locked').length, 2);
  // 过期令牌同样计入
  apply(owner(), { lockedUntil: null, failedLogins: 0 });
  apply(owner(), { enrollTokenExpiresAt: new Date(Date.now() - 1000) });
  assert.deepEqual(await enroll(token), BAD);
  assert.equal(owner().failedLogins, 1);
  // 开关只有一处，两个接口都走同一个 helper，helper 与错密码同一个 fail()
  for (const f of ['src/app/api/auth-admin/enroll/route.ts', 'src/app/api/auth-admin/enroll/confirm/route.ts'])
    assert.match(readFileSync(f, 'utf8'), /if \(tk !== 'ok'\) \{ await rejectEnrollToken\(user, p\.data\.email, '(enroll|confirm)', tk, ip\); return jsonErr\('bad_credentials', 401\); \}/, f);
  assert.equal(readFileSync('src/lib/server/admin/enroll-token.ts', 'utf8').split('WRONG_TOKEN_COUNTS_AS_FAILED_LOGIN = ').length - 1, 1);
  const login = readFileSync('src/lib/server/admin/login.ts', 'utf8');
  assert.match(login, /export async function recordFailedLogin\(user: User \| null, email: string, ip: string \| null, reason: string\) \{ return fail\(user, email, ip, reason\); \}/);
  // 关掉开关（只改那一行）时 helper 不计次数
  apply(owner(), { failedLogins: 0 });
  await T.rejectEnrollToken(owner() as never, EMAIL, 'enroll', 'invalid', '198.51.100.9', false);
  assert.equal(owner().failedLogins, 0);
});

test('wrong / expired token → 401 bad_credentials on both routes; audit reason invalid / expired', async () => {
  assert.deepEqual(await enroll(otherToken()), BAD);
  assert.deepEqual(await confirm(otherToken(), '123456'), BAD);
  owner().enrollTokenExpiresAt = new Date(Date.now() - 1000);
  assert.deepEqual(await enroll(token), BAD);
  assert.deepEqual(await confirm(token, '123456'), BAD);
  assert.deepEqual(rejected().map((r) => r.reason), ['invalid', 'invalid', 'expired', 'expired']);
  assert.equal(owner().totpSecret, null);
});

test('no oracle: correct password + bad token is not refunded, so it hits the same 429 as wrong passwords (IP+account 5/10min)', async () => {
  const ip = '203.0.113.50';
  for (let i = 0; i < 5; i++) assert.deepEqual(await enroll(otherToken(), PASSWORD, ip), BAD, `try ${i + 1}`);
  assert.deepEqual(await enroll(token, PASSWORD, ip), { status: 429, body: { error: 'rate_limited' } });
  setRateLimitStore(new MemoryStore());
  for (let i = 0; i < 5; i++) assert.deepEqual(await enroll(token, 'wrong-password-' + i, ip), BAD);
  assert.deepEqual(await enroll(token, PASSWORD, ip), { status: 429, body: { error: 'rate_limited' } });
  // 密码和令牌都对：照常退桶（#376），连续 enroll/confirm 不会撞上限
  setRateLimitStore(new MemoryStore());
  apply(owner(), { lockedUntil: null, failedLogins: 0 }); // 上面 5 次错密码锁了账号；令牌错不会锁（与登录接口一致，只有错密码计入）
  const e = await enroll(token, PASSWORD, ip); assert.equal(e.status, 200);
  const s = secretOf(e.body.otpauthUri);
  for (let i = 0; i < 4; i++) assert.equal((await confirm(token, wrongCode(s), PASSWORD, ip)).body.error, 'bad_totp');
  assert.equal((await confirm(token, authenticator.generate(s), PASSWORD, ip)).status, 200);
});

test('without the token, wrong TOTP spam cannot void the owner\'s pending secret (#348 counter untouched)', async () => {
  const s = secretOf((await enroll(token)).body.otpauthUri);
  for (let i = 0; i < 8; i++) assert.deepEqual(await confirm(undefined, wrongCode(s)), BAD);
  assert.equal(owner().totpEnrollFails, 0);
  assert.ok(owner().totpSecret);
  // 令牌错计入锁定（PM 已定）：第 5 次起账号锁 15 分钟，但待确认密钥不作废
  assert.ok((owner().lockedUntil as Date).getTime() > Date.now());
  apply(owner(), { lockedUntil: null, failedLogins: 0 }); // 锁定过期后
  assert.equal((await confirm(token, authenticator.generate(s))).status, 200);
});

test('enroll does not consume the token; confirm consumes it in the same update; reuse → 401', async () => {
  const s = secretOf((await enroll(token)).body.otpauthUri);
  assert.ok(owner().enrollTokenHash, 'still there after enroll');
  const ok = await confirm(token, authenticator.generate(s));
  assert.equal(ok.status, 200); assert.equal((ok.body.recoveryCodes as string[]).length, 10);
  assert.equal(owner().totpEnabled, true);
  assert.equal(owner().enrollTokenHash, null); assert.equal(owner().enrollTokenExpiresAt, null);
  // 之后 2FA 被重置但没有重新签发：旧令牌仍然无效
  apply(owner(), reset2faData());
  assert.deepEqual(await enroll(token), BAD);
  assert.deepEqual(await confirm(token, '123456'), BAD);
  assert.deepEqual(rejected().map((r) => r.reason), ['invalid', 'invalid']);
  const src = readFileSync('src/app/api/auth-admin/enroll/confirm/route.ts', 'utf8');
  assert.match(src, /where: \{ id: user\.id, totpEnabled: false, totpSecret: user\.totpSecret, enrollTokenHash: user\.enrollTokenHash, enrollTokenExpiresAt: \{ gt: new Date\(\) \} \}/);
  assert.match(src, /enrollTokenHash: null, enrollTokenExpiresAt: null,/);
});

test('confirm fails closed if the token was reissued between the check and the write (conditional update)', async () => {
  const s = secretOf((await enroll(token)).body.otpauthUri);
  const real = db.user.updateMany;
  db.user.updateMany = async (a) => { if ('totpEnabled' in a.data) issue(); return real(a); }; // 写之前被重新签发
  try { assert.deepEqual(await confirm(token, authenticator.generate(s)), BAD); } finally { db.user.updateMany = real; }
  assert.equal(owner().totpEnabled, false);
});

test('reissue overwrites the hash: the old token is invalid immediately, the new one works', async () => {
  const old = token;
  const fresh = issue();
  assert.deepEqual(await enroll(old), BAD);
  assert.equal((await enroll(fresh)).status, 200);
});

test('token never appears in audit rows or console output; only the issue response carries it', async () => {
  const logs: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    await enroll(undefined); await enroll(otherToken()); await enroll('x'.repeat(43));
    const s = secretOf((await enroll(token)).body.otpauthUri);
    await confirm(token, wrongCode(s)); await confirm(token, authenticator.generate(s));
  } finally { Object.assign(console, orig); }
  const hay = JSON.stringify(audits) + logs.join('\n');
  assert.ok(!hay.includes(token), 'token leaked');
  assert.ok(!hay.includes(T.hashEnrollToken(token)), 'token hash leaked');
  assert.ok(!hay.includes(EMAIL), 'email leaked');
  for (const r of rejected()) assert.deepEqual(Object.keys(r).sort(), ['reason', 'route']);
  // 审计 helper：签发只记 source / truncated
  const src = readFileSync('src/lib/server/admin/enroll-token.ts', 'utf8');
  assert.match(src, /action: 'auth\.enroll_token_issued', target: targetId, meta: \{ source, truncated \}/);
  assert.match(src, /action: 'auth\.enroll_token_rejected', target: user\.id, meta: \{ reason, route \}/);
  assert.ok(!/console\./.test(src));
});

test('issue points: create / admin reset-2fa / self reset-2fa write the hash in the same write and return the link once', () => {
  const routes = {
    'src/app/api/admin/users/route.ts': 'admin_create',
    'src/app/api/admin/users/[id]/reset-2fa/route.ts': 'admin_reset_2fa',
    'src/app/api/admin/account/2fa/reset/route.ts': 'self_reset_2fa',
  };
  for (const [f, source] of Object.entries(routes)) {
    const src = readFileSync(f, 'utf8');
    assert.equal(src.split('...issueResponse(t, base)').length - 1, 1, `${f}: link returned exactly once`);
    assert.equal(src.split('newEnrollToken(').length - 1, 1, f);
    assert.match(src, /\.\.\.t\.data/, `${f}: hash written with the account change`);
    assert.match(src, new RegExp(`auditTokenIssued\\([^)]*'${source}'`), f);
    // 唯一允许的日志：后台重置 2FA 提交后删限流 key 失败（只有账号 id，不含令牌、邮箱）
    const logs = src.replace("console.warn(`[admin] users.reset_2fa target=${id} rate_limit=failed`)", '');
    assert.ok(!/console\.|t\.token/.test(logs), `${f}: token never logged or used directly`);
    assert.ok(src.indexOf('requireAdmin(') < src.indexOf('newEnrollToken('), `${f}: issued only after the guard`);
  }
  // 其它接口（列表、PATCH）不返回链接；publicUser 不含令牌字段
  for (const f of ['src/app/api/admin/users/[id]/route.ts', 'src/lib/server/admin/accounts.ts'])
    assert.ok(!/enrollLink|issueResponse|enrollToken/.test(readFileSync(f, 'utf8')), f);
});

test('CLI scripts print the link once on stdout and audit without the token', () => {
  for (const f of ['scripts/admin-create.mjs', 'scripts/create-admin.mjs']) {
    const src = readFileSync(f, 'utf8');
    assert.equal(src.split('linkLines(').length - 1, 1, f);
    assert.match(src, /\.\.\.issuedAudit\(u\.id\), meta: \{ source: 'cli', truncated: /, f);
    assert.ok(!/console\.(log|error)\([^)]*(token|linkLines)/i.test(src), f);
    assert.match(src, /process\.stdout\.isTTY/, f);
  }
  // admin-create（生产）：只有终端才签发、显示；seed：终端或非生产
  assert.match(readFileSync('scripts/admin-create.mjs', 'utf8'), /const showLink = !!process\.stdout\.isTTY;/);
  assert.match(readFileSync('scripts/create-admin.mjs', 'utf8'), /const showLink = !totpSeed && \(!!process\.stdout\.isTTY \|\| !prodEnv\);/);
  const lines = CliTok.linkLines({ ...T.newEnrollToken(), token: 'A'.repeat(43), expiresAt: new Date('2026-10-19T13:20:00Z'), expiresTruncated: true }, 'https://geiom.com');
  assert.equal(lines, `https://geiom.com/admin-enroll#t=${'A'.repeat(43)}\n有效至 2026-10-19 06:20 PT 已按账号绑定截止时间缩短\n只私信发给本人，不要贴到群里或工单里\n`);
  assert.match(readFileSync('next.config.ts', 'utf8'), /'\.\/scripts\/enroll-token-lib\.mjs'/);
  assert.match(readFileSync('Dockerfile', 'utf8'), /test -f scripts\/enroll-token-lib\.mjs/);
});

test('enroll page: takes #t= out of the URL fragment (replaceState), keeps query and other fragment keys, rejects malformed tokens; ignores ?t=', () => {
  const tk = T.newEnrollToken().token;
  assert.deepEqual(takeEnrollToken({ pathname: '/admin-enroll', search: '', hash: `#t=${tk}` }), { token: tk, cleanUrl: '/admin-enroll' });
  assert.deepEqual(takeEnrollToken({ pathname: '/admin-enroll', search: '?a=1', hash: `#t=${tk}&x=2` }), { token: tk, cleanUrl: '/admin-enroll?a=1#x=2' });
  assert.deepEqual(takeEnrollToken({ pathname: '/admin-enroll', search: '', hash: '#t=<script>' }), { token: null, cleanUrl: '/admin-enroll' });
  assert.deepEqual(takeEnrollToken({ pathname: '/admin-enroll', search: '', hash: '' }), { token: null, cleanUrl: null });
  assert.deepEqual(takeEnrollToken({ pathname: '/admin-enroll', search: `?t=${tk}`, hash: '' }), { token: null, cleanUrl: null }, 'query is not a token source');
  const page = readFileSync('src/components/admin/enroll/EnrollWizard.tsx', 'utf8');
  assert.match(page, /window\.history\.replaceState\(window\.history\.state, '', cleanUrl\)/);
  assert.match(page, /postEnroll<\{ otpauthUri: string \}>\(ENROLL_PATH, withToken\(/);
  assert.match(page, /postEnroll<\{ recoveryCodes: string\[\] \}>\(CONFIRM_PATH, withToken\(/);
  assert.ok(!/localStorage|sessionStorage|console\./.test(page));
  // 绑定页和接口：no-referrer + noindex,nofollow（next.config 后台头覆盖全站的 strict-origin-when-cross-origin）
  const cfg = readFileSync('next.config.ts', 'utf8');
  assert.match(cfg, /'\/admin-enroll'\]\.map\(\(source\) => \(\{ source, headers: adminHeaders \}\)\)/);
  assert.match(cfg, /\{ key: 'Referrer-Policy', value: 'no-referrer' \}/);
  assert.match(cfg, /\{ key: 'X-Robots-Tag', value: 'noindex, nofollow' \}/);
});
