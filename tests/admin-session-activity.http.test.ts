import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient, type AdminDeviceSession, type User } from '@prisma/client';
import { authenticator } from 'otplib';
import { decode, encode } from 'next-auth/jwt';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';
import {
  backfillHardExpiresAt,
  decideAdminAccess,
  deviceServiceFor,
  expiryBounds,
} from '../src/lib/server/admin/device-session';
import {
  activityWriteAllowed,
  enforcedAbsolute,
  initialHardExpiresAt,
} from '../src/lib/server/admin/session-expiry';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

if (typeof globalThis.AsyncLocalStorage !== 'function') {
  Object.defineProperty(globalThis, 'AsyncLocalStorage', { value: AsyncLocalStorage, configurable: true, writable: true });
}

const policy = ADMIN_SESSION_POLICY;
const databaseUrl = process.env.ADMIN_DEVICE_TEST_DATABASE_URL?.startsWith('postgres')
  ? process.env.ADMIN_DEVICE_TEST_DATABASE_URL
  : '';
const skip = !databaseUrl && 'no dedicated ADMIN_DEVICE_TEST_DATABASE_URL';
const secret = process.env.AUTH_SECRET || 'activity-session-test-secret-32b';
process.env.AUTH_SECRET = secret;
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 7).toString('base64');
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const origin = 'http://127.0.0.1:3000';
const sessionName = 'authjs.session-token';
const area = ['ADMIN', 'SALES', 'EDITOR'] as const;
const created = new Date('2026-06-01T00:00:00.000Z');

let handleAuth: (request: Request) => Promise<Response> = async () => { throw new Error('auth not loaded'); };
let auth: () => Promise<{ user?: { id?: string }; expires?: string } | null> = async () => null;
let postActivity: (request: Request) => Promise<Response> = async () => { throw new Error('activity not loaded'); };
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

function sessionPair(jar: string): string | undefined {
  return jar.split('; ').find((part) => part.startsWith(`${sessionName}=`));
}

function liveCookie(response: Response): string | undefined {
  return response.headers.getSetCookie().find((item) => item.startsWith(`${sessionName}=`) && !item.includes(`${sessionName}=;`));
}

function user(over: Partial<User> = {}): User {
  return {
    id: 'user-1', email: 'ada@example.com', name: 'Ada', passwordHash: 'h', role: 'ADMIN',
    totpSecret: 's', totpEnabled: true, totpLastStep: null, recoveryCodes: [], sessionVersion: 3,
    passwordlessEnabled: false, disabled: false, failedLogins: 0, lockedUntil: null, lastLoginAt: null,
    reactivatedAt: null, enrollIssuedAt: null, totpPendingUntil: null, totpEnrollFails: 0,
    enrollTokenHash: null, enrollTokenExpiresAt: null, createdAt: created, ...over,
  } as User;
}

function device(over: Partial<AdminDeviceSession> = {}): AdminDeviceSession {
  return {
    id: 'device-1', userId: 'user-1', sessionVersion: 3, remembered: false, createdAt: created,
    lastActivityAt: created, absoluteExpiresAt: null, hardExpiresAt: null, revokedAt: null,
    revokedReason: null, deviceLabel: null, ...over,
  } as AdminDeviceSession;
}

function access(now: Date, row = device(), account = user()) {
  return decideAdminAccess({
    userId: account.id, sessionVersion: account.sessionVersion, sid: row.id, user: account, device: row,
    roles: area, now, policy,
  });
}

