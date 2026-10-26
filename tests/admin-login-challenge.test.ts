import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authenticator } from 'otplib';
import { CredentialsSignin } from 'next-auth';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';

Object.assign(process.env, { NODE_ENV: 'test' });
process.env.APP_ENV = 'test';
process.env.AUTH_SECRET = 'login-challenge-unit-secret-32b';
process.env.ADMIN_TOTP_KEY = Buffer.alloc(32, 4).toString('base64');
process.env.EDGE_AUTH_SECRET = 'e'.repeat(40);
delete process.env.ADMIN_ALERT_EMAIL;
delete process.env.INQUIRY_NOTIFY_EMAIL;
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;

const PASSWORD = 'correct-horse-battery-staple';
const SECRET = 'JBSWY3DPEHPK3PXP';
const ORIGIN = 'http://127.0.0.1:3000';
const EDGE = process.env.EDGE_AUTH_SECRET ?? '';

type Row = Record<string, unknown> & { id: string; email: string };
type Challenge = Record<string, unknown> & { id: string; userId: string; consumedAt: Date | null };
let users: Row[] = [];
let challenges: Challenge[] = [];
let lookups = 0;
let deviceInserts = 0;
let hash = '';

const match = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => Object.entries(where).every(([key, value]) => {
  if (key === 'OR') return (value as Record<string, unknown>[]).some((item) => match(row, item));
  if (value === null) return row[key] == null;
  if (value instanceof Date) return row[key] instanceof Date && (row[key] as Date).getTime() === value.getTime();
  if (value && typeof value === 'object') {
    const current = row[key] as number | Date | null | undefined;
    if (current == null) return false;
    const compare = value as { lt?: number | Date; gt?: number | Date };
    if (compare.lt !== undefined && !(+current < +compare.lt)) return false;
    if (compare.gt !== undefined && !(+current > +compare.gt)) return false;
    return true;
  }
  return row[key] === value;
});
const apply = (row: Record<string, unknown>, data: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && 'increment' in value) {
      row[key] = Number(row[key] ?? 0) + Number((value as { increment: number }).increment);
    } else row[key] = value;
  }
};
const copy = <T extends Record<string, unknown>>(row: T): T => ({ ...row });

const db = {
  user: {
    findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
      lookups += 1;
      const found = users.find((row) => (where.email ? row.email === where.email : row.id === where.id));
      return found ? copy(found) : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = users.find((item) => item.id === where.id);
      if (!row) throw new Error('missing user');
      apply(row, data);
      return copy(row);
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = users.filter((row) => match(row, where));
      hit.forEach((row) => apply(row, data));
      return { count: hit.length };
    },
  },
  adminLoginChallenge: {
    create: async ({ data }: { data: Record<string, unknown> & { id: string; userId: string } }) => {
      const row: Challenge = { attempts: 0, createdAt: new Date(), ...data, consumedAt: null };
      challenges.push(row);
      return copy(row);
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const found = challenges.find((row) => row.id === where.id);
      return found ? copy(found) : null;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = challenges.filter((row) => match(row, where));
      hit.forEach((row) => apply(row, data));
      return { count: hit.length };
    },
  },
  auditLog: { create: async () => ({}) },
  adminDeviceSession: {
    create: async () => {
      deviceInserts += 1;
      return { id: 'device-should-not-be-created' };
    },
  },
};
(globalThis as { prisma?: unknown }).prisma = db;

type Authorize = typeof import('../src/lib/server/admin/login').authorizeLogin;
type Handle = typeof import('../src/auth').handleAuth;
type ChallengeApi = typeof import('../src/lib/server/admin/login-challenge');
let authorizeLogin: Authorize;
let handleAuth: Handle;
let challengeApi: ChallengeApi;

const user = (over: Partial<Row> = {}): Row => ({
  id: 'user-1', email: 'ada@example.test', name: 'Ada', passwordHash: hash, role: 'ADMIN',
  totpSecret: encrypt(SECRET), totpEnabled: true, totpLastStep: null, recoveryCodes: [],
  sessionVersion: 3, disabled: false, failedLogins: 0, lockedUntil: null, ...over,
});

