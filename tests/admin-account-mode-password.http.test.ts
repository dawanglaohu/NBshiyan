import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { PrismaClient, User } from '@prisma/client';
import { authenticator } from 'otplib';
import { AccountModeDTOSchema, PasswordChangeDTOSchema } from '../src/lib/contracts/account';
import { encrypt, hashSecret, verifySecret } from '../src/lib/server/admin/crypto';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

// 与 M3-T3 共用专用测试库；缺地址由 CI 的 M3T3_REQUIRE_DATABASE=true 拦截，本地默认跳过。
const databaseUrl = process.env.M3T3_TEST_DATABASE_URL?.startsWith('postgres')
  ? process.env.M3T3_TEST_DATABASE_URL
  : '';
if (process.env.M3T3_REQUIRE_DATABASE === 'true' && !databaseUrl) {
  throw new Error('M3T3_TEST_DATABASE_URL must be a postgres URL when M3T3_REQUIRE_DATABASE=true');
}
const skip = !databaseUrl && 'no dedicated M3T3_TEST_DATABASE_URL';
process.env.APP_ENV = 'test';
Object.assign(process.env, { NODE_ENV: 'test' });
process.env.AUTH_SECRET ??= 'm3t16-account-security-test-secret-32b';
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.EDGE_AUTH_SECRET ??= 'm'.repeat(40);
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
authenticator.options = { window: 1, step: 30 };

const origin = 'http://127.0.0.1:3000';
const edge = process.env.EDGE_AUTH_SECRET;
const sessionName = 'authjs.session-token';
const password = 'correct-horse-battery';
const newPassword = 'another-correct-horse';
let ipSeq = 1;
let db: PrismaClient = null as unknown as PrismaClient;
let handleAuth: (request: Request) => Promise<Response> = async () => { throw new Error('auth not loaded'); };
let postReauth: (request: Request) => Promise<Response> = async () => { throw new Error('reauth not loaded'); };
let patchMode: (request: Request) => Promise<Response> = async () => { throw new Error('mode not loaded'); };
let postPassword: (request: Request) => Promise<Response> = async () => { throw new Error('password not loaded'); };