test('ordinary and remembered caps are fixed on the device row and equal the deadline', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: { 'next-auth': string } };
  assert.equal(pkg.dependencies['next-auth'], '5.0.0-beta.32');
  assert.equal(initialHardExpiresAt(created, false, policy).getTime() - created.getTime(), policy.ordinaryAbsoluteMs);
  assert.equal(initialHardExpiresAt(created, true, policy).getTime() - created.getTime(), policy.absoluteMs);

  const ordinary = device({
    hardExpiresAt: initialHardExpiresAt(created, false, policy),
    lastActivityAt: new Date(created.getTime() + 11 * 60 * 60_000),
  });
  const ordinaryBounds = expiryBounds(ordinary, policy);
  assert.equal(ordinaryBounds.absoluteExpiresAt, null);
  assert.equal(ordinaryBounds.effectiveExpiresAt.toISOString(), ordinary.hardExpiresAt?.toISOString());
  assert.equal(access(new Date(ordinary.hardExpiresAt!.getTime() - 1), ordinary).ok, true);
  assert.equal(access(ordinary.hardExpiresAt!, ordinary).ok, false);

  const legacy = device({ lastActivityAt: ordinary.lastActivityAt });
  assert.equal(enforcedAbsolute(legacy, policy).toISOString(), ordinary.hardExpiresAt?.toISOString());

  const stretched = device({
    hardExpiresAt: new Date(created.getTime() + policy.absoluteMs),
    lastActivityAt: ordinary.lastActivityAt,
  });
  assert.equal(expiryBounds(stretched, policy).effectiveExpiresAt.toISOString(), ordinary.hardExpiresAt?.toISOString());
  assert.equal(expiryBounds(stretched, policy).absoluteExpiresAt, null);

  const remembered = device({
    remembered: true,
    absoluteExpiresAt: initialHardExpiresAt(created, true, policy),
    hardExpiresAt: initialHardExpiresAt(created, true, policy),
    lastActivityAt: new Date(created.getTime() + 29 * 24 * 60 * 60_000),
  });
  const rememberedBounds = expiryBounds(remembered, policy);
  assert.equal(rememberedBounds.absoluteExpiresAt?.toISOString(), remembered.hardExpiresAt?.toISOString());
  assert.equal(rememberedBounds.effectiveExpiresAt.toISOString(), remembered.hardExpiresAt?.toISOString());
  assert.equal(access(new Date(remembered.hardExpiresAt!.getTime() - 1), remembered).ok, true);
  assert.equal(access(remembered.hardExpiresAt!, remembered).ok, false);
  assert.equal(access(created, device({ revokedAt: created, hardExpiresAt: ordinary.hardExpiresAt })).ok, false);
  assert.equal(activityWriteAllowed(created, new Date(created.getTime() + policy.activityThrottleMs - 1), policy.activityThrottleMs), false);
  assert.equal(activityWriteAllowed(created, new Date(created.getTime() + policy.activityThrottleMs), policy.activityThrottleMs), true);
});

before(async () => {
  if (!databaseUrl) return;
  process.env.DATABASE_URL = databaseUrl;
  setRateLimitStore(new MemoryStore());
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
    });
  } catch {
    throw new Error('prisma db push failed');
  }
  ({ handleAuth, auth } = await import('../src/auth'));
  ({ POST: postActivity } = await import('../src/app/api/admin/account/session/activity/route'));
  ({ createAccountGet } = await import('../src/lib/server/admin/account'));
}, { timeout: 180_000 });

after(async () => { await prisma?.$disconnect(); });

async function enrolled(role: 'ADMIN' | 'SALES' | 'EDITOR' = 'ADMIN') {
  const client = prisma as PrismaClient;
  const plain = authenticator.generateSecret();
  const email = `activity-${randomBytes(4).toString('hex')}@example.com`;
  const password = 'correct-horse-battery';
  const row = await client.user.create({
    data: { email, name: 'Ada', passwordHash: await hashSecret(password), role, totpSecret: encrypt(plain), totpEnabled: true },
  });
  return { row, email, password, code: () => authenticator.generate(plain) };
}

