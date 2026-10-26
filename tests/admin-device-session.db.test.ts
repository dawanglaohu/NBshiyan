import { RequestCookies, ResponseCookies } from 'next/dist/server/web/spec-extension/cookies';
import { MutableRequestCookiesAdapter, appendMutableCookies } from 'next/dist/server/web/spec-extension/adapters/request-cookies';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdminDeviceSession, User } from '@prisma/client';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';
import type { DeviceRepo } from '../src/lib/server/admin/device-repo';
import { RememberDeviceSchema } from '../src/lib/contracts/account';
import {
  accountDto,
  clearedSessionCookieHeaders,
  coarseDeviceLabel,
  createDeviceSessionService,
  decideAdminAccess,
  expiryBounds,
} from '../src/lib/server/admin/device-session';

const policy = ADMIN_SESSION_POLICY;
const created = new Date('2026-01-01T00:00:00.000Z');
const area = ['ADMIN', 'SALES', 'EDITOR'] as const;

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
    lastActivityAt: created, absoluteExpiresAt: null, revokedAt: null, revokedReason: null, deviceLabel: null,
    ...over,
  } as AdminDeviceSession;
}

function access(now: Date, row = device(), account = user(), sid: string | undefined = row.id) {
  return decideAdminAccess({
    userId: account.id, sessionVersion: account.sessionVersion, sid, user: account, device: sid ? row : null,
    roles: area, now, policy,
  });
}

test('E-01 normal expiry slides from last activity, and an ordinary session also ends 12 hours after creation', () => {
  const active = device({ lastActivityAt: new Date(created.getTime() + 60 * 60_000) });
  const bounds = expiryBounds(active, policy);
  assert.equal(bounds.absoluteExpiresAt, null);
  assert.equal(bounds.effectiveExpiresAt.toISOString(), new Date(active.lastActivityAt.getTime() + policy.idleMs).toISOString());
  assert.notEqual(bounds.effectiveExpiresAt.toISOString(), new Date(created.getTime() + policy.idleMs).toISOString());
  const remembered = device({
    remembered: true,
    lastActivityAt: new Date(created.getTime() + 24 * 24 * 60 * 60_000),
    absoluteExpiresAt: new Date(created.getTime() + policy.absoluteMs),
  });
  const capped = expiryBounds(remembered, policy);
  assert.equal(capped.absoluteExpiresAt?.toISOString(), new Date(created.getTime() + policy.absoluteMs).toISOString());
  assert.equal(capped.effectiveExpiresAt.toISOString(), capped.absoluteExpiresAt?.toISOString());
});

test('E-02 E-69 equality at idle or absolute rejects and one millisecond before allows', () => {
  const idleEnd = new Date(created.getTime() + policy.idleMs);
  assert.equal(access(new Date(idleEnd.getTime() - 1)).ok, true);
  assert.equal(access(idleEnd).ok, false);
  const remembered = device({ remembered: true, absoluteExpiresAt: new Date(created.getTime() + policy.absoluteMs) });
  const idle = new Date(created.getTime() + policy.rememberedIdleMs);
  assert.equal(access(new Date(idle.getTime() - 1), remembered).ok, true);
  assert.equal(access(idle, remembered).ok, false);
  const atAbsolute = device({
    remembered: true,
    lastActivityAt: new Date(created.getTime() + 29 * 24 * 60 * 60_000),
    absoluteExpiresAt: new Date(created.getTime() + policy.absoluteMs),
  });
  const absolute = new Date(created.getTime() + policy.absoluteMs);
  assert.equal(access(new Date(absolute.getTime() - 1), atAbsolute).ok, true);
  assert.equal(access(absolute, atAbsolute).ok, false);
});

test('E-03 E-70 revoked, foreign, stale version, missing sid, disabled, locked and totp are refused', () => {
  assert.equal(access(created, device({ revokedAt: created })).ok, false);
  assert.equal(access(created, device({ userId: 'other' })).ok, false);
  assert.equal(access(created, device({ sessionVersion: 2 })).ok, false);
  const missing = decideAdminAccess({
    userId: 'user-1', sessionVersion: 3, sid: undefined, user: user(), device: null, roles: area, now: created, policy,
  });
  assert.equal(missing.ok, false);
  const disabled = access(created, device(), user({ disabled: true, sessionVersion: 9 }));
  assert.deepEqual(disabled.ok ? null : { reason: disabled.reason, status: disabled.status }, { reason: 'disabled', status: 403 });
  assert.equal(access(created, device(), user({ lockedUntil: new Date(created.getTime() + 1000) })).ok, false);
  assert.equal(access(created, device(), user({ totpEnabled: false })).ok, false);
  const editor = decideAdminAccess({
    userId: 'user-1', sessionVersion: 3, sid: 'device-1', user: user({ role: 'EDITOR' }), device: device(),
    roles: ['ADMIN'], now: created, policy,
  });
  assert.deepEqual(editor.ok ? null : { reason: editor.reason, status: editor.status }, { reason: 'forbidden', status: 403 });
});

