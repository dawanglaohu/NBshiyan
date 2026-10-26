import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const secret = process.env.AUTH_SECRET || 'guard-503-test-secret-32bytes!!';
process.env.AUTH_SECRET = secret;
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;

type Mode = 'down' | 'unknown' | 'ok' | 'disabled' | 'forbidden' | 'revoked' | 'sv';
let mode: Mode = 'down';
let lookups = 0;

function down() {
  const error = new Error('database unreachable');
  error.name = 'PrismaClientKnownRequestError';
  return Object.assign(error, { code: 'P1001' });
}

const now = new Date();
const account = () => ({
  id: 'user-1', email: 'ada@example.com', name: 'Ada', passwordHash: 'hash', role: mode === 'forbidden' ? 'SALES' : 'ADMIN',
  totpSecret: 'secret', totpEnabled: true, totpLastStep: null, recoveryCodes: [], sessionVersion: 3,
  passwordlessEnabled: false, disabled: mode === 'disabled', failedLogins: 0, lockedUntil: null, lastLoginAt: null,
  reactivatedAt: null, enrollIssuedAt: null, totpPendingUntil: null, totpEnrollFails: 0,
  enrollTokenHash: null, enrollTokenExpiresAt: null, createdAt: now,
});
const device = () => ({
  id: 'device-1', userId: 'user-1', sessionVersion: mode === 'sv' ? 99 : 3, remembered: false, createdAt: now,
  lastActivityAt: now, absoluteExpiresAt: null, hardExpiresAt: null, revokedAt: mode === 'revoked' ? now : null, revokedReason: null, deviceLabel: null,
});

function fail() {
  if (mode === 'unknown') throw new Error('unexpected session fault');
  throw down();
}

const stub = {
  user: { findUnique: async () => { lookups += 1; if (mode === 'down' || mode === 'unknown') fail(); return account(); } },
  adminDeviceSession: { findUnique: async () => { lookups += 1; if (mode === 'down' || mode === 'unknown') fail(); return device(); } },
  siteSetting: { findUnique: async () => { throw down(); } },
  $executeRaw: async () => { throw down(); },
  inquiry: { findFirst: async () => { throw down(); } },
};
(globalThis as { prisma?: unknown }).prisma = stub;

const origin = 'http://127.0.0.1:3000';
let requireAdmin: typeof import('../src/lib/server/admin/guard').requireAdmin;
let POST: typeof import('../src/app/api/admin/account/session/activity/route').POST;

before(async () => {
  const db = await import('../src/lib/server/db');
  assert.equal(db.prisma, stub);
  ({ requireAdmin } = await import('../src/lib/server/admin/guard'));
  ({ POST } = await import('../src/app/api/admin/account/session/activity/route'));
});

async function sessionCookie(): Promise<string> {
  const { encode } = await import('next-auth/jwt');
  const token = await encode({
    secret, salt: 'authjs.session-token', maxAge: 3600,
    token: { sub: 'user-1', uid: 'user-1', sv: 3, sid: 'device-1' },
  });
  return `authjs.session-token=${token}`;
}

function cookiesOf(response: Response): string {
  return response.headers.getSetCookie().join('\n');
}

async function guarded(cookie = ''): Promise<Response> {
  const request = new Request(`${origin}/api/admin/account`, { headers: cookie ? { cookie } : {} });
  const result = await requireAdmin(request, ['ADMIN']);
  assert.ok(result instanceof Response);
  return result;
}

test('requireAdmin returns 503 and keeps the cookie when the user query fails', async () => {
  mode = 'down';
  lookups = 0;
  const logs: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const response = await guarded(await sessionCookie());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
    assert.equal(cookiesOf(response).includes('Max-Age=0'), false);
    assert.ok(lookups >= 1);
    const logged = JSON.stringify(logs);
    assert.equal(logged.includes('database unreachable'), false);
    assert.equal(logged.includes('P1001'), true);
  } finally {
    console.error = original;
  }
});

test('requireAdmin returns 500 and keeps the cookie when the query throws for another reason', async () => {
  mode = 'unknown';
  const logs: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const response = await guarded(await sessionCookie());
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { error: string }).error, 'internal_error');
    assert.equal(cookiesOf(response).includes('Max-Age=0'), false);
    assert.equal(JSON.stringify(logs).includes('unexpected session fault'), false);
  } finally {
    console.error = original;
  }
});

test('a healthy database still returns 401 and clears the cookie for revoked devices, session mismatch, and garbage tokens', async () => {
  mode = 'revoked';
  const revoked = await guarded(await sessionCookie());
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json() as { error: string }).error, 'unauthorized');
  assert.match(cookiesOf(revoked), /Max-Age=0/);

  mode = 'sv';
  const mismatch = await guarded(await sessionCookie());
  assert.equal(mismatch.status, 401);
  assert.equal((await mismatch.json() as { error: string }).error, 'unauthorized');
  assert.match(cookiesOf(mismatch), /Max-Age=0/);

  mode = 'ok';
  const garbage = await guarded('authjs.session-token=not-a-jwt');
  assert.equal(garbage.status, 401);
  assert.equal((await garbage.json() as { error: string }).error, 'unauthorized');
  assert.match(cookiesOf(garbage), /Max-Age=0/);
});

test('missing session still clears the cookie, and disabled or forbidden keep their old results', async () => {
  mode = 'ok';
  const loggedOut = await guarded();
  assert.equal(loggedOut.status, 401);
  assert.equal((await loggedOut.json() as { error: string }).error, 'unauthorized');
  assert.match(cookiesOf(loggedOut), /Max-Age=0/);

  mode = 'disabled';
  const disabled = await guarded(await sessionCookie());
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json() as { error: string }).error, 'account_disabled');
  assert.match(cookiesOf(disabled), /Max-Age=0/);

  mode = 'forbidden';
  const forbidden = await guarded(await sessionCookie());
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json() as { error: string }).error, 'forbidden');
  assert.equal(cookiesOf(forbidden).includes('Max-Age=0'), false);

  mode = 'ok';
  const request = new Request(`${origin}/api/admin/account`, { headers: { cookie: await sessionCookie() } });
  const passed = await requireAdmin(request, ['ADMIN']);
  assert.equal(passed instanceof Response, false);
  if (passed instanceof Response) return;
  assert.equal(passed.user.id, 'user-1');
  assert.equal(passed.user.role, 'ADMIN');
});

test('session activity POST stays 503 and does not clear the cookie when the database is down', async () => {
  mode = 'down';
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const response = await POST(new Request(`${origin}/api/admin/account/session/activity`, {
      method: 'POST',
      headers: { cookie: await sessionCookie(), origin, 'content-type': 'application/json' },
      body: '{}',
    }));
    assert.equal(response.status, 503);
    const body = await response.json() as { error?: string };
    assert.equal(body.error, 'service_unavailable');
    assert.equal(cookiesOf(response).includes('Max-Age=0'), false);
    const logged = JSON.stringify({ warnings, errors, body });
    assert.equal(logged.includes('database unreachable'), false);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
});

test('session activity POST stays 500 and does not clear the cookie when the query throws for another reason', async () => {
  mode = 'unknown';
  const response = await POST(new Request(`${origin}/api/admin/account/session/activity`, {
    method: 'POST',
    headers: { cookie: await sessionCookie(), origin, 'content-type': 'application/json' },
    body: '{}',
  }));
  assert.equal(response.status, 500);
  const body = await response.json() as { error?: string };
  assert.equal(body.error, 'internal_error');
  assert.equal(cookiesOf(response).includes('Max-Age=0'), false);
});