async function login(email: string, password: string, totp: string, rememberDevice?: string) {
  const first = await handleAuth(new Request(`${origin}/api/auth/csrf`, { headers: { cookie: '' } }));
  const body = await first.json() as { csrfToken: string };
  const jar = cookieJar(first);
  const form = new URLSearchParams({ email, password, totp, csrfToken: body.csrfToken, callbackUrl: `${origin}/admin` });
  if (rememberDevice !== undefined) form.set('rememberDevice', rememberDevice);
  const response = await handleAuth(new Request(`${origin}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar, origin },
    body: form,
  }));
  return { response, jar: cookieJar(response, jar) };
}

function account(jar: string) {
  return createAccountGet()(new Request(`${origin}/api/admin/account`, { headers: { cookie: jar } }));
}

function activity(jar: string, body = '{}') {
  return postActivity(new Request(`${origin}/api/admin/account/session/activity`, {
    method: 'POST',
    headers: { cookie: jar, origin, 'content-type': 'application/json' },
    body,
  }));
}

async function ssrSession(cookie: string) {
  const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external.js');
  const { workUnitAsyncStorage } = await import('next/dist/server/app-render/work-unit-async-storage.external.js');
  const { HeadersAdapter } = await import('next/dist/server/web/spec-extension/adapters/headers.js');
  const headers = HeadersAdapter.seal(new Headers({
    cookie,
    host: '127.0.0.1:3000',
    'x-forwarded-host': '127.0.0.1:3000',
    'x-forwarded-proto': 'http',
  }));
  const work = { isStaticGeneration: false, page: '/admin/users/page', route: '/admin/users', forceStatic: false };
  const unit = { type: 'request' as const, phase: 'render' as const, headers, implicitTags: { tags: [] } };
  // headers() 在 request 阶段只读 route、forceStatic、phase、type 和 headers。其余 WorkStore 字段这次调用碰不到。
  return workAsyncStorage.run(work as never, () => workUnitAsyncStorage.run(unit as never, () => auth()));
}

test('real activity refreshes the cookie, reads do not, and the four Auth.js paths share one beta', { skip, timeout: 180_000 }, async () => {
  const client = prisma as PrismaClient;
  const member = await enrolled();
  const signed = await login(member.email, member.password, member.code());
  const freshCookie = liveCookie(signed.response);
  assert.ok(freshCookie);
  assert.match(freshCookie, /HttpOnly/i);
  assert.match(freshCookie, /SameSite=Lax/i);
  assert.equal(freshCookie.includes('Secure'), false);
  assert.equal(freshCookie.startsWith('__Secure-'), false);
  const stored = await client.adminDeviceSession.findFirstOrThrow({ where: { userId: member.row.id } });
  assert.equal(stored.remembered, false);
  assert.equal(stored.absoluteExpiresAt, null);
  assert.equal(stored.hardExpiresAt?.getTime(), stored.createdAt.getTime() + policy.ordinaryAbsoluteMs);
  const token = sessionPair(signed.jar)?.slice(sessionName.length + 1);
  const decoded = await decode({ token, secret, salt: sessionName });
  assert.equal(decoded?.authTime, stored.createdAt.toISOString());
  assert.equal(decoded?.absoluteExpiresAt, null);
  assert.ok(typeof decoded?.exp === 'number' && decoded.exp * 1000 <= stored.hardExpiresAt!.getTime());

  const omitted = await enrolled();
  const plain = await login(omitted.email, omitted.password, omitted.code());
  const literalFalse = await enrolled();
  const ordinary = await login(literalFalse.email, literalFalse.password, literalFalse.code(), 'false');
  for (const rowId of [omitted.row.id, literalFalse.row.id]) {
    const row = await client.adminDeviceSession.findFirstOrThrow({ where: { userId: rowId } });
    assert.equal(row.remembered, false);
    assert.equal(row.absoluteExpiresAt, null);
    assert.equal(row.hardExpiresAt?.getTime(), row.createdAt.getTime() + policy.ordinaryAbsoluteMs);
  }
  assert.ok(plain.jar.includes(`${sessionName}=`));
  assert.ok(ordinary.jar.includes(`${sessionName}=`));

  const beforeRead = stored.lastActivityAt.getTime();
  assert.equal((await account(signed.jar)).status, 200);
  const sessionRead = await handleAuth(new Request(`${origin}/api/auth/session`, { headers: { cookie: signed.jar } }));
  assert.equal(sessionRead.status, 200);
  assert.equal((await client.adminDeviceSession.findUniqueOrThrow({ where: { id: stored.id } })).lastActivityAt.getTime(), beforeRead);

  const tooSoon = await activity(signed.jar);
  const tooSoonBody = await tooSoon.json() as { effectiveExpiresAt: string; absoluteExpiresAt: string | null; error?: string };
  assert.equal(tooSoon.status, 200);
  assert.equal(tooSoonBody.absoluteExpiresAt, null);
  assert.ok(Number(tooSoon.headers.get('retry-after')) >= 1);
  assert.equal((await client.adminDeviceSession.findUniqueOrThrow({ where: { id: stored.id } })).lastActivityAt.getTime(), beforeRead);

  await client.adminDeviceSession.update({
    where: { id: stored.id },
    data: { lastActivityAt: new Date(Date.now() - policy.activityThrottleMs - 1_000) },
  });
  const renewed = await activity(signed.jar);
  const renewedBody = await renewed.json() as { effectiveExpiresAt: string; absoluteExpiresAt: string | null };
  assert.equal(renewed.status, 200);
  assert.equal(renewedBody.absoluteExpiresAt, null);
  const renewedCookie = liveCookie(renewed);
  assert.ok(renewedCookie);
  assert.match(renewedCookie, /HttpOnly/i);
  assert.match(renewedCookie, /SameSite=Lax/i);
  const moved = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: stored.id } });
  assert.ok(moved.lastActivityAt.getTime() > beforeRead);
  assert.equal(moved.hardExpiresAt?.getTime(), stored.hardExpiresAt?.getTime());
  assert.equal(renewedBody.effectiveExpiresAt, new Date(moved.lastActivityAt.getTime() + policy.idleMs).toISOString());
  const renewedJar = cookieJar(renewed, signed.jar);
  const renewedToken = sessionPair(renewedJar)?.slice(sessionName.length + 1);
  const renewedDecoded = await decode({ token: renewedToken, secret, salt: sessionName });
  assert.equal(renewedDecoded?.authTime, stored.createdAt.toISOString());
  assert.ok(typeof renewedDecoded?.exp === 'number' && renewedDecoded.exp * 1000 <= Date.parse(renewedBody.effectiveExpiresAt));
  assert.ok(renewedDecoded.exp * 1000 <= moved.hardExpiresAt!.getTime());
  const checked = await account(renewedJar);
  const checkedBody = await checked.json() as { currentDevice: { effectiveExpiresAt: string; absoluteExpiresAt: string | null; lastActivityAt: string } };
  assert.equal(checked.status, 200);
  assert.equal(checkedBody.currentDevice.effectiveExpiresAt, renewedBody.effectiveExpiresAt);
  assert.equal(checkedBody.currentDevice.absoluteExpiresAt, null);
  assert.equal(checkedBody.currentDevice.lastActivityAt, moved.lastActivityAt.toISOString());
  const invalid = await activity(renewedJar, '{"extra":true}');
  assert.equal(invalid.status, 400);
  const noOrigin = await postActivity(new Request(`${origin}/api/admin/account/session/activity`, {
    method: 'POST', headers: { cookie: renewedJar, 'content-type': 'application/json' }, body: '{}',
  }));
  assert.equal(noOrigin.status, 403);
  assert.equal((await client.adminDeviceSession.findUniqueOrThrow({ where: { id: stored.id } })).lastActivityAt.getTime(), moved.lastActivityAt.getTime());

  const rendered = await ssrSession(renewedJar);
  assert.equal(rendered?.user?.id, member.row.id);
  assert.equal((await client.adminDeviceSession.findUniqueOrThrow({ where: { id: stored.id } })).lastActivityAt.getTime(), moved.lastActivityAt.getTime());
  assert.equal((await account(renewedJar)).status, 200);

  const past = new Date(Date.now() - 1_000);
  const forged = await encode({
    secret, salt: sessionName, maxAge: 60 * 60,
    token: { uid: member.row.id, sid: stored.id, sv: member.row.sessionVersion, role: 'ADMIN', authTime: '2099-01-01T00:00:00.000Z', sub: member.row.id },
  });
  await client.adminDeviceSession.update({ where: { id: stored.id }, data: { hardExpiresAt: past } });
  const rejected = await account(`${sessionName}=${forged}`);
  assert.equal(rejected.status, 401);
  const untouched = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: stored.id } });
  assert.equal(untouched.lastActivityAt.getTime(), moved.lastActivityAt.getTime());
  assert.equal(untouched.hardExpiresAt?.getTime(), past.getTime());
});

test('continuous activity still dies at the stored 12h and 30d caps and a revoked row stays dead', { skip, timeout: 180_000 }, async () => {
  const client = prisma as PrismaClient;
  let now = new Date('2026-04-01T00:00:00.000Z');
  const service = deviceServiceFor(client, () => now, policy);
  const ordinaryUser = await enrolled();
  const opened = await service.open({ userId: ordinaryUser.row.id, sessionVersion: ordinaryUser.row.sessionVersion, remembered: false, userAgent: 'Mozilla/5.0 Chrome/120.0.0.0 Windows' });
  assert.equal(opened.absoluteExpiresAt, null);
  assert.equal(opened.hardExpiresAt?.getTime(), opened.createdAt.getTime() + policy.ordinaryAbsoluteMs);
  now = new Date(opened.createdAt.getTime() + policy.activityThrottleMs);
  const wrote = await service.recordActivity({ userId: ordinaryUser.row.id, sessionVersion: ordinaryUser.row.sessionVersion, sid: opened.id });
  assert.equal(wrote.ok && wrote.wrote, true);
  if (!wrote.ok) return;
  assert.equal(wrote.device.hardExpiresAt?.getTime(), opened.hardExpiresAt?.getTime());
  now = new Date(opened.createdAt.getTime() + policy.ordinaryAbsoluteMs - 1);
  await client.adminDeviceSession.update({
    where: { id: opened.id },
    data: { lastActivityAt: new Date(now.getTime() - policy.activityThrottleMs) },
  });
  const still = await service.recordActivity({ userId: ordinaryUser.row.id, sessionVersion: ordinaryUser.row.sessionVersion, sid: opened.id });
  assert.equal(still.ok && still.wrote, true);
  if (!still.ok) return;
  assert.equal(still.bounds.effectiveExpiresAt.toISOString(), opened.hardExpiresAt?.toISOString());
  assert.equal(still.bounds.absoluteExpiresAt, null);
  const advanced = still.device.lastActivityAt.getTime();
  now = new Date(opened.hardExpiresAt!.getTime());
  const expired = await service.recordActivity({ userId: ordinaryUser.row.id, sessionVersion: ordinaryUser.row.sessionVersion, sid: opened.id });
  assert.equal(expired.ok, false);
  const afterCap = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: opened.id } });
  assert.equal(afterCap.lastActivityAt.getTime(), advanced);
  assert.equal(afterCap.revokedAt, null);

  const rememberedUser = await enrolled();
  now = new Date('2026-05-01T00:00:00.000Z');
  const remembered = await service.open({ userId: rememberedUser.row.id, sessionVersion: rememberedUser.row.sessionVersion, remembered: true, userAgent: null });
  assert.equal(remembered.absoluteExpiresAt?.getTime(), remembered.createdAt.getTime() + policy.absoluteMs);
  assert.equal(remembered.hardExpiresAt?.getTime(), remembered.absoluteExpiresAt?.getTime());
  now = new Date(remembered.createdAt.getTime() + 29 * 24 * 60 * 60_000);
  await client.adminDeviceSession.update({ where: { id: remembered.id }, data: { lastActivityAt: new Date(now.getTime() - policy.activityThrottleMs) } });
  const near = await service.recordActivity({ userId: rememberedUser.row.id, sessionVersion: rememberedUser.row.sessionVersion, sid: remembered.id });
  assert.equal(near.ok && near.wrote, true);
  if (!near.ok) return;
  assert.equal(near.bounds.effectiveExpiresAt.toISOString(), remembered.hardExpiresAt?.toISOString());
  assert.equal(near.device.hardExpiresAt?.getTime(), remembered.hardExpiresAt?.getTime());
  const rememberedActivity = near.device.lastActivityAt.getTime();
  now = new Date(remembered.hardExpiresAt!.getTime());
  const pastAbsolute = await service.recordActivity({ userId: rememberedUser.row.id, sessionVersion: rememberedUser.row.sessionVersion, sid: remembered.id });
  assert.equal(pastAbsolute.ok, false);
  assert.equal((await client.adminDeviceSession.findUniqueOrThrow({ where: { id: remembered.id } })).lastActivityAt.getTime(), rememberedActivity);

  now = new Date(opened.createdAt.getTime() + 60 * 60_000);
  await client.adminDeviceSession.update({
    where: { id: opened.id },
    data: { revokedAt: null, lastActivityAt: new Date(now.getTime() - policy.activityThrottleMs), hardExpiresAt: opened.hardExpiresAt },
  });
  await service.revokeSid(opened.id, 'sign_out');
  const revived = await service.recordActivity({ userId: ordinaryUser.row.id, sessionVersion: ordinaryUser.row.sessionVersion, sid: opened.id });
  assert.equal(revived.ok, false);
  const dead = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: opened.id } });
  assert.ok(dead.revokedAt);
  assert.equal(dead.lastActivityAt.getTime(), now.getTime() - policy.activityThrottleMs);
});

test('activity HTTP rejects equality, keeps revocation dead, and replays a copied cookie only while the row allows it', { skip, timeout: 180_000 }, async () => {
  const client = prisma as PrismaClient;
  const member = await enrolled();
  const signed = await login(member.email, member.password, member.code(), 'true');
  const row = await client.adminDeviceSession.findFirstOrThrow({ where: { userId: member.row.id } });
  assert.equal(row.hardExpiresAt?.getTime(), row.createdAt.getTime() + policy.absoluteMs);
  const copied = signed.jar;
  assert.equal((await account(copied)).status, 200);

  const idleAt = new Date(Date.now() - policy.rememberedIdleMs);
  await client.adminDeviceSession.update({ where: { id: row.id }, data: { lastActivityAt: idleAt } });
  const idle = await activity(copied);
  assert.equal(idle.status, 401);
  assert.match(idle.headers.getSetCookie().join('\n'), /Max-Age=0/i);
  assert.equal((await client.adminDeviceSession.findUniqueOrThrow({ where: { id: row.id } })).lastActivityAt.getTime(), idleAt.getTime());

  const recent = new Date(Date.now() - 60_000);
  const capAt = new Date();
  await client.adminDeviceSession.update({ where: { id: row.id }, data: { lastActivityAt: recent, hardExpiresAt: capAt } });
  const atCap = await activity(copied);
  assert.equal(atCap.status, 401);
  const capped = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(capped.lastActivityAt.getTime(), recent.getTime());
  assert.equal(capped.hardExpiresAt?.toISOString(), capAt.toISOString());

  await client.adminDeviceSession.update({
    where: { id: row.id },
    data: { lastActivityAt: recent, hardExpiresAt: row.hardExpiresAt, revokedAt: new Date() },
  });
  const late = await activity(copied);
  assert.equal(late.status, 401);
  const still = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(still.revokedAt);
  assert.equal(still.lastActivityAt.getTime(), recent.getTime());
  assert.equal((await account(copied)).status, 401);

  const next = await enrolled();
  const again = await login(next.email, next.password, next.code());
  const live = await client.adminDeviceSession.findFirstOrThrow({ where: { userId: next.row.id } });
  const reopened = again.jar;
  assert.equal((await account(reopened)).status, 200);
  await client.user.update({ where: { id: next.row.id }, data: { disabled: true } });
  const disabled = await activity(reopened);
  assert.equal(disabled.status, 403);
  assert.equal((await client.adminDeviceSession.findUniqueOrThrow({ where: { id: live.id } })).lastActivityAt.getTime(), live.lastActivityAt.getTime());
  await client.user.update({ where: { id: next.row.id }, data: { disabled: false, totpEnabled: false } });
  const noTotp = await activity(reopened);
  assert.equal(noTotp.status, 401);
  await client.user.update({ where: { id: next.row.id }, data: { totpEnabled: true, sessionVersion: { increment: 1 } } });
  const bumped = await activity(reopened);
  assert.equal(bumped.status, 401);
  assert.equal((await client.adminDeviceSession.findUniqueOrThrow({ where: { id: live.id } })).lastActivityAt.getTime(), live.lastActivityAt.getTime());

  const closer = await enrolled();
  const closed = await login(closer.email, closer.password, closer.code());
  const device = await client.adminDeviceSession.findFirstOrThrow({ where: { userId: closer.row.id } });
  const held = closed.jar;
  const csrf = await handleAuth(new Request(`${origin}/api/auth/csrf`, { headers: { cookie: held } }));
  const csrfBody = await csrf.json() as { csrfToken: string };
  const signedOut = await handleAuth(new Request(`${origin}/api/auth/signout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieJar(csrf, held), origin },
    body: new URLSearchParams({ csrfToken: csrfBody.csrfToken, callbackUrl: `${origin}/admin` }),
  }));
  assert.equal(signedOut.status === 503, false);
  assert.match(signedOut.headers.getSetCookie().join('\n'), /authjs\.session-token=;/);
  assert.ok((await client.adminDeviceSession.findUniqueOrThrow({ where: { id: device.id } })).revokedAt);
  assert.equal((await account(held)).status, 401);
  const extra = await activity(held, '{"extra":true}');
  assert.equal(extra.status, 401);
});

