import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { authenticator } from 'otplib';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

// 隔离库只认本任务的专用变量。没有它就跳过，避免连上开发库或生产库。
// describe 级 skip 在 TAP 里是 tests 0 / skipped 0。
// build-and-audit 也会设 CI=true，但没有数据库。只有 PG17 步骤设 M3T2_REQUIRE_DATABASE=true，缺地址时才抛错。
const databaseUrl = process.env.M3T2_TEST_DATABASE_URL?.startsWith('postgres')
  ? process.env.M3T2_TEST_DATABASE_URL
  : '';
if (process.env.CI === 'true' && process.env.M3T2_REQUIRE_DATABASE === 'true' && !databaseUrl) {
  throw new Error('M3T2_TEST_DATABASE_URL must be a postgres URL when CI=true');
}
const skip = !databaseUrl && 'no dedicated M3T2_TEST_DATABASE_URL';
Object.assign(process.env, { NODE_ENV: 'test' });
process.env.APP_ENV = 'test';
process.env.AUTH_SECRET ??= 'm3t2-login-mode-test-secret-32b';
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.EDGE_AUTH_SECRET = 'e'.repeat(40);
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;
delete process.env.ADMIN_ALERT_EMAIL;
delete process.env.INQUIRY_NOTIFY_EMAIL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

authenticator.options = { window: 1, step: 30 };

const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const origin = 'http://127.0.0.1:3000';
const sessionName = 'authjs.session-token';
const edge = process.env.EDGE_AUTH_SECRET;
let ipSeq = 1;
let handleAuth: (request: Request) => Promise<Response> = async () => { throw new Error('auth not loaded'); };
let consumeTotpStep: typeof import('../src/lib/server/admin/login').consumeTotpStep = async () => { throw new Error('login not loaded'); };
let authorizeLogin: typeof import('../src/lib/server/admin/login').authorizeLogin = async () => { throw new Error('login not loaded'); };

function nextIp() {
  const n = ipSeq++;
  if (n > 250) throw new Error('test ip range exhausted');
  return `198.51.100.${n}`;
}

function trustedHeaders(ip: string, extra: Record<string, string> = {}) {
  return { origin, 'x-edge-auth': edge, 'cf-connecting-ip': ip, ...extra };
}

function cookieJar(response: Response, previous = ''): string {
  const pairs = new Map<string, string>();
  for (const part of previous.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const name = trimmed.split('=', 1)[0] ?? '';
    pairs.set(name, trimmed.slice(name.length + 1));
  }
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0] ?? '';
    const name = pair.split('=', 1)[0] ?? '';
    const value = pair.slice(name.length + 1);
    if (!value) pairs.delete(name);
    else pairs.set(name, value);
  }
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}

function hasSession(response: Response) {
  return response.headers.getSetCookie().some((cookie) => {
    if (!cookie.startsWith(`${sessionName}=`)) return false;
    const value = (cookie.split(';', 1)[0] ?? '').slice(sessionName.length + 1);
    return value.length > 0;
  });
}

function failureKey(response: Response) {
  const loc = response.headers.get('location') ?? '';
  const url = loc ? new URL(loc, origin) : null;
  return [
    response.status,
    url?.pathname ?? '',
    url?.searchParams.get('error') ?? '',
    url?.searchParams.get('code') ?? '',
    hasSession(response) ? '1' : '0',
  ].join('|');
}

async function csrf(ip: string) {
  const response = await handleAuth(new Request(`${origin}/api/auth/csrf`, { headers: trustedHeaders(ip) }));
  const body = await response.json() as { csrfToken: string };
  return { token: body.csrfToken, jar: cookieJar(response) };
}

