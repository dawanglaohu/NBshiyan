import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { authenticator } from 'otplib';
import { decode } from 'next-auth/jwt';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';
import { createApiCounter, type ApiCounterDb } from '../src/lib/server/http/metrics';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

const databaseUrl = process.env.ADMIN_DEVICE_TEST_DATABASE_URL?.startsWith('postgres')
  ? process.env.ADMIN_DEVICE_TEST_DATABASE_URL
  : '';
const skip = !databaseUrl && 'no dedicated ADMIN_DEVICE_TEST_DATABASE_URL';
const secret = process.env.AUTH_SECRET || 'device-session-test-secret-32b';
process.env.AUTH_SECRET = secret;
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 9).toString('base64');
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const origin = 'http://127.0.0.1:3000';
const sessionName = 'authjs.session-token';
let handleAuth: (request: Request) => Promise<Response> = async () => { throw new Error('auth not loaded'); };
let createAccountGet: typeof import('../src/lib/server/admin/account').createAccountGet = () => { throw new Error('account not loaded'); };

function cookieJar(response: Response, previous = ''): string {
  const pairs = new Map<string, string>();
  for (const part of previous.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const name = trimmed.split('=', 1)[0];
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

function maxAge(response: Response, name: string): number | null {
  const cookie = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
  const match = cookie?.match(/Max-Age=(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function csrf(jar = ''): Promise<{ token: string; jar: string }> {
  const response = await handleAuth(new Request(`${origin}/api/auth/csrf`, { headers: { cookie: jar } }));
  const body = await response.json() as { csrfToken: string };
  return { token: body.csrfToken, jar: cookieJar(response, jar) };
}

async function login(email: string, password: string, totp: string, rememberDevice?: string) {
  const first = await csrf();
  const form = new URLSearchParams({ email, password, totp, csrfToken: first.token, callbackUrl: `${origin}/admin` });
  if (rememberDevice !== undefined) form.set('rememberDevice', rememberDevice);
  const response = await handleAuth(new Request(`${origin}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: first.jar, origin },
    body: form,
  }));
  return { response, jar: cookieJar(response, first.jar) };
}

async function account(jar: string, handler = createAccountGet()) {
  return handler(new Request(`${origin}/api/admin/account`, { headers: { cookie: jar } }));
}

before(async () => {
  if (!databaseUrl) return;
  process.env.DATABASE_URL = databaseUrl;
  setRateLimitStore(new MemoryStore());
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit',
  });
  ({ handleAuth } = await import('../src/auth'));
  ({ createAccountGet } = await import('../src/lib/server/admin/account'));
});

after(async () => { await prisma?.$disconnect(); });

async function enrolled(role: 'ADMIN' | 'SALES' | 'EDITOR' = 'ADMIN') {
  const client = prisma as PrismaClient;
  const plain = authenticator.generateSecret();
  const email = `device-${randomBytes(4).toString('hex')}@example.com`;
  const password = 'correct-horse-battery';
  const row = await client.user.create({
    data: {
      email, name: 'Ada', passwordHash: await hashSecret(password), role,
      totpSecret: encrypt(plain), totpEnabled: true,
    },
  });
  assert.equal(row.passwordlessEnabled, false);
  return { row, email, password, code: () => authenticator.generate(plain) };
}

test('real login binds a device, caps the cookie, and GET account counts once', { skip, timeout: 120_000 }, async () => {
  const client = prisma as PrismaClient;
  const member = await enrolled();
  const signed = await login(member.email, member.password, member.code());
  assert.equal(signed.jar.includes(`${sessionName}=`), true);
  const age = maxAge(signed.response, sessionName);
  assert.ok(age !== null && age > 7_000 && age < 7_200);
  const token = signed.jar.split('; ').find((part) => part.startsWith(`${sessionName}=`))?.slice(sessionName.length + 1);
  const decoded = await decode({ token, secret, salt: sessionName });
  const stored = await client.adminDeviceSession.findFirst({ where: { userId: member.row.id } });
  assert.ok(stored);
  assert.equal(stored.remembered, false);
  assert.equal(stored.absoluteExpiresAt, null);
  assert.equal(stored.sessionVersion, member.row.sessionVersion);
  assert.equal(Buffer.from(stored.id, 'base64url').length, 24);
  assert.equal(decoded?.sid, stored.id);
  assert.ok(typeof decoded?.exp === 'number' && decoded.exp * 1000 <= stored.lastActivityAt.getTime() + ADMIN_SESSION_POLICY.idleMs);

  await client.apiDailyCounter.deleteMany({ where: { routeId: 'GET /api/admin/account' } });
  const bodyResponse = await account(signed.jar);
  const body = await bodyResponse.json() as { role: string; passwordlessEnabled: boolean; currentDevice: { id: string; absoluteExpiresAt: string | null; effectiveExpiresAt: string } };
  assert.equal(bodyResponse.status, 200);
  assert.equal(body.passwordlessEnabled, false);
  assert.equal(body.currentDevice.id, stored.id);
  assert.equal(body.currentDevice.absoluteExpiresAt, null);
  assert.equal(body.role, 'ADMIN');
  const counted = await client.apiDailyCounter.findFirst({ where: { routeId: 'GET /api/admin/account' } });
  assert.equal(counted?.requestCount, 1);
  assert.equal(counted?.errorCount, 0);

  await client.user.update({ where: { id: member.row.id }, data: { role: 'EDITOR' } });
  const sessionResponse = await handleAuth(new Request(`${origin}/api/auth/session`, { headers: { cookie: signed.jar } }));
  const session = await sessionResponse.json() as { user: { role: string } };
  const again = await account(signed.jar);
  const againBody = await again.json() as { role: string };
  assert.equal(session.user.role, 'EDITOR');
  assert.equal(againBody.role, 'EDITOR');
  const reread = await client.adminDeviceSession.findUnique({ where: { id: stored.id } });
  assert.equal(reread?.lastActivityAt.getTime(), stored.lastActivityAt.getTime());

  const failing = createApiCounter({
    db: { siteSetting: { findUnique: async () => null }, $executeRaw: async () => { throw new Error('counter down') } } as unknown as ApiCounterDb,
    log: () => { throw new Error('log down'); },
  });
  const preserved = await createAccountGet({ record: (response) => failing.recordFinalResponse(response) })(
    new Request(`${origin}/api/admin/account`, { headers: { cookie: signed.jar } }),
  );
  const preservedBody = await preserved.json() as { currentDevice: { id: string } };
  assert.equal(preserved.status, 200);
  assert.equal(preservedBody.currentDevice.id, stored.id);

  const broken = createAccountGet({
    authorize: async () => { throw new Error('controlled private failure'); },
    record: (response) => createApiCounter({ db: client, clock: () => new Date('2026-07-04T03:00:00.000Z') }).recordFinalResponse(response),
  });
  const failed = await broken(new Request(`${origin}/api/admin/account`));
  const failedBody = await failed.json() as { error: string };
  assert.equal(failed.status, 500);
  assert.equal(failedBody.error, 'internal_error');
  assert.equal(JSON.stringify(failedBody).includes('controlled private'), false);
  const errors = await client.apiDailyCounter.findFirst({
    where: { routeId: 'GET /api/admin/account', localDate: '2026-07-04' },
  });
  assert.equal(errors?.requestCount, 1);
  assert.equal(errors?.errorCount, 1);
});

test('remembered login uses the 7 day idle cap and a false literal does not', { skip, timeout: 120_000 }, async () => {
  const client = prisma as PrismaClient;
  const remembered = await enrolled();
  const signed = await login(remembered.email, remembered.password, remembered.code(), 'true');
  const age = maxAge(signed.response, sessionName);
  assert.ok(age !== null && age > 600_000 && age < ADMIN_SESSION_POLICY.rememberedIdleMs / 1000);
  const row = await client.adminDeviceSession.findFirst({ where: { userId: remembered.row.id } });
  assert.equal(row?.remembered, true);
  assert.equal(row?.absoluteExpiresAt?.getTime(), (row?.createdAt.getTime() ?? 0) + ADMIN_SESSION_POLICY.absoluteMs);

  const plain = await enrolled();
  const before = await client.adminDeviceSession.count({ where: { userId: plain.row.id } });
  const rejected = await login(plain.email, plain.password, plain.code(), 'yes');
  assert.equal(rejected.jar.includes(`${sessionName}=`), false);
  assert.equal(await client.adminDeviceSession.count({ where: { userId: plain.row.id } }), before);
  const ordinary = await login(plain.email, plain.password, plain.code(), 'false');
  const ordinaryRow = await client.adminDeviceSession.findFirst({ where: { userId: plain.row.id } });
  assert.equal(ordinary.jar.includes(`${sessionName}=`), true);
  assert.equal(ordinaryRow?.remembered, false);
  assert.equal(ordinaryRow?.absoluteExpiresAt, null);
});

test('sign-out revokes the device, an old cookie is 401, and expiry or a sid-less JWT cannot pass', { skip, timeout: 120_000 }, async () => {
  const client = prisma as PrismaClient;
  const member = await enrolled();
  const signed = await login(member.email, member.password, member.code());
  const copied = signed.jar;
  const first = await account(copied);
  assert.equal(first.status, 200);
  const csrfToken = await csrf(copied);
  const signedOut = await handleAuth(new Request(`${origin}/api/auth/signout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrfToken.jar, origin },
    body: new URLSearchParams({ csrfToken: csrfToken.token, callbackUrl: `${origin}/admin` }),
  }));
  assert.equal(signedOut.status === 503, false);
  assert.match(signedOut.headers.getSetCookie().join('\n'), /authjs\.session-token=;/);
  const stored = await client.adminDeviceSession.findFirst({ where: { userId: member.row.id } });
  assert.ok(stored?.revokedAt);
  const replay = await account(copied);
  assert.equal(replay.status, 401);

  const fresh = await enrolled();
  const next = await login(fresh.email, fresh.password, fresh.code());
  const live = await client.adminDeviceSession.findFirstOrThrow({ where: { userId: fresh.row.id } });
  await client.adminDeviceSession.update({
    where: { id: live.id },
    data: { lastActivityAt: new Date(Date.now() - ADMIN_SESSION_POLICY.idleMs - 5_000) },
  });
  assert.equal((await account(next.jar)).status, 401);
  await client.user.update({ where: { id: fresh.row.id }, data: { sessionVersion: { increment: 1 } } });
  const replaced = await client.adminDeviceSession.findFirstOrThrow({ where: { userId: fresh.row.id } });
  await client.adminDeviceSession.update({
    where: { id: replaced.id },
    data: { lastActivityAt: new Date(), revokedAt: null },
  });
  assert.equal((await account(next.jar)).status, 401);

  const { encode } = await import('next-auth/jwt');
  const legacy = await encode({ token: { uid: member.row.id, sv: member.row.sessionVersion, role: 'ADMIN' }, secret, salt: sessionName, maxAge: 3600 });
  const legacyAccount = await account(`${sessionName}=${legacy}`);
  assert.equal(legacyAccount.status, 401);
  const legacySession = await handleAuth(new Request(`${origin}/api/auth/session`, { headers: { cookie: `${sessionName}=${legacy}` } }));
  const legacyBody = await legacySession.json();
  assert.equal(legacyBody, null);
});


test('invalid device wins over an excluded route role', { skip, timeout: 120_000 }, async () => {
  const client = prisma as PrismaClient;
  const member = await enrolled('SALES');
  const signed = await login(member.email, member.password, member.code());
  const stored = await client.adminDeviceSession.findFirstOrThrow({ where: { userId: member.row.id } });
  const { requireAdmin } = await import('../src/lib/server/admin/guard');
  const validDenied = await requireAdmin(new Request(`${origin}/api/admin/users`, { headers: { cookie: signed.jar } }), ['ADMIN']);
  assert.ok(validDenied instanceof Response);
  assert.equal(validDenied.status, 403);
  assert.equal(validDenied.headers.getSetCookie().length, 0);
  await client.adminDeviceSession.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
  const invalidDenied = await requireAdmin(new Request(`${origin}/api/admin/users`, { headers: { cookie: signed.jar } }), ['ADMIN']);
  assert.ok(invalidDenied instanceof Response);
  assert.equal(invalidDenied.status, 401);
  assert.match(invalidDenied.headers.getSetCookie().join('\n'), /authjs\.session-token=;.*Max-Age=0/);
  const { deviceServiceFor } = await import('../src/lib/server/admin/device-session');
  const service = deviceServiceFor(client, () => new Date(), ADMIN_SESSION_POLICY);
  const denied = await service.authenticate({ userId: member.row.id, sessionVersion: member.row.sessionVersion, sid: stored.id, roles: ['ADMIN'] });
  assert.deepEqual(denied, { ok: false, reason: 'unauthenticated', status: 401 });
  const replay = await account(signed.jar);
  assert.equal(replay.status, 401);
  assert.match(replay.headers.getSetCookie().join('\n'), /authjs\.session-token=;.*Max-Age=0/);
});

test('late device revocation preserves a newer real Credentials login', { skip, timeout: 120_000 }, async () => {
  const client = prisma as PrismaClient;
  const member = await enrolled();
  const oldLogin = await login(member.email, member.password, member.code());
  const oldDevice = await client.adminDeviceSession.findFirstOrThrow({ where: { userId: member.row.id } });
  const committed = await client.user.update({ where: { id: member.row.id }, data: { sessionVersion: { increment: 1 } } });
  const { decrypt } = await import('../src/lib/server/admin/crypto');
  const nextCode = authenticator.clone({ epoch: Date.now() + 30_000 }).generate(decrypt(committed.totpSecret!));
  const freshLogin = await login(member.email, member.password, nextCode);
  assert.equal(freshLogin.jar.includes(`${sessionName}=`), true);
  const freshDevice = await client.adminDeviceSession.findFirstOrThrow({ where: { userId: member.row.id, sessionVersion: committed.sessionVersion } });
  const { revokeUserDevices } = await import('../src/lib/server/admin/device-repo');
  await revokeUserDevices(client, member.row.id, 'session_bumped', committed.sessionVersion);
  const oldAfter = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: oldDevice.id } });
  const freshAfter = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: freshDevice.id } });
  assert.ok(oldAfter.revokedAt);
  assert.equal(freshAfter.revokedAt, null);
  assert.equal((await account(oldLogin.jar)).status, 401);
  assert.equal((await account(freshLogin.jar)).status, 200);
});