test('backfill writes only missing hard deadlines and a late refresh loses to a committed revoke', { skip, timeout: 180_000 }, async () => {
  const client = prisma as PrismaClient;
  const ordinaryUser = await enrolled();
  const rememberedUser = await enrolled();
  const anchor = new Date('2026-02-01T00:00:00.000Z');
  const ordinary = await client.adminDeviceSession.create({
    data: {
      id: randomBytes(24).toString('base64url'), userId: ordinaryUser.row.id, sessionVersion: ordinaryUser.row.sessionVersion,
      remembered: false, createdAt: anchor, lastActivityAt: anchor, absoluteExpiresAt: null, hardExpiresAt: null,
    },
  });
  const custom = new Date(anchor.getTime() + 60 * 60_000);
  const kept = await client.adminDeviceSession.create({
    data: {
      id: randomBytes(24).toString('base64url'), userId: ordinaryUser.row.id, sessionVersion: ordinaryUser.row.sessionVersion,
      remembered: false, createdAt: anchor, lastActivityAt: anchor, absoluteExpiresAt: null, hardExpiresAt: custom,
    },
  });
  const rememberedAbsolute = new Date(anchor.getTime() + policy.absoluteMs);
  const remembered = await client.adminDeviceSession.create({
    data: {
      id: randomBytes(24).toString('base64url'), userId: rememberedUser.row.id, sessionVersion: rememberedUser.row.sessionVersion,
      remembered: true, createdAt: anchor, lastActivityAt: anchor, absoluteExpiresAt: rememberedAbsolute, hardExpiresAt: null,
    },
  });
  const filled = await backfillHardExpiresAt(client, policy);
  assert.ok(filled.ordinary >= 1);
  assert.ok(filled.remembered >= 1);
  const ordinaryRow = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: ordinary.id } });
  const keptRow = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: kept.id } });
  const rememberedRow = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: remembered.id } });
  assert.equal(ordinaryRow.hardExpiresAt?.toISOString(), new Date(anchor.getTime() + policy.ordinaryAbsoluteMs).toISOString());
  assert.equal(ordinaryRow.absoluteExpiresAt, null);
  assert.equal(keptRow.hardExpiresAt?.toISOString(), custom.toISOString());
  assert.equal(rememberedRow.hardExpiresAt?.toISOString(), rememberedAbsolute.toISOString());
  assert.equal(rememberedRow.absoluteExpiresAt?.toISOString(), rememberedAbsolute.toISOString());
  const again = await backfillHardExpiresAt(client, policy);
  assert.equal(again.ordinary, 0);
  assert.equal(again.remembered, 0);

  let release: () => void = () => {};
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  let locked: () => void = () => {};
  const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
  const locking = client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "AdminDeviceSession" WHERE "id" = ${remembered.id} FOR UPDATE`;
    locked();
    await releasePromise;
    await tx.adminDeviceSession.update({ where: { id: remembered.id }, data: { revokedAt: new Date(), revokedReason: 'race' } });
  }, { maxWait: 5_000, timeout: 20_000 });
  await lockedPromise;
  const service = deviceServiceFor(client, () => new Date(anchor.getTime() + policy.activityThrottleMs), policy);
  const late = service.recordActivity({ userId: rememberedUser.row.id, sessionVersion: rememberedUser.row.sessionVersion, sid: remembered.id });
  release();
  const result = await late;
  await locking;
  assert.equal(result.ok, false);
  const raced = await client.adminDeviceSession.findUniqueOrThrow({ where: { id: remembered.id } });
  assert.ok(raced.revokedAt);
  assert.equal(raced.lastActivityAt.getTime(), anchor.getTime());
});