before(async () => {
  hash = await hashSecret(PASSWORD);
  challengeApi = await import('../src/lib/server/admin/login-challenge');
  ({ authorizeLogin } = await import('../src/lib/server/admin/login'));
  ({ handleAuth } = await import('../src/auth'));
});
beforeEach(() => {
  setRateLimitStore(new MemoryStore());
  users = [user()];
  challenges = [];
  lookups = 0;
  deviceInserts = 0;
});

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

function hasSessionCookie(response: Response) {
  return response.headers.getSetCookie().some((cookie) => {
    const pair = cookie.split(';', 1)[0] ?? '';
    const name = pair.split('=', 1)[0] ?? '';
    if (!name.includes('authjs.session-token')) return false;
    return pair.slice(name.length + 1).length > 0;
  });
}

function failureKey(response: Response) {
  const location = response.headers.get('location') ?? '';
  const url = location ? new URL(location, ORIGIN) : null;
  return [response.status, url?.pathname ?? '', url?.searchParams.get('error') ?? '', url?.searchParams.get('code') ?? '', hasSessionCookie(response) ? '1' : '0'].join('|');
}

function trusted(ip: string, extra: Record<string, string> = {}) {
  return { origin: ORIGIN, 'x-edge-auth': EDGE, 'cf-connecting-ip': ip, 'user-agent': 'TestBrowser', ...extra };
}

async function postLogin(fields: Record<string, string>, ip: string, cookie = '') {
  const csrf = await handleAuth(new Request(`${ORIGIN}/api/auth/csrf`, { headers: trusted(ip, cookie ? { cookie } : {}) }));
  const body = await csrf.json() as { csrfToken: string };
  const form = new URLSearchParams({ csrfToken: body.csrfToken, callbackUrl: `${ORIGIN}/admin/inquiries`, ...fields });
  return handleAuth(new Request(`${ORIGIN}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: trusted(ip, { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieJar(csrf, cookie) }),
    body: form,
  }));
}

function codeOf(error: unknown) {
  return error instanceof CredentialsSignin ? error.code : '';
}

test('a correct password without 2FA returns the setup code and no session cookie', async () => {
  users = [user({ totpEnabled: false, totpSecret: null })];
  const paths: Record<string, string>[] = [
    { email: 'ada@example.test', password: PASSWORD },
    { email: 'ada@example.test', password: PASSWORD, totp: '123456' },
    { email: 'ada@example.test', password: PASSWORD, recoveryCode: '0123456789' },
  ];
  for (const fields of paths) {
    users = [user({ id: `user-${fields.totp ?? fields.recoveryCode ?? 'plain'}`, totpEnabled: false, totpSecret: null, failedLogins: 0 })];
    challenges = [];
    const response = await postLogin(fields, `198.51.100.${10 + paths.indexOf(fields)}`);
    assert.equal(failureKey(response), '302|/admin-login|CredentialsSignin|totp_setup_required|0');
    assert.equal(hasSessionCookie(response), false);
    assert.equal(response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${challengeApi.CHALLENGE_COOKIE}=`)), false);
    assert.equal(challenges.length, 0);
  }
  assert.equal(deviceInserts, 0);
  const totpMode = await authorizeLogin({ email: 'ada@example.test', mode: 'totp', totp: '123456' }, '198.51.100.20');
  assert.equal(totpMode, null);
  assert.equal(deviceInserts, 0);
});