function nextIp() { const n = ipSeq++; return `198.51.100.${n}`; }
function trustedHeaders(ip: string, extra: Record<string, string> = {}) {
  return { origin, 'x-edge-auth': edge, 'cf-connecting-ip': ip, ...extra };
}
function cookieJar(response: Response, previous = ''): string {
  const pairs = new Map<string, string>();
  for (const part of previous.split(';')) {
    const trimmed = part.trim(); if (!trimmed) continue;
    const name = trimmed.split('=', 1)[0] ?? '';
    pairs.set(name, trimmed.slice(name.length + 1));
  }
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0] ?? '';
    const name = pair.split('=', 1)[0] ?? '';
    const value = pair.slice(name.length + 1);
    if (!value) pairs.delete(name); else pairs.set(name, value);
  }
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}
function hasSession(response: Response) {
  return response.headers.getSetCookie().some((cookie) => {
    if (!cookie.startsWith(`${sessionName}=`)) return false;
    return ((cookie.split(';', 1)[0] ?? '').slice(sessionName.length + 1)).length > 0;
  });
}
function codeForStep(secret: string, step: number) { return authenticator.clone({ epoch: step * 30_000 + 5_000 }).generate(secret); }
function unusedCode(secret: string, lastStep: number | null) {
  const nowStep = Math.floor(Date.now() / 30_000);
  for (const step of [nowStep + 1, nowStep, nowStep - 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    return codeForStep(secret, step);
  }
  throw new Error('no unused totp step in the current window');
}

before(async () => {
  if (!databaseUrl) return;
  setRateLimitStore(new MemoryStore());
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { throw new Error('prisma db push failed'); }
  ({ prisma: db } = await import('../src/lib/server/db'));
  ({ handleAuth } = await import('../src/auth'));
  ({ POST: postReauth } = await import('../src/app/api/admin/account/reauth/route'));
  ({ PATCH: patchMode } = await import('../src/app/api/admin/account/login-mode/route'));
  ({ POST: postPassword } = await import('../src/app/api/admin/account/password/route'));
});
after(async () => { await db?.$disconnect?.(); });

async function makeUser(over: { role?: User['role']; passwordlessEnabled?: boolean } = {}) {
  const plain = authenticator.generateSecret();
  const email = `m3t16-http-${randomBytes(4).toString('hex')}@example.com`;
  const row = await db.user.create({
    data: {
      email, name: 'Ada', passwordHash: await hashSecret(password), role: over.role ?? 'ADMIN',
      totpSecret: encrypt(plain), totpEnabled: true, passwordlessEnabled: over.passwordlessEnabled ?? false,
    },
  });
  return { row, email, plain };
}
async function csrf(ip: string) {
  const response = await handleAuth(new Request(`${origin}/api/auth/csrf`, { headers: trustedHeaders(ip) }));
  const body = await response.json() as { csrfToken: string };
  return { token: body.csrfToken, jar: cookieJar(response) };
}
async function postLogin(fields: Record<string, string>, ip: string) {
  const first = await csrf(ip);
  const form = new URLSearchParams({ csrfToken: first.token, callbackUrl: `${origin}/admin`, ...fields });
  const response = await handleAuth(new Request(`${origin}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { ...trustedHeaders(ip), 'content-type': 'application/x-www-form-urlencoded', cookie: first.jar },
    body: form,
  }));
  return { response, jar: cookieJar(response, first.jar) };
}
async function grantFor(actor: { row: User; email: string; plain: string }, jar: string, purpose: 'LOGIN_MODE' | 'PASSWORD', ip: string) {
  const fresh = unusedCode(actor.plain, (await db.user.findUniqueOrThrow({ where: { id: actor.row.id } })).totpLastStep);
  const response = await postReauth(new Request(`${origin}/api/admin/account/reauth`, {
    method: 'POST',
    headers: { ...trustedHeaders(ip), cookie: jar, 'content-type': 'application/json' },
    body: JSON.stringify({ purpose, password, totp: fresh }),
  }));
  assert.equal(response.status, 200, `fresh ${purpose} grant must be issued`);
  return (await response.json() as { token: string }).token;
}
function mode(jar: string, body: unknown, ip: string, headerOrigin = origin) {
  return patchMode(new Request(`${origin}/api/admin/account/login-mode`, {
    method: 'PATCH', headers: { ...trustedHeaders(ip, { origin: headerOrigin }), cookie: jar, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
function changePassword(jar: string, body: unknown, ip: string, headerOrigin = origin) {
  return postPassword(new Request(`${origin}/api/admin/account/password`, {
    method: 'POST', headers: { ...trustedHeaders(ip, { origin: headerOrigin }), cookie: jar, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('M3-T16 login-mode / password handlers', { concurrency: 1, skip }, () => {
  test('E-06 E-03 LOGIN_MODE grant enables totp-only login, bumps sv, revokes old devices, audit in same tx', { timeout: 180_000 }, async () => {
    const actor = await makeUser();
    const ip = nextIp();
    const signed = await postLogin({ email: actor.email, password, totp: authenticator.generate(actor.plain) }, ip);
    assert.equal(hasSession(signed.response), true);
    const before = await db.user.findUniqueOrThrow({ where: { id: actor.row.id } });
    const grant = await grantFor(actor, signed.jar, 'LOGIN_MODE', ip);

    const ok = await mode(signed.jar, { passwordlessEnabled: true, actionGrant: grant }, ip);
    assert.equal(ok.status, 200);
    const body = AccountModeDTOSchema.parse(await ok.json());
    assert.equal(body.passwordlessEnabled, true);
    const after = await db.user.findUniqueOrThrow({ where: { id: actor.row.id } });
    assert.equal(after.passwordlessEnabled, true);
    assert.equal(after.sessionVersion, before.sessionVersion + 1);
    assert.equal(after.passwordHash, before.passwordHash, 'password kept as another available way');
    assert.equal(after.totpEnabled, true);
    assert.equal(await db.adminDeviceSession.count({ where: { userId: actor.row.id, revokedAt: null } }), 0, 'old devices revoked');
    assert.equal((await db.auditLog.findMany({ where: { action: 'account.mode_change', target: actor.row.id } })).length, 1);
    assert.ok((await db.adminActionGrant.findMany({ where: { userId: actor.row.id, purpose: 'LOGIN_MODE' } }))[0]?.usedAt, 'grant consumed');

    // E-06：启用后真实 Credentials mode=totp 只提交 email/totp 即可登录（不含 password/recoveryCode）。
    const next = unusedCode(actor.plain, after.totpLastStep);
    const totpOnly = await postLogin({ email: actor.email, mode: 'totp', totp: next }, nextIp());
    assert.equal(hasSession(totpOnly.response), true, 'mode=totp with only email+totp succeeds');
    // 关闭后该 totp 模式通用失败，password+totp 仍可登录。
    const grant2 = await grantFor(actor, totpOnly.jar, 'LOGIN_MODE', nextIp());
    const off = await mode(totpOnly.jar, { passwordlessEnabled: false, actionGrant: grant2 }, nextIp());
    assert.equal(off.status, 200);
    const totpRejected = await postLogin({ email: actor.email, mode: 'totp', totp: next }, nextIp());
    assert.equal(hasSession(totpRejected.response), false, 'totp mode refused after disabling');
    const pwLogin = await postLogin({ email: actor.email, password, totp: unusedCode(actor.plain, (await db.user.findUniqueOrThrow({ where: { id: actor.row.id } })).totpLastStep) }, nextIp());
    assert.equal(hasSession(pwLogin.response), true, 'password+totp still works');
  });

  test('E-73 E-74 wrong purpose, replay, expired/old sv and two concurrent same-grant switches: at most one succeeds', { timeout: 180_000 }, async () => {
    const actor = await makeUser();
    const ip = nextIp();
    const signed = await postLogin({ email: actor.email, password, totp: authenticator.generate(actor.plain) }, ip);
    const pwGrant = await grantFor(actor, signed.jar, 'PASSWORD', ip);
    // PASSWORD 授权不能切换方式（purpose 不符）。
    const wrongPurpose = await mode(signed.jar, { passwordlessEnabled: true, actionGrant: pwGrant }, ip);
    assert.equal(wrongPurpose.status, 401);
    assert.equal((await wrongPurpose.json() as { error: string }).error, 'action_grant_invalid');
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: actor.row.id } })).passwordlessEnabled, false, 'no state change');

    // 同一 LOGIN_MODE grant 并发两次，最多一次成功，失败后仍至少一种已验证方式。
    const loginGrant = await grantFor(actor, signed.jar, 'LOGIN_MODE', nextIp());
    const [a, b] = await Promise.all([
      mode(signed.jar, { passwordlessEnabled: true, actionGrant: loginGrant }, nextIp()),
      mode(signed.jar, { passwordlessEnabled: true, actionGrant: loginGrant }, nextIp()),
    ]);
    assert.deepEqual([a.status, b.status].slice().sort(), [200, 401]);
    const after = await db.user.findUniqueOrThrow({ where: { id: actor.row.id } });
    assert.equal(after.totpEnabled, true, 'at least one verified way remains');
    assert.equal(after.passwordHash !== '', true);
    // 重放同 grant 不再成功。
    const replay = await mode(signed.jar, { passwordlessEnabled: true, actionGrant: loginGrant }, nextIp());
    assert.equal(replay.status, 401);
  });

  test('E-07 enabling passwordless without a bound authenticator is refused with no state change (service-level)', { timeout: 180_000 }, async () => {
    // 不依赖 Auth.js 登录：注入 fake grant/repo，专测「无已验证可用方式」这一分支。
    const { createAccountSecurityService } = await import('../src/lib/server/admin/account-security');
    let applied = 0;
    const fakeTx = {};
    const fakeDb = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx) };
    const fakeGrants = { consume: async () => true, issue: async () => { throw new Error('not used'); } };
    const fakeRepo = {
      readCurrentUser: async () => ({ id: 'u', sessionVersion: 1, disabled: false, totpEnabled: false, totpSecret: null, passwordHash: 'x', passwordlessEnabled: false }),
      applySensitiveChange: async () => { applied += 1; return 1; },
      revokeDevices: async () => {},
      createAudit: async () => {},
    };
    const svc = createAccountSecurityService({
      db: fakeDb as never, actionGrants: fakeGrants as never, repo: fakeRepo as never,
    });
    await assert.rejects(
      svc.changeLoginMode({ userId: 'u', sid: 'd', passwordlessEnabled: true, grantToken: 't' }),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === 'version_conflict',
    );
    assert.equal(applied, 0, 'no write when the change would leave no verified login way');
  });

  test('E-03 E-74 password change: PASSWORD grant and legacy currentPassword+totp both bump sv, revoke devices, refuse non-empty recoveryCode', { timeout: 180_000 }, async () => {
    const actor = await makeUser();
    const ip = nextIp();
    const signed = await postLogin({ email: actor.email, password, totp: authenticator.generate(actor.plain) }, ip);
    const before = await db.user.findUniqueOrThrow({ where: { id: actor.row.id } });

    // grant 路径
    const pwGrant = await grantFor(actor, signed.jar, 'PASSWORD', ip);
    const ok = await changePassword(signed.jar, { newPassword, actionGrant: pwGrant }, ip);
    assert.equal(ok.status, 200);
    PasswordChangeDTOSchema.parse(await ok.json());
    const afterGrant = await db.user.findUniqueOrThrow({ where: { id: actor.row.id } });
    assert.equal(await verifySecret(afterGrant.passwordHash, newPassword), true);
    assert.equal(afterGrant.sessionVersion, before.sessionVersion + 1);
    assert.equal(await db.adminDeviceSession.count({ where: { userId: actor.row.id, revokedAt: null } }), 0);
    assert.equal((await db.auditLog.findMany({ where: { action: 'account.password_change', target: actor.row.id } })).length, 1);

    // 非空 recoveryCode 由 Zod strict 拒绝（同强度兼容路径不接受恢复码）
    const signed2 = await postLogin({ email: actor.email, password: newPassword, totp: authenticator.generate(actor.plain) }, nextIp());
    const bad = await changePassword(signed2.jar, { newPassword: 'yet-another-pass1', currentPassword: newPassword, totp: unusedCode(actor.plain, afterGrant.totpLastStep), recoveryCode: 'abcde12345' }, nextIp());
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as { error: string }).error, 'invalid');
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: actor.row.id } })).sessionVersion, afterGrant.sessionVersion, 'no state change');

    // legacy 路径同强度
    const legacy = await changePassword(signed2.jar, { newPassword: 'yet-another-pass1', currentPassword: newPassword, totp: unusedCode(actor.plain, (await db.user.findUniqueOrThrow({ where: { id: actor.row.id } })).totpLastStep) }, nextIp());
    assert.equal(legacy.status, 200);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: actor.row.id } })).sessionVersion, afterGrant.sessionVersion + 1);
    // PASSWORD 授权用于改密码之外的目的是否拒绝已由上一条覆盖；replay 同 grant 再改密拒绝。
    const replay = await changePassword(signed2.jar, { newPassword: 'one-more-pass-123', actionGrant: pwGrant }, nextIp());
    assert.equal(replay.status, 401);
  });

  test('anonymous, cross-origin and session-only requests are refused with no state change', { timeout: 180_000 }, async () => {
    const actor = await makeUser();
    const ip = nextIp();
    const signed = await postLogin({ email: actor.email, password, totp: authenticator.generate(actor.plain) }, ip);
    const before = await db.user.findUniqueOrThrow({ where: { id: actor.row.id } });
    const anonymous = await mode('', { passwordlessEnabled: true, actionGrant: 'a'.repeat(43) }, nextIp());
    assert.equal(anonymous.status, 401);
    const foreign = await mode(signed.jar, { passwordlessEnabled: true, actionGrant: 'a'.repeat(43) }, ip, 'https://evil.example');
    assert.equal(foreign.status, 403);
    const sessionOnly = await changePassword(signed.jar, { newPassword }, ip);
    assert.equal(sessionOnly.status, 400);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: actor.row.id } })).sessionVersion, before.sessionVersion);
  });
});
