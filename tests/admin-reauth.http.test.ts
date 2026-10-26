import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { PrismaClient, User } from '@prisma/client';
import { authenticator } from 'otplib';
import { ActionGrantDTOSchema } from '../src/lib/contracts/account';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

const databaseUrl = process.env.M3T3_TEST_DATABASE_URL?.startsWith('postgres')
  ? process.env.M3T3_TEST_DATABASE_URL
  : '';
const skip = !databaseUrl && 'no dedicated M3T3_TEST_DATABASE_URL';
process.env.APP_ENV = 'test';
Object.assign(process.env, { NODE_ENV: 'test' });
process.env.AUTH_SECRET ??= 'm3t3-reauth-http-test-secret-32b';
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
let ipSeq = 1;
let db: PrismaClient = null as unknown as PrismaClient;
let handleAuth: (request: Request) => Promise<Response> = async () => { throw new Error('auth not loaded'); };
let postReauth: (request: Request) => Promise<Response> = async () => { throw new Error('reauth not loaded'); };
let hashGrantToken: (token: string) => string = () => { throw new Error('grant hash not loaded'); };

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

function codeForStep(secret: string, step: number) {
  return authenticator.clone({ epoch: step * 30_000 + 5_000 }).generate(secret);
}

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
  } catch {
    throw new Error('prisma db push failed');
  }
  ({ prisma: db } = await import('../src/lib/server/db'));
  ({ hashGrantToken } = await import('../src/lib/server/admin/action-grant'));
  ({ handleAuth } = await import('../src/auth'));
  ({ POST: postReauth } = await import('../src/app/api/admin/account/reauth/route'));
});

after(async () => { await db?.$disconnect?.(); });