test('a revoked row seen on the next call is not served from the first result', async () => {
  let row = device();
  const repo = {
    findUser: async () => user(),
    findDevice: async () => row,
    create: async () => row,
    revokeSid: async () => {},
    revokeUser: async () => {},
    transaction: async <T>(run: (repo: DeviceRepo) => Promise<T>) => run({} as DeviceRepo),
  } satisfies DeviceRepo;
  const service = createDeviceSessionService({ repo, clock: () => created, policy });
  const input = { userId: 'user-1', sessionVersion: 3, sid: 'device-1', roles: area };
  assert.equal((await service.authenticate(input)).ok, true);
  row = device({ revokedAt: created });
  const denied = await service.authenticate(input);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 401);
});

test('authenticate maps a database outage to 503 and any other throw to 500', async () => {
  const repoFor = (fail: () => never) => ({
    findUser: async () => fail(),
    findDevice: async () => fail(),
    create: async () => fail(),
    revokeSid: async () => fail(),
    revokeUser: async () => fail(),
    transaction: async () => fail(),
  } satisfies DeviceRepo);
  const input = { userId: 'user-1', sessionVersion: 3, sid: 'device-1', roles: area };
  const down = await createDeviceSessionService({
    repo: repoFor(() => { throw Object.assign(new Error('database down'), { code: 'P1001' }); }),
    clock: () => created,
    policy,
  }).authenticate(input);
  assert.deepEqual(down, { ok: false, reason: 'unavailable', status: 503 });
  const other = await createDeviceSessionService({
    repo: repoFor(() => { throw new Error('database down'); }),
    clock: () => created,
    policy,
  }).authenticate(input);
  assert.deepEqual(other, { ok: false, reason: 'internal', status: 500 });
  assert.equal(JSON.stringify(other).includes('database down'), false);
});

function activityDb(options: { transactionCalls?: { n: number }; findUser?: () => Promise<User | null>; device?: AdminDeviceSession | null }) {
  return {
    user: { findUnique: options.findUser ?? (async () => user()) },
    adminDeviceSession: { findUnique: async () => (options.device === undefined ? device() : options.device) },
    $transaction: async () => {
      if (options.transactionCalls) options.transactionCalls.n += 1;
      throw new Error('database down');
    },
  };
}

test('a throttled activity read does not lock or write', async () => {
  const transactionCalls = { n: 0 };
  const service = createDeviceSessionService({
    repo: {
      findUser: async () => { throw new Error('repo locked'); },
      findDevice: async () => { throw new Error('repo locked'); },
      create: async () => { throw new Error('repo locked'); },
      revokeSid: async () => { throw new Error('repo locked'); },
      revokeUser: async () => { throw new Error('repo locked'); },
      transaction: async () => { throw new Error('repo locked'); },
    },
    clock: () => new Date(created.getTime() + 1_000),
    policy,
    db: activityDb({ transactionCalls }) as never,
  });
  const result = await service.recordActivity({ userId: 'user-1', sessionVersion: 3, sid: 'device-1' });
  assert.equal(result.ok && result.wrote, false);
  assert.equal(transactionCalls.n, 0);
  assert.equal(JSON.stringify(result).includes('repo locked'), false);
});

test('recordActivity maps a database failure to unavailable and a revoked row stays 401', async () => {
  const downCalls = { n: 0 };
  const down = createDeviceSessionService({
    repo: {
      findUser: async () => user(), findDevice: async () => device(), create: async () => device(),
      revokeSid: async () => {}, revokeUser: async () => {}, transaction: async <T,>() => device() as T,
    },
    clock: () => new Date(created.getTime() + policy.activityThrottleMs),
    policy,
    db: activityDb({ transactionCalls: downCalls }) as never,
  });
  const failed = await down.recordActivity({ userId: 'user-1', sessionVersion: 3, sid: 'device-1' });
  assert.deepEqual(failed, { ok: false, reason: 'unavailable', status: 503 });
  assert.equal(downCalls.n, 1);
  assert.equal(JSON.stringify(failed).includes('database down'), false);

  const revokedCalls = { n: 0 };
  const revoked = createDeviceSessionService({
    repo: {
      findUser: async () => user(), findDevice: async () => device(), create: async () => device(),
      revokeSid: async () => {}, revokeUser: async () => {}, transaction: async <T,>() => device() as T,
    },
    clock: () => created,
    policy,
    db: activityDb({ transactionCalls: revokedCalls, device: device({ revokedAt: created }) }) as never,
  });
  const denied = await revoked.recordActivity({ userId: 'user-1', sessionVersion: 3, sid: 'device-1' });
  assert.deepEqual(denied, { ok: false, reason: 'unauthenticated', status: 401 });
  assert.equal(revokedCalls.n, 0);
});