test('locked and missing accounts share the generic failure, and an unknown email is rate limited before lookup', async () => {
  const missing = await authorizeLogin({ email: 'missing@example.test', password: 'wrong-password', totp: '000000' }, '198.51.100.30');
  users = [user({ lockedUntil: new Date(Date.now() + 60_000), failedLogins: 0 })];
  const locked = await authorizeLogin({ email: 'ada@example.test', password: PASSWORD, totp: '000000' }, '198.51.100.31');
  assert.equal(missing, null);
  assert.equal(locked, null);
  const missingHttp = await postLogin({ email: 'nobody@example.test', password: 'wrong-password', totp: '000000' }, '198.51.100.32');
  users = [user({ email: 'locked@example.test', lockedUntil: new Date(Date.now() + 60_000) })];
  const lockedHttp = await postLogin({ email: 'locked@example.test', password: 'wrong-password', totp: '000000' }, '198.51.100.33');
  assert.equal(failureKey(missingHttp), failureKey(lockedHttp));
  assert.match(failureKey(lockedHttp), /\|credentials\|0$/);
  assert.equal(hasSessionCookie(missingHttp), false);
  assert.equal(hasSessionCookie(lockedHttp), false);

  lookups = 0;
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await authorizeLogin({ email: 'unknown@example.test', password: `wrong-${i}`, totp: '000000' }, '198.51.100.40'), null);
  }
  const seen = lookups;
  await assert.rejects(
    () => authorizeLogin({ email: 'unknown@example.test', password: 'wrong-again', totp: '000000' }, '198.51.100.40'),
    (error: unknown) => codeOf(error) === 'rate_limited',
  );
  assert.equal(lookups, seen);
});