async function postLogin(fields: Record<string, string>, ip: string) {
  const first = await csrf(ip);
  const form = new URLSearchParams({ csrfToken: first.token, callbackUrl: `${origin}/admin`, ...fields });
  return handleAuth(new Request(`${origin}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { ...trustedHeaders(ip), 'content-type': 'application/x-www-form-urlencoded', cookie: first.jar },
    body: form,
  }));
}

async function deviceCount(userId: string) {
  return (prisma as PrismaClient).adminDeviceSession.count({ where: { userId } });
}

async function baselineKey() {
  const response = await postLogin({
    email: `missing-${randomBytes(4).toString('hex')}@example.com`,
    password: 'not-a-real-password',
    totp: '000000',
  }, nextIp());
  return { response, key: failureKey(response) };
}

before(async () => {
  if (!databaseUrl || !prisma) return;
  setRateLimitStore(new MemoryStore());
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('prisma db push failed');
  }
  ({ handleAuth } = await import('../src/auth'));
  ({ consumeTotpStep, authorizeLogin } = await import('../src/lib/server/admin/login'));
});

after(async () => { await prisma?.$disconnect(); });

async function makeUser(over: { passwordlessEnabled?: boolean; disabled?: boolean; totpEnabled?: boolean; totpSecret?: string | null } = {}) {
  const client = prisma as PrismaClient;
  const plain = authenticator.generateSecret();
  const email = `m3t2-${randomBytes(4).toString('hex')}@example.com`;
  const password = 'correct-horse-battery';
  const row = await client.user.create({
    data: {
      email, name: 'Ada', passwordHash: await hashSecret(password), role: 'ADMIN',
      totpSecret: encrypt(plain), totpEnabled: true,
      ...over,
    },
  });
  return { row, email, password, plain, code: () => authenticator.generate(plain) };
}

async function securitySnapshot(id: string) {
  const row = await (prisma as PrismaClient).user.findUniqueOrThrow({ where: { id } });
  return {
    totpEnabled: row.totpEnabled,
    totpSecret: row.totpSecret,
    sessionVersion: row.sessionVersion,
    passwordlessEnabled: row.passwordlessEnabled,
    recoveryCodes: row.recoveryCodes,
    failedLogins: row.failedLogins,
    lockedUntil: row.lockedUntil,
    totpLastStep: row.totpLastStep,
  };
}

async function makeRecoveryUser(over: { passwordlessEnabled?: boolean; sessionVersion?: number } = {}) {
  const member = await makeUser({ passwordlessEnabled: over.passwordlessEnabled });
  const recovery = randomBytes(5).toString('hex');
  const hash = await hashSecret(recovery);
  const client = prisma as PrismaClient;
  await client.user.update({
    where: { id: member.row.id },
    data: { recoveryCodes: [hash], ...(over.sessionVersion === undefined ? {} : { sessionVersion: over.sessionVersion }) },
  });
  return { ...member, recovery, hash };
}

async function auditsFor(id: string) {
  return (prisma as PrismaClient).auditLog.findMany({ where: { actorId: id } });
}

function auditsOmit(audits: { action: string; target: string | null; meta: unknown }[], code: string) {
  assert.equal(JSON.stringify(audits).includes(code), false);
}

function leadingZeroCode() {
  for (let i = 0; i < 500; i++) {
    const plain = authenticator.generateSecret();
    const code = authenticator.generate(plain);
    if (/^0[0-9]{5}$/.test(code)) return { plain, code };
  }
  throw new Error('no leading-zero authenticator code');
}

describe('login modes', { concurrency: 1, skip }, () => {
test('omitted mode stays password and a valid password plus code opens one device', { timeout: 180_000 }, async () => {
  const member = await makeUser();
  assert.equal(member.row.passwordlessEnabled, false);
  const signed = await postLogin({ email: member.email, password: member.password, totp: member.code() }, nextIp());
  assert.equal(hasSession(signed), true);
  assert.equal(await deviceCount(member.row.id), 1);
});

test('unknown mode, disallowed totp, recovery code, and unknown account share one failure and leave no device', { skip, timeout: 180_000 }, async () => {
  const base = await baselineKey();
  assert.equal(base.key, '302|/api/auth/signin|CredentialsSignin|credentials|0');
  assert.equal((base.response.headers.get('location') ?? '').includes('@'), false);

  const member = await makeUser();
  const code = member.code();
  const attempts: Record<string, string>[] = [
    { email: member.email, password: member.password, totp: code, mode: 'recovery' },
    { email: member.email, password: member.password, totp: code, mode: 'PASSWORD' },
    { email: member.email, mode: 'totp', totp: code },
    { email: member.email, password: member.password, totp: code, recoveryCode: 'abcd1234' },
    { email: member.email, totp: code },
  ];
  for (const fields of attempts) {
    const response = await postLogin(fields, nextIp());
    assert.equal(failureKey(response), base.key);
    assert.equal((response.headers.get('location') ?? '').toLowerCase().includes(member.email), false);
    assert.equal(await deviceCount(member.row.id), 0);
  }
  const untouched = await (prisma as PrismaClient).user.findUniqueOrThrow({ where: { id: member.row.id } });
  assert.equal(untouched.totpLastStep, null);
  assert.equal(untouched.failedLogins, 0);

  const disabled = await makeUser({ disabled: true });
  const disabledResponse = await postLogin({
    email: disabled.email, password: disabled.password, totp: disabled.code(),
  }, nextIp());
  assert.equal(failureKey(disabledResponse), base.key);
  assert.equal(await deviceCount(disabled.row.id), 0);

  const unbound = await makeUser({ totpEnabled: false, totpSecret: null });
  const unboundResponse = await postLogin({
    email: unbound.email, password: unbound.password, totp: '123456',
  }, nextIp());
  assert.equal(failureKey(unboundResponse), base.key);
  assert.equal(await deviceCount(unbound.row.id), 0);

  const signed = await postLogin({ email: member.email, password: member.password, totp: code }, nextIp());
  assert.equal(hasSession(signed), true);
  assert.equal(await deviceCount(member.row.id), 1);
});

test('totp mode ignores the password and password mode does not burn the code on a wrong password', { skip, timeout: 180_000 }, async () => {
  const member = await makeUser({ passwordlessEnabled: true });
  const code = member.code();
  const wrong = await postLogin({
    email: member.email, password: 'wrong-password-value', totp: code,
  }, nextIp());
  assert.equal(hasSession(wrong), false);
  assert.equal(await deviceCount(member.row.id), 0);
  const afterWrong = await (prisma as PrismaClient).user.findUniqueOrThrow({ where: { id: member.row.id } });
  assert.equal(afterWrong.totpLastStep, null);

  const signed = await postLogin({
    email: member.email, password: 'still-wrong', totp: code, mode: 'totp',
  }, nextIp());
  assert.equal(hasSession(signed), true);
  assert.equal(await deviceCount(member.row.id), 1);
});

test('a code with a leading zero still satisfies password mode', { skip, timeout: 180_000 }, async () => {
  const found = leadingZeroCode();
  const member = await makeUser({ totpSecret: encrypt(found.plain) });
  const signed = await postLogin({
    email: member.email, password: member.password, totp: found.code,
  }, nextIp());
  assert.equal(hasSession(signed), true);
  assert.match(found.code, /^0[0-9]{5}$/);
  const row = await (prisma as PrismaClient).user.findUniqueOrThrow({ where: { id: member.row.id } });
  assert.equal(row.totpLastStep !== null, true);
});

test('one authenticator step succeeds once across concurrent logins and a replay', { skip, timeout: 180_000 }, async () => {
  const base = await baselineKey();
  const member = await makeUser();
  const code = member.code();
  const [left, right] = await Promise.all([
    postLogin({ email: member.email, password: member.password, totp: code }, nextIp()),
    postLogin({ email: member.email, password: member.password, totp: code }, nextIp()),
  ]);
  assert.equal([left, right].filter(hasSession).length, 1);
  assert.equal(await deviceCount(member.row.id), 1);
  const replay = await postLogin({ email: member.email, password: member.password, totp: code }, nextIp());
  assert.equal(failureKey(replay), base.key);
  assert.equal(await deviceCount(member.row.id), 1);
});

test('a stale session version or an old secret cannot consume the current step', { skip, timeout: 180_000 }, async () => {
  const client = prisma as PrismaClient;
  const versioned = await makeUser();
  const staleVersion = await client.user.findUniqueOrThrow({ where: { id: versioned.row.id } });
  await client.user.update({ where: { id: versioned.row.id }, data: { sessionVersion: { increment: 1 } } });
  const versionCode = versioned.code();
  assert.equal(await consumeTotpStep(staleVersion, versionCode), false);
  const afterVersion = await client.user.findUniqueOrThrow({ where: { id: versioned.row.id } });
  assert.equal(afterVersion.totpLastStep, null);
  assert.equal(await consumeTotpStep(afterVersion, versionCode), true);
  assert.equal(await consumeTotpStep(afterVersion, versionCode), false);

  const rotated = await makeUser();
  const staleSecret = await client.user.findUniqueOrThrow({ where: { id: rotated.row.id } });
  const oldCode = rotated.code();
  const nextPlain = authenticator.generateSecret();
  await client.user.update({
    where: { id: rotated.row.id },
    data: { totpSecret: encrypt(nextPlain), totpLastStep: null },
  });
  assert.equal(await consumeTotpStep(staleSecret, oldCode), false);
  assert.equal((await client.user.findUniqueOrThrow({ where: { id: rotated.row.id } })).totpLastStep, null);
  const denied = await postLogin({ email: rotated.email, password: rotated.password, totp: oldCode }, nextIp());
  assert.equal(hasSession(denied), false);
  assert.equal(await deviceCount(rotated.row.id), 0);
  const signed = await postLogin({
    email: rotated.email, password: rotated.password, totp: authenticator.generate(nextPlain),
  }, nextIp());
  assert.equal(hasSession(signed), true);
  assert.equal(await deviceCount(rotated.row.id), 1);
});

test('the existing login rate limit still rejects the next correct code without consuming it', { skip, timeout: 180_000 }, async () => {
  const base = await baselineKey();
  const member = await makeUser();
  const ip = nextIp();
  const code = member.code();
  for (let i = 0; i < 5; i++) {
    const wrong = await postLogin({
      email: member.email, password: `wrong-password-${i}`, totp: code,
    }, ip);
    assert.equal(failureKey(wrong), base.key);
  }
  const blocked = await postLogin({ email: member.email, password: member.password, totp: code }, ip);
  assert.equal(failureKey(blocked), base.key);
  assert.equal(await deviceCount(member.row.id), 0);
  const row = await (prisma as PrismaClient).user.findUniqueOrThrow({ where: { id: member.row.id } });
  assert.equal(row.totpLastStep, null);
});

test('an unused recovery code logs in once and does not change totp or session fields', { skip, timeout: 180_000 }, async () => {
  const member = await makeRecoveryUser({ passwordlessEnabled: true, sessionVersion: 7 });
  const before = await securitySnapshot(member.row.id);
  const signed = await postLogin({
    email: member.email, password: member.password, totp: member.code(), recoveryCode: member.recovery,
  }, nextIp());
  assert.equal(hasSession(signed), true);
  assert.equal(await deviceCount(member.row.id), 1);
  const after = await securitySnapshot(member.row.id);
  assert.equal(after.totpEnabled, before.totpEnabled);
  assert.equal(after.totpSecret, before.totpSecret);
  assert.equal(after.sessionVersion, before.sessionVersion);
  assert.equal(after.sessionVersion, 7);
  assert.equal(after.passwordlessEnabled, true);
  assert.equal(after.totpLastStep, null);
  assert.deepEqual(after.recoveryCodes, []);
  const audits = await auditsFor(member.row.id);
  assert.equal(audits.some((row) => row.action === 'auth.login_success' && (row.meta as { method?: string }).method === 'recovery_code'), true);
  auditsOmit(audits, member.recovery);
});

test('a wrong recovery code counts as one failure and reuse fails the same way', { skip, timeout: 180_000 }, async () => {
  const base = await baselineKey();
  const member = await makeRecoveryUser();
  const wrongPassword = await authorizeLogin({
    email: member.email, password: 'wrong-password-value', recoveryCode: member.recovery,
  }, nextIp());
  assert.equal(wrongPassword, null);
  const afterPassword = await securitySnapshot(member.row.id);
  assert.deepEqual(afterPassword.recoveryCodes, [member.hash]);
  assert.equal(afterPassword.failedLogins, 1);

  const wrongCode = randomBytes(5).toString('hex');
  const wrong = await postLogin({
    email: member.email, password: member.password, recoveryCode: wrongCode,
  }, nextIp());
  assert.equal(failureKey(wrong), base.key);
  assert.equal(hasSession(wrong), false);
  const afterWrong = await securitySnapshot(member.row.id);
  assert.equal(afterWrong.failedLogins, 2);
  assert.deepEqual(afterWrong.recoveryCodes, [member.hash]);
  const wrongAudits = await auditsFor(member.row.id);
  assert.equal(wrongAudits.some((row) => row.action === 'auth.login_fail'), true);
  auditsOmit(wrongAudits, wrongCode);
  auditsOmit(wrongAudits, member.recovery);

  const signed = await postLogin({
    email: member.email, password: member.password, recoveryCode: member.recovery,
  }, nextIp());
  assert.equal(hasSession(signed), true);
  const reused = await postLogin({
    email: member.email, password: member.password, recoveryCode: member.recovery,
  }, nextIp());
  assert.equal(failureKey(reused), base.key);
  assert.equal(await deviceCount(member.row.id), 1);
  assert.deepEqual((await securitySnapshot(member.row.id)).recoveryCodes, []);
  auditsOmit(await auditsFor(member.row.id), member.recovery);
});

test('two logins with the same recovery code succeed only once', { skip, timeout: 180_000 }, async () => {
  const member = await makeRecoveryUser({ sessionVersion: 4 });
  const before = await securitySnapshot(member.row.id);
  const fields = { email: member.email, password: member.password, recoveryCode: member.recovery };
  const [left, right] = await Promise.all([postLogin(fields, nextIp()), postLogin(fields, nextIp())]);
  assert.equal([left, right].filter(hasSession).length, 1);
  assert.equal(await deviceCount(member.row.id), 1);
  const after = await securitySnapshot(member.row.id);
  assert.deepEqual(after.recoveryCodes, []);
  assert.equal(after.totpEnabled, before.totpEnabled);
  assert.equal(after.totpSecret, before.totpSecret);
  assert.equal(after.sessionVersion, before.sessionVersion);
  assert.equal(after.passwordlessEnabled, before.passwordlessEnabled);
});

test('a correct recovery code still fails while the account is locked', { skip, timeout: 180_000 }, async () => {
  const base = await baselineKey();
  const member = await makeRecoveryUser();
  await (prisma as PrismaClient).user.update({
    where: { id: member.row.id },
    data: { lockedUntil: new Date(Date.now() + 15 * 60_000), failedLogins: 2 },
  });
  const before = await securitySnapshot(member.row.id);
  const denied = await postLogin({
    email: member.email, password: member.password, recoveryCode: member.recovery,
  }, nextIp());
  assert.equal(failureKey(denied), base.key);
  assert.equal(hasSession(denied), false);
  assert.equal(await deviceCount(member.row.id), 0);
  const after = await securitySnapshot(member.row.id);
  assert.deepEqual(after.recoveryCodes, before.recoveryCodes);
  assert.equal(after.failedLogins, before.failedLogins);
  assert.equal(after.totpEnabled, before.totpEnabled);
  assert.equal(after.totpSecret, before.totpSecret);
  assert.equal(after.sessionVersion, before.sessionVersion);
  assert.equal(after.passwordlessEnabled, before.passwordlessEnabled);
  const audits = await auditsFor(member.row.id);
  assert.equal(audits.some((row) => row.action === 'auth.login_fail'), true);
  auditsOmit(audits, member.recovery);
});

test('five wrong recovery codes lock the account on the shared failure counter', { skip, timeout: 180_000 }, async () => {
  const member = await makeRecoveryUser();
  for (let i = 0; i < 5; i++) {
    const response = await postLogin({
      email: member.email, password: member.password, recoveryCode: randomBytes(5).toString('hex'),
    }, nextIp());
    assert.equal(hasSession(response), false);
  }
  const locked = await securitySnapshot(member.row.id);
  assert.equal(locked.failedLogins, 0);
  assert.ok(locked.lockedUntil && locked.lockedUntil > new Date());
  assert.deepEqual(locked.recoveryCodes, [member.hash]);
  const audits = await auditsFor(member.row.id);
  assert.equal(audits.some((row) => row.action === 'auth.lockout'), true);
  auditsOmit(audits, member.recovery);
});
});