test('device label keeps a coarse name and the account DTO defaults passwordless to false', () => {
  const raw = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
  const label = coarseDeviceLabel(raw);
  assert.equal(label, 'Chrome / Windows');
  assert.equal(label?.includes('Mozilla'), false);
  const bounds = expiryBounds(device(), policy);
  const dto = accountDto(user(), device({ deviceLabel: label }), bounds);
  assert.equal(dto.passwordlessEnabled, false);
  assert.equal(dto.currentDevice.absoluteExpiresAt, null);
  assert.equal(dto.currentDevice.effectiveExpiresAt, bounds.effectiveExpiresAt.toISOString());
  assert.equal(RememberDeviceSchema.safeParse(true).success, false);
  assert.equal(RememberDeviceSchema.parse('false'), false);
  assert.equal(RememberDeviceSchema.parse('true'), true);
});


test('E-70 invalid devices are unauthenticated before route-specific role denial', () => {
  const invalid = [null, device({ revokedAt: created }), device({ userId: 'foreign' }), device({ sessionVersion: 2 }), device({ lastActivityAt: new Date(created.getTime() - policy.idleMs) }), device({ absoluteExpiresAt: created })];
  for (const row of invalid) {
    const result = decideAdminAccess({ userId: 'user-1', sessionVersion: 3, sid: row?.id, user: user({ role: 'SALES' }), device: row, roles: ['ADMIN'], now: created, policy });
    assert.deepEqual(result, { ok: false, reason: 'unauthenticated', status: 401 });
  }
});

test('API cookie namespace matches Auth.js in production and development without account fallback', () => {
  const script = `
    const { readSessionToken } = require('./src/auth.ts');
    (async () => {
      const { encode } = await import('next-auth/jwt');
      const secret = process.env.AUTH_SECRET;
      const plainName = 'authjs.session-token';
      const secureName = '__Secure-authjs.session-token';
      const plain = await encode({ secret, salt: plainName, token: { uid: 'plain-account', sv: 1, sid: 'plain-device' }, maxAge: 3600 });
      const secure = await encode({ secret, salt: secureName, token: { uid: 'secure-account', sv: 2, sid: 'secure-device' }, maxAge: 3600 });
      const input = [plainName + '=' + plain + '; ' + secureName + '=' + secure,
        secureName + '=' + secure + '; ' + plainName + '=' + plain,
        plainName + '=malformed; ' + secureName + '=' + secure,
        plainName + '=' + plain + '; ' + secureName + '=malformed',
        plainName + '=' + plain, secureName + '=' + secure];
      const actual = [];
      for (const cookie of input) {
        const token = await readSessionToken(new Request('http://localhost/api/admin/account', { headers: { cookie } }));
        actual.push(token?.uid ?? null);
      }
      console.log(JSON.stringify(actual));
    })().catch(() => process.exit(1));
  `;
  const run = (mode: 'production' | 'development') => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: mode, AUTH_SECRET: 'mixed-cookie-test-only-secret-20261022', DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/unused' }, timeout: 30_000,
  }).trim()) as (string | null)[];
  assert.deepEqual(run('production'), ['secure-account', 'secure-account', 'secure-account', null, null, 'secure-account']);
  assert.deepEqual(run('development'), ['plain-account', 'plain-account', null, 'plain-account', 'plain-account', null]);
});

test('session deletion keeps a past expiry through the actual Next mutable-cookie merge', () => {
  const response = new Response(null);
  for (const cookie of clearedSessionCookieHeaders()) response.headers.append('set-cookie', cookie);
  const jar = MutableRequestCookiesAdapter.wrap(new RequestCookies(new Headers({ cookie: 'authjs.session-token=old; __Secure-authjs.session-token=current' })));
  for (const name of ['authjs.session-token', '__Secure-authjs.session-token']) {
    jar.set(name, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0, secure: name.startsWith('__') });
  }
  appendMutableCookies(response.headers, jar);
  const parsed = new ResponseCookies(response.headers);
  for (const name of ['authjs.session-token', '__Secure-authjs.session-token']) {
    const cookie = parsed.get(name);
    assert.ok(cookie);
    assert.equal(cookie.value ?? '', '');
    assert.ok(cookie.expires instanceof Date && cookie.expires.getTime() <= Date.now(), `${name} must remain expired after Next parsing and merging`);
  }
});

test('open refuses an account that has not turned on 2FA and does not create a device', async () => {
  let inserts = 0;
  const account = user({ totpEnabled: false, totpSecret: null });
  const tx = {
    findUser: async () => account,
    findDevice: async () => null,
    create: async () => { inserts += 1; return device(); },
    revokeSid: async () => {},
    revokeUser: async () => {},
    transaction: async () => { throw new Error('nested'); },
  };
  const service = createDeviceSessionService({
    repo: { ...tx, transaction: async (run) => run(tx) },
    clock: () => created,
    policy,
  });
  await assert.rejects(
    () => service.open({ userId: account.id, sessionVersion: account.sessionVersion, remembered: false, userAgent: 'Test' }),
    /device open refused/,
  );
  assert.equal(inserts, 0);
});