test('step 1 stores only the challenge hash and sets a host cookie; a wrong code keeps the challenge', async () => {
  const issued = await challengeApi.withLoginCookies(async () => {
    await assert.rejects(
      () => authorizeLogin({ email: 'ada@example.test', password: PASSWORD, mode: 'password' }, '198.51.100.50', { userAgent: 'TestBrowser' }),
      (error: unknown) => codeOf(error) === 'totp_required',
    );
    return challengeApi.stagedLoginCookies();
  });
  assert.equal(issued.length, 1);
  const header = issued[0] ?? '';
  assert.match(header, new RegExp(`^${challengeApi.CHALLENGE_COOKIE}=`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
  assert.match(header, new RegExp(`Max-Age=${challengeApi.CHALLENGE_TTL_SEC}`));
  assert.doesNotMatch(header, /Domain=/i);
  const raw = decodeURIComponent((header.split(';', 1)[0] ?? '').slice(challengeApi.CHALLENGE_COOKIE.length + 1));
  assert.equal(challenges.length, 1);
  assert.equal(challenges[0]?.id, challengeApi.challengeIdHash(raw));
  assert.notEqual(challenges[0]?.id, raw);
  assert.equal(challenges[0]?.userId, 'user-1');
  assert.equal(challenges[0]?.sessionVersion, 3);
  assert.equal(challenges[0]?.uaHash, createHash('sha256').update('TestBrowser').digest('hex'));
  const expiresAt = challenges[0]?.expiresAt as Date;
  assert.ok(expiresAt.getTime() - Date.now() <= challengeApi.CHALLENGE_TTL_SEC * 1000);
  assert.equal(users[0]?.failedLogins, 0);

  const cookie = `${challengeApi.CHALLENGE_COOKIE}=${encodeURIComponent(raw)}`;
  const wrong = await authorizeLogin({ totp: '000000', mode: 'password' }, '198.51.100.51', { cookie, userAgent: 'TestBrowser' });
  assert.equal(wrong, null);
  assert.equal(challenges[0]?.attempts, 1);
  assert.equal(challenges[0]?.consumedAt, null);
  assert.equal(users[0]?.failedLogins, 1);

  const before = users[0]?.failedLogins;
  await assert.rejects(
    () => authorizeLogin({ totp: authenticator.generate(SECRET), mode: 'password' }, '198.51.100.52', { cookie: `${challengeApi.CHALLENGE_COOKIE}=no-such-challenge-value`, userAgent: 'TestBrowser' }),
    (error: unknown) => codeOf(error) === 'challenge_invalid',
  );
  assert.equal(users[0]?.failedLogins, before);

  challenges[0]!.expiresAt = new Date(Date.now() - 1000);
  const failsBefore = users[0]?.failedLogins;
  await assert.rejects(
    () => authorizeLogin({ totp: authenticator.generate(SECRET), mode: 'password' }, '198.51.100.53', { cookie, userAgent: 'TestBrowser' }),
    (error: unknown) => codeOf(error) === 'challenge_invalid',
  );
  assert.equal(users[0]?.failedLogins, failsBefore);
  challenges[0]!.expiresAt = expiresAt;

  await assert.rejects(
    () => authorizeLogin({ totp: authenticator.generate(SECRET), mode: 'password' }, '198.51.100.54', { cookie, userAgent: 'OtherBrowser' }),
    (error: unknown) => codeOf(error) === 'challenge_invalid',
  );
  assert.equal(challenges[0]?.consumedAt, null);

  const signed = await authorizeLogin({ totp: authenticator.generate(SECRET), mode: 'password' }, '198.51.100.55', { cookie, userAgent: 'TestBrowser' });
  assert.equal(signed && typeof signed === 'object', true);
  const consumedAt: unknown = challenges[0]?.consumedAt;
  assert.equal(typeof consumedAt === 'object' && consumedAt !== null && consumedAt instanceof Date, true);
  const again = users[0]?.failedLogins;
  await assert.rejects(
    () => authorizeLogin({ totp: authenticator.generate(SECRET), mode: 'password' }, '198.51.100.56', { cookie, userAgent: 'TestBrowser' }),
    (error: unknown) => codeOf(error) === 'challenge_invalid',
  );
  assert.equal(users[0]?.failedLogins, again);
});

test('the password step over HTTP sets the challenge cookie and not a session cookie', async () => {
  const response = await postLogin({ email: 'ada@example.test', password: PASSWORD }, '198.51.100.60');
  assert.equal(failureKey(response), '302|/admin-login|CredentialsSignin|totp_required|0');
  assert.equal(hasSessionCookie(response), false);
  const cookie = response.headers.getSetCookie().find((item) => item.startsWith(`${challengeApi.CHALLENGE_COOKIE}=`));
  assert.ok(cookie);
  assert.match(cookie ?? '', /HttpOnly/);
  assert.match(cookie ?? '', /Secure/);
  assert.match(cookie ?? '', /SameSite=Lax/);
  assert.match(cookie ?? '', /Path=\//);
  assert.doesNotMatch(cookie ?? '', /Domain=/i);
});

function challengeCookie(header: string) {
  const raw = decodeURIComponent((header.split(';', 1)[0] ?? '').slice(challengeApi.CHALLENGE_COOKIE.length + 1));
  return `${challengeApi.CHALLENGE_COOKIE}=${encodeURIComponent(raw)}`;
}

function assertCleared(headers: string[]) {
  const header = headers.find((item) => item.startsWith(`${challengeApi.CHALLENGE_COOKIE}=`));
  assert.ok(header);
  assert.match(header ?? '', new RegExp(`^${challengeApi.CHALLENGE_COOKIE}=;`));
  assert.match(header ?? '', /Max-Age=0/);
  assert.match(header ?? '', /HttpOnly/);
  assert.match(header ?? '', /Secure/);
  assert.match(header ?? '', /SameSite=Lax/);
  assert.match(header ?? '', /Path=\//);
  assert.doesNotMatch(header ?? '', /Domain=/i);
}

async function issueCookie(ip: string) {
  const issued = await challengeApi.withLoginCookies(async () => {
    await assert.rejects(
      () => authorizeLogin({ email: 'ada@example.test', password: PASSWORD, mode: 'password' }, ip, { userAgent: 'TestBrowser' }),
      (error: unknown) => codeOf(error) === 'totp_required',
    );
    return challengeApi.stagedLoginCookies();
  });
  return challengeCookie(issued[0] ?? '');
}

test('login success and an invalid challenge both clear the host cookie', async () => {
  const cookie = await issueCookie('198.51.100.80');
  const cleared = await challengeApi.withLoginCookies(async () => {
    const signed = await authorizeLogin({ totp: authenticator.generate(SECRET), mode: 'password' }, '198.51.100.81', { cookie, userAgent: 'TestBrowser' });
    assert.equal(signed && typeof signed === 'object', true);
    return challengeApi.stagedLoginCookies();
  });
  assertCleared(cleared);

  users = [user({ id: 'user-invalid', failedLogins: 0 })];
  challenges = [];
  const missing = await challengeApi.withLoginCookies(async () => {
    await assert.rejects(
      () => authorizeLogin({ totp: authenticator.generate(SECRET), mode: 'password' }, '198.51.100.82', { cookie: `${challengeApi.CHALLENGE_COOKIE}=no-such-challenge-value-xx`, userAgent: 'TestBrowser' }),
      (error: unknown) => codeOf(error) === 'challenge_invalid',
    );
    return challengeApi.stagedLoginCookies();
  });
  assertCleared(missing);
  assert.equal(users[0]?.failedLogins, 0);

  const wrong = await challengeApi.withLoginCookies(async () => {
    const cookie2 = await issueCookie('198.51.100.83');
    const result = await authorizeLogin({ totp: '000000', mode: 'password' }, '198.51.100.84', { cookie: cookie2, userAgent: 'TestBrowser' });
    assert.equal(result, null);
    return challengeApi.stagedLoginCookies();
  });
  assert.equal(wrong.some((header) => /Max-Age=0/.test(header)), false);

  const httpInvalid = await postLogin({ totp: '123456' }, '198.51.100.85', `${challengeApi.CHALLENGE_COOKIE}=still-not-a-real-challenge`);
  assert.match(failureKey(httpInvalid), /challenge_invalid\|0$/);
  assertCleared(httpInvalid.headers.getSetCookie());
});

test('a sessionVersion change invalidates the challenge without counting a failed login', async () => {
  const cookie = await issueCookie('198.51.100.90');
  users[0]!.sessionVersion = 4;
  const fails = users[0]?.failedLogins;
  await assert.rejects(
    () => authorizeLogin({ totp: authenticator.generate(SECRET), mode: 'password' }, '198.51.100.91', { cookie, userAgent: 'TestBrowser' }),
    (error: unknown) => codeOf(error) === 'challenge_invalid',
  );
  assert.equal(users[0]?.failedLogins, fails);
  assert.equal(challenges[0]?.consumedAt, null);
});

test('the fifth wrong code uses up the challenge and a later code cannot consume it', async () => {
  const cookie = await issueCookie('198.51.100.100');
  for (let i = 0; i < 5; i += 1) {
    const wrong = await authorizeLogin({ totp: '000000', mode: 'password' }, `198.51.100.${101 + i}`, { cookie, userAgent: 'TestBrowser' });
    assert.equal(wrong, null);
  }
  assert.equal(challenges[0]?.attempts, 5);
  assert.equal(challenges[0]?.consumedAt, null);
  const fails = users[0]?.failedLogins;
  await assert.rejects(
    () => authorizeLogin({ totp: authenticator.generate(SECRET), mode: 'password' }, '198.51.100.110', { cookie, userAgent: 'TestBrowser' }),
    (error: unknown) => codeOf(error) === 'challenge_invalid',
  );
  assert.equal(challenges[0]?.attempts, 5);
  assert.equal(challenges[0]?.consumedAt, null);
  assert.equal(users[0]?.failedLogins, fails);
});

test('a locked or disabled account on the challenge step clears the host cookie and returns null', async () => {
  const cases = [
    { label: 'locked', patch: { lockedUntil: new Date(Date.now() + 60_000) }, issueIp: '198.51.100.120', ip: '198.51.100.121' },
    { label: 'disabled', patch: { disabled: true, lockedUntil: null }, issueIp: '198.51.100.122', ip: '198.51.100.123' },
  ];
  for (const item of cases) {
    users = [user()];
    challenges = [];
    const cookie = await issueCookie(item.issueIp);
    Object.assign(users[0]!, item.patch);
    const fails = users[0]?.failedLogins;
    const cleared = await challengeApi.withLoginCookies(async () => {
      const result = await authorizeLogin({ totp: authenticator.generate(SECRET), mode: 'password' }, item.ip, { cookie, userAgent: 'TestBrowser' });
      assert.equal(result, null, item.label);
      return challengeApi.stagedLoginCookies();
    });
    assertCleared(cleared);
    assert.equal(users[0]?.failedLogins, fails, item.label);
    assert.equal(challenges[0]?.consumedAt, null, item.label);
    assert.equal(deviceInserts, 0, item.label);
  }
});