async function makeUser(over: { role?: User['role']; passwordlessEnabled?: boolean } = {}) {
  const plain = authenticator.generateSecret();
  const email = `m3t3-http-${randomBytes(4).toString('hex')}@example.com`;
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

function reauth(jar: string, body: unknown, ip: string, headerOrigin = origin) {
  return postReauth(new Request(`${origin}/api/admin/account/reauth`, {
    method: 'POST',
    headers: { ...trustedHeaders(ip, { origin: headerOrigin }), cookie: jar, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function grantRows(userId: string) {
  return db.adminActionGrant.findMany({ where: { userId } });
}

describe('POST /api/admin/account/reauth', { concurrency: 1, skip }, () => {
  test('E-72 real reauth stores only the hash and refuses a step login already consumed', { timeout: 180_000 }, async () => {
    const member = await makeUser();
    const ip = nextIp();
    const used = authenticator.generate(member.plain);
    const signed = await postLogin({ email: member.email, password, totp: used }, ip);
    assert.equal(hasSession(signed.response), true);
    const device = await db.adminDeviceSession.findFirstOrThrow({ where: { userId: member.row.id } });
    const replay = await reauth(signed.jar, { purpose: 'PASSWORD', password, totp: used }, ip);
    assert.equal(replay.status, 401);
    const replayBody = await replay.json() as { error: string; requestId: string; fieldErrors?: { totp?: string } };
    assert.equal(replayBody.error, 'bad_credentials');
    assert.match(replayBody.requestId, /^[0-9a-f-]{36}$/i);
    assert.equal(replayBody.fieldErrors?.totp, 'Wait for the next authenticator code.');
    assert.equal((await grantRows(member.row.id)).length, 0);

    const fresh = unusedCode(member.plain, (await db.user.findUniqueOrThrow({ where: { id: member.row.id } })).totpLastStep);
    const response = await reauth(signed.jar, { purpose: 'PASSWORD', password, totp: fresh }, ip);
    assert.equal(response.status, 200);
    assert.equal(response.headers.getSetCookie().length, 0);
    const body = ActionGrantDTOSchema.parse(await response.json());
    assert.equal(Buffer.from(body.token, 'base64url').length, 32);
    assert.equal(body.purpose, 'PASSWORD');
    const remaining = Date.parse(body.expiresAt) - Date.now();
    assert.ok(remaining > 3 * 60_000 && remaining <= 5 * 60_000);
    const stored = (await grantRows(member.row.id))[0];
    assert.equal(stored?.tokenHash, hashGrantToken(body.token));
    assert.equal(JSON.stringify(stored).includes(body.token), false);
    assert.equal(stored?.deviceSessionId, device.id);
    assert.equal(stored?.targetId, null);
    const after = await db.adminDeviceSession.findUniqueOrThrow({ where: { id: device.id } });
    assert.equal(after.lastActivityAt.toISOString(), device.lastActivityAt.toISOString());
    assert.equal(after.hardExpiresAt?.toISOString(), device.hardExpiresAt?.toISOString());
    assert.equal(after.revokedAt, null);
    const account = await db.user.findUniqueOrThrow({ where: { id: member.row.id } });
    assert.equal(account.sessionVersion, member.row.sessionVersion);
    assert.equal(account.passwordlessEnabled, false);

    const sameStep = await reauth(signed.jar, { purpose: 'LOGIN_MODE', password, totp: fresh }, nextIp());
    assert.equal(sameStep.status, 401);
    assert.equal((await grantRows(member.row.id)).length, 1);
  });

  test('two reauth requests for one step issue one grant', { timeout: 180_000 }, async () => {
    const member = await makeUser();
    const ip = nextIp();
    const signed = await postLogin({ email: member.email, password, totp: authenticator.generate(member.plain) }, ip);
    assert.equal(hasSession(signed.response), true);
    const fresh = unusedCode(member.plain, (await db.user.findUniqueOrThrow({ where: { id: member.row.id } })).totpLastStep);
    const body = { purpose: 'TOTP_RESET', password, totp: fresh };
    const [first, second] = await Promise.all([reauth(signed.jar, body, ip), reauth(signed.jar, body, nextIp())]);
    const statuses = [first.status, second.status].slice().sort();
    assert.deepEqual(statuses, [200, 401]);
    assert.equal((await grantRows(member.row.id)).length, 1);
  });

  test('E-73 E-74 reauth reads the current role and binds recovery or the caller device', { timeout: 180_000 }, async () => {
    const admin = await makeUser({ role: 'ADMIN' });
    const sales = await makeUser({ role: 'SALES' });
    const target = await makeUser({ role: 'EDITOR' });
    const adminIp = nextIp();
    const salesIp = nextIp();
    const adminSession = await postLogin({ email: admin.email, password, totp: authenticator.generate(admin.plain) }, adminIp);
    const salesSession = await postLogin({ email: sales.email, password, totp: authenticator.generate(sales.plain) }, salesIp);
    assert.equal(hasSession(adminSession.response), true);
    assert.equal(hasSession(salesSession.response), true);
    const salesBefore = await db.user.findUniqueOrThrow({ where: { id: sales.row.id } });
    const salesCode = unusedCode(sales.plain, salesBefore.totpLastStep);
    const salesDenied = await reauth(salesSession.jar, {
      purpose: 'RECOVERY_AUTHORIZE', targetId: target.row.id, password, totp: salesCode,
    }, salesIp);
    assert.equal(salesDenied.status, 403);
    assert.equal((await (await salesDenied.json()) as { error: string }).error, 'forbidden');
    assert.equal((await grantRows(sales.row.id)).length, 0);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: sales.row.id } })).totpLastStep, salesBefore.totpLastStep);

    const adminRow = await db.user.findUniqueOrThrow({ where: { id: admin.row.id } });
    const adminCode = unusedCode(admin.plain, adminRow.totpLastStep);
    const selfDenied = await reauth(adminSession.jar, {
      purpose: 'RECOVERY_AUTHORIZE', targetId: admin.row.id, password, totp: adminCode,
    }, adminIp);
    assert.equal(selfDenied.status, 403);
    await db.user.update({ where: { id: admin.row.id }, data: { role: 'SALES' } });
    const demoted = await reauth(adminSession.jar, {
      purpose: 'RECOVERY_AUTHORIZE', targetId: target.row.id, password, totp: adminCode,
    }, adminIp);
    assert.equal(demoted.status, 403);
    assert.equal((await grantRows(admin.row.id)).length, 0);
    await db.user.update({ where: { id: admin.row.id }, data: { role: 'ADMIN' } });
    const allowed = await reauth(adminSession.jar, {
      purpose: 'RECOVERY_AUTHORIZE', targetId: target.row.id, password, totp: adminCode,
    }, adminIp);
    assert.equal(allowed.status, 200);
    const allowedBody = ActionGrantDTOSchema.parse(await allowed.json());
    assert.equal(allowedBody.purpose, 'RECOVERY_AUTHORIZE');
    const recovery = (await grantRows(admin.row.id))[0];
    assert.equal(recovery?.targetId, target.row.id);
    assert.equal(recovery?.userId, admin.row.id);

    const device = await db.adminDeviceSession.findFirstOrThrow({ where: { userId: sales.row.id, revokedAt: null } });
    const foreignDevice = await db.adminDeviceSession.findFirstOrThrow({ where: { userId: admin.row.id } });
    const missingDevice = await reauth(salesSession.jar, {
      purpose: 'DEVICE_REVOKE', targetId: foreignDevice.id, password, totp: salesCode,
    }, salesIp);
    assert.equal(missingDevice.status, 404);
    assert.equal((await grantRows(sales.row.id)).length, 0);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: sales.row.id } })).totpLastStep, salesBefore.totpLastStep);
    const ownDevice = await reauth(salesSession.jar, {
      purpose: 'DEVICE_REVOKE', targetId: device.id, password, totp: salesCode,
    }, salesIp);
    assert.equal(ownDevice.status, 200);
    const own = (await grantRows(sales.row.id)).find((row) => row.purpose === 'DEVICE_REVOKE');
    assert.equal(own?.targetId, device.id);
    const activity = await db.adminDeviceSession.findUniqueOrThrow({ where: { id: device.id } });
    assert.equal(activity.lastActivityAt.toISOString(), device.lastActivityAt.toISOString());
  });

  test('E-75 session-only or totp-only reauth stays at 401 and passwordless login still works', { timeout: 180_000 }, async () => {
    const member = await makeUser({ passwordlessEnabled: true });
    const ip = nextIp();
    const first = authenticator.generate(member.plain);
    const signed = await postLogin({ email: member.email, mode: 'totp', totp: first }, ip);
    assert.equal(hasSession(signed.response), true);
    const afterLogin = await db.user.findUniqueOrThrow({ where: { id: member.row.id } });
    assert.equal(afterLogin.passwordlessEnabled, true);
    const sessionOnly = await reauth(signed.jar, {}, ip);
    assert.equal(sessionOnly.status, 401);
    assert.equal((await sessionOnly.json() as { error: string }).error, 'bad_credentials');
    const next = unusedCode(member.plain, afterLogin.totpLastStep);
    const totpOnly = await reauth(signed.jar, { purpose: 'PASSWORD', totp: next }, ip);
    assert.equal(totpOnly.status, 401);
    assert.equal((await grantRows(member.row.id)).length, 0);
    const still = await db.user.findUniqueOrThrow({ where: { id: member.row.id } });
    assert.equal(still.totpLastStep, afterLogin.totpLastStep);
    assert.equal(still.passwordHash, member.row.passwordHash);
    const again = await postLogin({ email: member.email, mode: 'totp', totp: next }, nextIp());
    assert.equal(hasSession(again.response), true);
    assert.equal((await grantRows(member.row.id)).length, 0);
  });

  test('a recovery code is not a reauth factor and does not spend the authenticator step', { timeout: 180_000 }, async () => {
    const member = await makeUser();
    const ip = nextIp();
    const signed = await postLogin({ email: member.email, password, totp: authenticator.generate(member.plain) }, ip);
    const afterLogin = await db.user.findUniqueOrThrow({ where: { id: member.row.id } });
    const fresh = unusedCode(member.plain, afterLogin.totpLastStep);
    const withRecovery = await reauth(signed.jar, {
      purpose: 'LOGIN_MODE', password, totp: fresh, recoveryCode: 'abcde12345',
    }, ip);
    assert.equal(withRecovery.status, 400);
    assert.equal((await withRecovery.json() as { error: string }).error, 'invalid');
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: member.row.id } })).totpLastStep, afterLogin.totpLastStep);
    const issued = await reauth(signed.jar, { purpose: 'LOGIN_MODE', password, totp: fresh }, ip);
    assert.equal(issued.status, 200);
    assert.equal((await grantRows(member.row.id)).length, 1);
  });

  test('cross-origin and anonymous reauth do not issue a grant', { timeout: 180_000 }, async () => {
    const member = await makeUser();
    const ip = nextIp();
    const signed = await postLogin({ email: member.email, password, totp: authenticator.generate(member.plain) }, ip);
    const afterLogin = await db.user.findUniqueOrThrow({ where: { id: member.row.id } });
    const fresh = unusedCode(member.plain, afterLogin.totpLastStep);
    const foreign = await reauth(signed.jar, { purpose: 'PASSWORD', password, totp: fresh }, ip, 'https://evil.example');
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json() as { error: string }).error, 'forbidden_origin');
    const anonymous = await reauth('', { purpose: 'PASSWORD', password, totp: fresh }, nextIp());
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json() as { error: string }).error, 'unauthorized');
    assert.equal((await grantRows(member.row.id)).length, 0);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: member.row.id } })).totpLastStep, afterLogin.totpLastStep);
  });

  test('the sixth reauth in ten minutes is refused before a grant is issued', { timeout: 180_000 }, async () => {
    const member = await makeUser();
    const ip = nextIp();
    const signed = await postLogin({ email: member.email, password, totp: authenticator.generate(member.plain) }, ip);
    for (let n = 0; n < 5; n += 1) {
      const denied = await reauth(signed.jar, { purpose: 'LOGIN_MODE' }, ip);
      assert.equal(denied.status, 401);
    }
    const fresh = unusedCode(member.plain, (await db.user.findUniqueOrThrow({ where: { id: member.row.id } })).totpLastStep);
    const blocked = await reauth(signed.jar, { purpose: 'LOGIN_MODE', password, totp: fresh }, ip);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '600');
    assert.equal((await blocked.json() as { error: string }).error, 'rate_limited');
    assert.equal((await grantRows(member.row.id)).length, 0);
  });
});
