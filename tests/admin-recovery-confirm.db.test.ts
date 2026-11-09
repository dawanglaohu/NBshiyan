import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient, type User } from '@prisma/client';
import { authenticator } from 'otplib';
import { decode } from 'next-auth/jwt';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { hashRecoveryPermitToken, createRecoveryRepo, type RecoveryRepo } from '../src/lib/server/admin/recovery-repo';
import { auditEmailHash, hashCodes } from '../src/lib/server/admin/login';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

/**
 * M3-T5 最终确认真库用例（R4/R5/R6/R7/R8a/R8b/R9a/R9b/正控/R10-confirm/R11/R12）。
 *
 * 目标校验器：只接受 loopback + 显式 schema=m3t3 + 非空 database；不读通用 DATABASE_URL 回退。
 * 失败在 import 时抛错，不 skip、不回退（矩阵 R1 §3 / H1）。
 */
function validateDatabaseUrl(raw: string | undefined): string {
  if (!raw) throw new Error('M3T3_TEST_DATABASE_URL is required when M3T3_REQUIRE_DATABASE=true');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('M3T3_TEST_DATABASE_URL must be a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('M3T3_TEST_DATABASE_URL must use the postgres scheme');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('M3T3_TEST_DATABASE_URL must point at loopback');
  }
  if (parsed.searchParams.get('schema') !== 'm3t3') {
    throw new Error('M3T3_TEST_DATABASE_URL must carry schema=m3t3');
  }
  if (!parsed.pathname.replace(/^\//, '')) {
    throw new Error('M3T3_TEST_DATABASE_URL must name a database');
  }
  return raw;
}

const requireDatabase = process.env.M3T3_REQUIRE_DATABASE === 'true';
const rawDatabaseUrl = process.env.M3T3_TEST_DATABASE_URL;
let databaseUrl = '';
if (rawDatabaseUrl) databaseUrl = validateDatabaseUrl(rawDatabaseUrl);
else if (requireDatabase) validateDatabaseUrl(undefined);
const skip = !databaseUrl && 'no dedicated M3T3_TEST_DATABASE_URL';

const secret = process.env.AUTH_SECRET || 'm3t5-recovery-confirm-test-secret-32b';
process.env.APP_ENV = 'test';
process.env.AUTH_SECRET = secret;
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.EDGE_AUTH_SECRET ??= 'm'.repeat(40);
const edgeAuth = process.env.EDGE_AUTH_SECRET as string;
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
authenticator.options = { window: 1, step: 30 };

const origin = 'http://127.0.0.1:3000';
const sessionName = 'authjs.session-token';
const OLD_PASSWORD = 'correct-horse-battery';
let ipCounter = 100;
function nextIp() { ipCounter += 1; return `198.51.100.${ipCounter}`; }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let db: PrismaClient = null as unknown as PrismaClient;
const createdUserIds: string[] = [];
const createdEmails: string[] = [];
let startService: import('../src/lib/server/admin/recovery-start').RecoveryStartService =
  null as unknown as import('../src/lib/server/admin/recovery-start').RecoveryStartService;
let handleRecoveryStart: typeof import('../src/lib/server/admin/recovery-start').handleRecoveryStart;
let createRecoveryEnrollmentService: typeof import('../src/lib/server/admin/recovery-enrollment').createRecoveryEnrollmentService;
let handleRecoveryEnroll: typeof import('../src/lib/server/admin/recovery-enrollment').handleRecoveryEnroll;
let handleRecoveryConfirm: typeof import('../src/lib/server/admin/recovery-enrollment').handleRecoveryConfirm;
let createRecoveryStartService: typeof import('../src/lib/server/admin/recovery-start').createRecoveryStartService;
let handleAuth: (request: Request) => Promise<Response> = async () => { throw new Error('auth not loaded'); };
let createAccountGet: typeof import('../src/lib/server/admin/account').createAccountGet = () => { throw new Error('account not loaded'); };

const counter: import('../src/lib/server/http/metrics').ApiCounter = {
  async recordFinalResponse(r) { return { status: r.status, body: r.body, recorded: false }; },
};

before(async () => {
  if (!databaseUrl) return;
  setRateLimitStore(new MemoryStore());
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  ({ prisma: db } = await import('../src/lib/server/db'));
  const startMod = await import('../src/lib/server/admin/recovery-start');
  ({ handleRecoveryStart, createRecoveryStartService } = startMod);
  startService = createRecoveryStartService({ db });
  const enrollMod = await import('../src/lib/server/admin/recovery-enrollment');
  ({ createRecoveryEnrollmentService, handleRecoveryEnroll, handleRecoveryConfirm } = enrollMod);
  ({ handleAuth } = await import('../src/auth'));
  ({ createAccountGet } = await import('../src/lib/server/admin/account'));
});

after(async () => {
  if (db && createdUserIds.length > 0) {
    // 只清本测试产物：账号（级联设备/恢复会话/permit）与精确命中的审计行。
    const targets = [
      ...createdUserIds,
      ...createdEmails.map((email) => auditEmailHash(email)),
    ];
    await db.auditLog.deleteMany({
      where: { OR: [{ target: { in: targets } }, { actorId: { in: createdUserIds } }] },
    }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
  }
  await db?.$disconnect?.();
});

async function makeAccount(over: { recoveryCodes?: string[]; password?: string } = {}) {
  const plain = authenticator.generateSecret();
  const user = await db.user.create({
    data: {
      email: `m3t5-confirm-${randomBytes(4).toString('hex')}@example.com`,
      name: 'Ada',
      passwordHash: await hashSecret(over.password ?? OLD_PASSWORD),
      role: 'ADMIN',
      totpSecret: encrypt(plain),
      totpEnabled: true,
      recoveryCodes: over.recoveryCodes ?? [],
    },
  });
  createdUserIds.push(user.id);
  createdEmails.push(user.email);
  return { user, plain };
}

function newCode() { return randomBytes(5).toString('hex'); }

function request(path: string, body: unknown) {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-edge-auth': edgeAuth, 'cf-connecting-ip': nextIp() },
    body: JSON.stringify(body),
  });
}

function startRequest(email: string, credential: string, credentialKind: 'RECOVERY_CODE' | 'PERMIT' = 'RECOVERY_CODE') {
  return request('/api/auth-admin/recovery/start', { email, credentialKind, credential });
}

function withCookie(req: Request, token: string): Request {
  const headers = new Headers(req.headers);
  headers.set('cookie', `pj_recovery=${encodeURIComponent(token)}`);
  return new Request(req.url, { method: req.method, headers, body: req.body, duplex: 'half' } as RequestInit);
}

async function restrictedToken(user: User, code: string, kind: 'RECOVERY_CODE' | 'PERMIT' = 'RECOVERY_CODE'): Promise<string> {
  const response = await handleRecoveryStart(startRequest(user.email, code, kind), { recoveryStart: startService, apiCounter: counter });
  assert.equal(response.status, 200, 'start must issue a restricted cookie');
  const cookie = response.headers.getSetCookie().find((item) => item.startsWith('pj_recovery='));
  assert.ok(cookie);
  const pair = cookie.split(';', 1)[0] ?? '';
  return decodeURIComponent(pair.slice('pj_recovery='.length));
}

async function enroll(token: string): Promise<{ secret: string; expiresAt: string }> {
  const response = await handleRecoveryEnroll(
    withCookie(request('/api/auth-admin/recovery/enroll', {}), token),
    { recoveryEnrollment: createRecoveryEnrollmentService({ db }), apiCounter: counter },
  );
  assert.equal(response.status, 200, 'enroll must succeed');
  const body = await response.json() as { otpauthUri: string; expiresAt: string };
  const pending = new URL(body.otpauthUri).searchParams.get('secret');
  assert.ok(pending, 'otpauth secret');
  return { secret: pending, expiresAt: body.expiresAt };
}

async function confirm(token: string, totp: string) {
  const response = await handleRecoveryConfirm(
    withCookie(request('/api/auth-admin/recovery/confirm', { totp }), token),
    { recoveryEnrollment: createRecoveryEnrollmentService({ db }), apiCounter: counter },
  );
  return response;
}

async function waitFreshStep(): Promise<void> {
  let into = Date.now() % 30_000;
  while (into > 1_500) {
    await sleep(30_000 - into + 250);
    into = Date.now() % 30_000;
  }
}

async function waitNextStep(): Promise<void> {
  const step = Math.floor(Date.now() / 30_000);
  const wait = (step + 1) * 30_000 + 300 - Date.now();
  if (wait > 0) await sleep(wait);
}

async function codeFor(plain: string, next = false): Promise<string> {
  if (next) await waitNextStep(); else await waitFreshStep();
  return authenticator.generate(plain);
}

function bogusCode(plain: string): string {
  const valid = authenticator.generate(plain);
  const digits = valid.split('');
  digits[5] = digits[5] === '0' ? '1' : '0';
  const candidate = digits.join('');
  assert.equal(
    authenticator.clone({ epoch: Date.now() }).checkDelta(candidate, plain),
    null,
    'bogus code must not verify',
  );
  return candidate;
}

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

async function account(jar: string) {
  return createAccountGet()(new Request(`${origin}/api/admin/account`, { headers: { cookie: jar } }));
}

async function sessionRow(userId: string) {
  return db.adminRecoverySession.findFirstOrThrow({ where: { userId } });
}

/** 记录锁序：hint 无锁且最先，随后必须是 User 再 session。 */
function spyRepo(calls: string[]): RecoveryRepo {
  const real = createRecoveryRepo();
  return {
    ...real,
    async readRecoverySessionHint(handle, tokenHash) {
      calls.push('hint');
      return real.readRecoverySessionHint(handle, tokenHash);
    },
    async lockRecoveryFactors(tx, userId) {
      calls.push('user');
      return real.lockRecoveryFactors(tx, userId);
    },
    async lockRecoverySession(tx, tokenHash) {
      calls.push('session');
      return real.lockRecoverySession(tx, tokenHash);
    },
  };
}

/** 在 User 锁之后停住事务，把 start 与 confirm 的交错变成可断言的顺序。 */
function gatedRepo() {
  const real = createRecoveryRepo();
  let release!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const repo: RecoveryRepo = {
    ...real,
    async lockRecoveryFactors(tx, userId) {
      const row = await real.lockRecoveryFactors(tx, userId);
      markEntered();
      await waiting;
      return row;
    },
  };
  return { repo, entered, release };
}

describe('POST /api/auth-admin/recovery/confirm (DB)', { concurrency: 1, skip }, () => {
  test('R4 wrong totp is 401 without success payload, counts once, old login still works', { timeout: 240_000 }, async () => {
    const code = newCode();
    const { user, plain } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const { secret: pending } = await enroll(token);
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const response = await confirm(token, bogusCode(pending));
    assert.equal(response.status, 401);
    const payload = await response.json() as { error: string; completed?: unknown; recoveryCodes?: unknown };
    assert.equal(payload.error, 'bad_credentials');
    assert.equal(payload.completed, undefined);
    assert.equal(payload.recoveryCodes, undefined);
    const row = await sessionRow(user.id);
    assert.equal(row.failedAttempts, 1);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.sessionVersion, before.sessionVersion);
    assert.equal(after.totpSecret, before.totpSecret);
    assert.equal(after.passwordHash, before.passwordHash);
    const signed = await login(user.email, OLD_PASSWORD, await codeFor(plain));
    assert.ok(signed.jar.includes(`${sessionName}=`), 'old password+totp still works before any successful confirm');
  });

  test('R5 five wrong codes revoke the flow; a sixth attempt is never 200', { timeout: 240_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const { secret: pending } = await enroll(token);
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    for (let i = 1; i <= 5; i += 1) {
      const response = await confirm(token, bogusCode(pending));
      assert.equal(response.status, 401, `attempt ${i} is 401`);
      assert.equal((await response.json() as { error: string }).error, 'bad_credentials');
    }
    const row = await sessionRow(user.id);
    assert.equal(row.failedAttempts, 5);
    assert.ok(row.revokedAt, 'fifth failure persists REVOKED');
    assert.equal(row.pendingSecretEncrypted, null);
    assert.equal(row.pendingUntil, null);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.sessionVersion, before.sessionVersion);
    assert.deepEqual(after.recoveryCodes, before.recoveryCodes);
    const sixth = await confirm(token, authenticator.generate(pending));
    assert.notEqual(sixth.status, 200, 'revoked/rate-limited flow never returns 200');
    const payload = await sixth.json() as { completed?: unknown; recoveryCodes?: unknown };
    assert.equal(payload.completed, undefined);
    assert.equal(payload.recoveryCodes, undefined);
  });

  test('R6 valid new TOTP atomically publishes factors, clears cookie and returns 10 codes once', { timeout: 240_000 }, async () => {
    const oldCodes = [newCode(), newCode(), newCode()];
    const { user } = await makeAccount({ recoveryCodes: await Promise.all(oldCodes.map((c) => hashSecret(c))) });
    const token = await restrictedToken(user, oldCodes[0]);
    const { secret: pending } = await enroll(token);
    const rowBefore = await sessionRow(user.id);
    const userBefore = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const code = await codeFor(pending);
    const step = Math.floor(Date.now() / 30_000);
    const response = await confirm(token, code);
    assert.equal(response.status, 200);
    const body = await response.json() as { completed: boolean; recoveryCodes: string[] };
    assert.equal(body.completed, true);
    assert.equal(body.recoveryCodes.length, 10);
    for (const codeValue of body.recoveryCodes) assert.match(codeValue, /^[a-f0-9]{10}$/);
    assert.equal(new Set(body.recoveryCodes).size, 10, 'codes are unique');
    const setCookie = response.headers.getSetCookie().join('\n');
    assert.match(setCookie, /pj_recovery=/);
    assert.match(setCookie, /Max-Age=0/i);
    assert.match(setCookie, /Path=\/api\/auth-admin\/recovery/);
    const rowAfter = await sessionRow(user.id);
    assert.ok(rowAfter.completedAt);
    assert.equal(rowAfter.pendingSecretEncrypted, null);
    assert.equal(rowAfter.pendingUntil, null);
    const userAfter = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(userAfter.totpSecret, rowBefore.pendingSecretEncrypted, 'new secret published');
    assert.equal(userAfter.sessionVersion, userBefore.sessionVersion + 1);
    assert.equal(userAfter.passwordHash, userBefore.passwordHash, 'RECOVERY_CODE never changes password');
    assert.equal(userAfter.totpLastStep, step);
    assert.equal(userAfter.recoveryCodes.length, 10);
    for (const oldHash of userBefore.recoveryCodes) {
      assert.equal(userAfter.recoveryCodes.includes(oldHash), false, 'old recovery hashes replaced');
    }
    assert.equal(
      await db.auditLog.count({ where: { action: 'recovery.completed', target: user.id } }),
      1,
    );
  });

  test('R7 two concurrent confirms: exactly one 200, one 401, no second sv bump', { timeout: 240_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const { secret: pending } = await enroll(token);
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const totp = await codeFor(pending);
    const [a, b] = await Promise.all([
      confirm(token, totp),
      confirm(token, totp),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 401]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 401 ? a : b;
    const loserBody = await loser.json() as { recoveryCodes?: unknown };
    assert.equal(loserBody.recoveryCodes, undefined);
    const winnerBody = await winner.json() as { recoveryCodes: string[] };
    assert.equal(winnerBody.recoveryCodes.length, 10);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.sessionVersion, before.sessionVersion + 1);
    const row = await sessionRow(user.id);
    const replay = await confirm(token, totp);
    assert.equal(replay.status, 401);
    const userAfterReplay = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(userAfterReplay.sessionVersion, after.sessionVersion);
    assert.deepEqual(userAfterReplay.recoveryCodes, after.recoveryCodes);
    assert.equal((await sessionRow(user.id)).completedAt?.getTime(), row.completedAt?.getTime());
  });

  test('R8a device obtained before start cannot access after confirm', { timeout: 240_000 }, async () => {
    const code = newCode();
    const { user, plain } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const signed = await login(user.email, OLD_PASSWORD, await codeFor(plain), 'true');
    assert.ok(signed.jar.includes(`${sessionName}=`));
    const token = await restrictedToken(user, code);
    const { secret: pending } = await enroll(token);
    assert.equal((await confirm(token, await codeFor(pending))).status, 200);
    assert.equal((await account(signed.jar)).status, 401);
  });

  test('R8b device created after start is really revoked by confirm (row non-null, then 401)', { timeout: 240_000 }, async () => {
    const code = newCode();
    const { user, plain } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    // start keeps old factors; a real login now binds a device on the start-bumped sv.
    const signed = await login(user.email, OLD_PASSWORD, await codeFor(plain));
    assert.ok(signed.jar.includes(`${sessionName}=`));
    assert.equal((await account(signed.jar)).status, 200, 'pre-confirm login is a real working device');
    const raw = signed.jar.split('; ').find((part) => part.startsWith(`${sessionName}=`))?.slice(sessionName.length + 1);
    assert.ok(raw);
    const jwt = await decode({ token: raw, secret, salt: sessionName });
    const sid = jwt?.sid;
    assert.ok(typeof sid === 'string');
    const deviceBefore = await db.adminDeviceSession.findUniqueOrThrow({ where: { id: sid as string } });
    const userAfterStart = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(deviceBefore.revokedAt, null);
    assert.equal(deviceBefore.sessionVersion, userAfterStart.sessionVersion);
    const { secret: pending } = await enroll(token);
    assert.equal((await confirm(token, await codeFor(pending))).status, 200);
    const userAfter = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(userAfter.sessionVersion, userAfterStart.sessionVersion + 1);
    const deviceAfter = await db.adminDeviceSession.findUniqueOrThrow({ where: { id: sid as string } });
    assert.ok(deviceAfter.revokedAt, 'confirm revokes devices below the committed sv');
    assert.equal((await account(signed.jar)).status, 401);
  });

  test('R9 confirm consumes the current step; replay and old secret are refused, next step logs in', { timeout: 240_000 }, async () => {
    const code = newCode();
    const { user, plain: oldPlain } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const { secret: pending } = await enroll(token);
    const totp = await codeFor(pending);
    const step = Math.floor(Date.now() / 30_000);
    assert.equal((await confirm(token, totp)).status, 200);
    const afterConfirm = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(afterConfirm.totpLastStep, step, 'confirm writes the consumed step');
    // replay precondition: the code is still inside the ±1 window, so failure is step consumption.
    assert.notEqual(
      authenticator.clone({ epoch: Date.now() }).checkDelta(totp, pending),
      null,
      'replayed code is still time-valid',
    );
    const devicesBefore = await db.adminDeviceSession.count({ where: { userId: user.id } });
    const replay = await login(user.email, OLD_PASSWORD, totp);
    assert.equal(replay.jar.includes(`${sessionName}=`), false, 'consumed step cannot log in');
    assert.equal(await db.adminDeviceSession.count({ where: { userId: user.id } }), devicesBefore);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).totpLastStep, step);
    const oldCode = await codeFor(oldPlain);
    assert.notEqual(
      authenticator.clone({ epoch: Date.now() }).checkDelta(oldCode, oldPlain),
      null,
      'old secret code is time-valid',
    );
    const stale = await login(user.email, OLD_PASSWORD, oldCode);
    assert.equal(stale.jar.includes(`${sessionName}=`), false, 'old secret is refused');
    assert.equal(await db.adminDeviceSession.count({ where: { userId: user.id } }), devicesBefore);
    const positive = await login(user.email, OLD_PASSWORD, await codeFor(pending, true));
    assert.ok(positive.jar.includes(`${sessionName}=`), 'next unused step logs in with the new factor');
    assert.equal((await account(positive.jar)).status, 200);
  });

  test('R10-confirm extra password fields are 400 invalid before any side effect', { timeout: 240_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const { secret: pending } = await enroll(token);
    const totp = authenticator.generate(pending);
    for (const extra of [{ password: 'x' }, { newPassword: 'x' }, { passwordHash: 'x' }]) {
      const response = await confirmBody(token, { totp, ...extra });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: string }).error, 'invalid');
    }
    const row = await sessionRow(user.id);
    assert.equal(row.failedAttempts, 0, 'schema rejection does not count a TOTP failure');
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.sessionVersion, before.sessionVersion);
  });

  test('R11 SERVER_OWNER pre-authorized hash changes the password once; old password fails', { timeout: 240_000 }, async () => {
    const newPassword = 'new-horse-battery-42';
    const { user } = await makeAccount();
    const pendingHash = await hashSecret(newPassword);
    const permitToken = randomBytes(32).toString('base64url');
    await db.adminRecoveryPermit.create({
      data: {
        id: randomBytes(16).toString('hex'),
        tokenHash: hashRecoveryPermitToken(permitToken),
        targetUserId: user.id,
        source: 'SERVER_OWNER',
        issuedById: null,
        reason: 'owner pre-authorized password reset',
        pendingPasswordHash: pendingHash,
        sessionVersion: user.sessionVersion,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });
    const token = await restrictedToken(user, permitToken, 'PERMIT');
    assert.equal((await sessionRow(user.id)).passwordResetSource, 'SERVER_OWNER');
    const { secret: pending } = await enroll(token);
    assert.equal((await confirm(token, await codeFor(pending))).status, 200);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.passwordHash, pendingHash, 'pre-authorized hash applied');
    assert.equal((await sessionRow(user.id)).passwordResetSource, 'SERVER_OWNER');
    const oldLogin = await login(user.email, OLD_PASSWORD, await codeFor(pending, true));
    assert.equal(oldLogin.jar.includes(`${sessionName}=`), false, 'old password refused');
    const newLogin = await login(user.email, newPassword, await codeFor(pending, true));
    assert.ok(newLogin.jar.includes(`${sessionName}=`), 'new password works');
    assert.equal((await account(newLogin.jar)).status, 200);
  });

  test('R12 RECOVERY_CODE source never changes the password', { timeout: 240_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const token = await restrictedToken(user, code);
    const { secret: pending } = await enroll(token);
    assert.equal((await confirm(token, await codeFor(pending))).status, 200);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.passwordHash, before.passwordHash, 'password hash unchanged');
    assert.equal((await sessionRow(user.id)).passwordResetSource, null);
  });

  test('R13 confirm locks User before session after a lock-free hint', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const { secret: pending } = await enroll(token);
    const nowMs = Date.now();
    const calls: string[] = [];
    const response = await handleRecoveryConfirm(
      withCookie(request('/api/auth-admin/recovery/confirm', {
        totp: authenticator.clone({ epoch: nowMs }).generate(pending),
      }), token),
      { recoveryEnrollment: createRecoveryEnrollmentService({ db, repo: spyRepo(calls), clock: () => new Date(nowMs) }), apiCounter: counter },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(calls.slice(0, 3), ['hint', 'user', 'session']);
    const body = await response.json() as { completed: boolean; recoveryCodes: string[] };
    assert.equal(body.completed, true);
    assert.equal(body.recoveryCodes.length, 10);
  });

  test('R14 start and confirm interleave without a lock cycle (no 5xx, state consistent)', { timeout: 240_000 }, async () => {
    const code1 = newCode();
    const code2 = newCode();
    const { user } = await makeAccount({
      recoveryCodes: [await hashSecret(code1), await hashSecret(code2)],
    });
    const token = await restrictedToken(user, code1);
    const { secret: pending } = await enroll(token);
    const totp = await codeFor(pending);
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const { repo, entered, release } = gatedRepo();
    let settled = false;
    const confirmPromise = handleRecoveryConfirm(
      withCookie(request('/api/auth-admin/recovery/confirm', { totp }), token),
      { recoveryEnrollment: createRecoveryEnrollmentService({ db, repo }), apiCounter: counter },
    ).then((response) => {
      settled = true;
      return response;
    });
    await entered;
    // confirm 已按 User→session 持 User 锁；start 必须排在 User 行后面，而不是持 User 等 session。
    const startPromise = handleRecoveryStart(startRequest(user.email, code2), {
      recoveryStart: startService, apiCounter: counter,
    });
    await sleep(300);
    assert.equal(settled, false, 'start waits on the User row held by confirm');
    release();
    const [confirmResponse, startResponse] = await Promise.all([confirmPromise, startPromise]);
    assert.equal(confirmResponse.status, 200);
    assert.equal(startResponse.status, 401, 'the winning confirm rotated the recovery codes');
    const rows = await db.adminRecoverySession.findMany({ where: { userId: user.id } });
    assert.equal(rows.length, 1);
    assert.ok(rows[0].completedAt);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.sessionVersion, before.sessionVersion + 1);
  });

  test('R15 pending expiry crossed during code preparation is refused at equality and persisted', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const { secret: pending } = await enroll(token);
    const row = await sessionRow(user.id);
    const until = row.pendingUntil;
    assert.ok(until, 'pending has a deadline');
    let nowMs = Date.now();
    const service = createRecoveryEnrollmentService({
      db,
      clock: () => new Date(nowMs),
      hashCodes: async (codes) => {
        nowMs = until.getTime(); // 准备 10 个 Argon2 期间跨过 pendingUntil 等号
        return hashCodes(codes);
      },
    });
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const response = await handleRecoveryConfirm(
      withCookie(request('/api/auth-admin/recovery/confirm', {
        totp: authenticator.clone({ epoch: until.getTime() }).generate(pending),
      }), token),
      { recoveryEnrollment: service, apiCounter: counter },
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error: string }).error, 'recovery_expired');
    const after = await sessionRow(user.id);
    assert.ok(after.revokedAt, 'expiry is committed, not rolled back');
    assert.equal(after.pendingSecretEncrypted, null);
    assert.equal(after.pendingUntil, null);
    const accountAfter = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(accountAfter.sessionVersion, before.sessionVersion);
    assert.equal(accountAfter.totpSecret, before.totpSecret);
  });

  test('R16 preparation ending before pending expiry commits normally (positive control)', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const { secret: pending } = await enroll(token);
    const row = await sessionRow(user.id);
    const until = row.pendingUntil;
    assert.ok(until, 'pending has a deadline');
    const target = until.getTime() - 1_000;
    let nowMs = Date.now();
    const service = createRecoveryEnrollmentService({
      db,
      clock: () => new Date(nowMs),
      hashCodes: async (codes) => {
        nowMs = target; // 准备在等号之前结束
        return hashCodes(codes);
      },
    });
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const response = await handleRecoveryConfirm(
      withCookie(request('/api/auth-admin/recovery/confirm', {
        totp: authenticator.clone({ epoch: target }).generate(pending),
      }), token),
      { recoveryEnrollment: service, apiCounter: counter },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { completed: boolean; recoveryCodes: string[] };
    assert.equal(body.completed, true);
    assert.equal(body.recoveryCodes.length, 10);
    const after = await sessionRow(user.id);
    assert.ok(after.completedAt);
    const accountAfter = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(accountAfter.sessionVersion, before.sessionVersion + 1);
    assert.equal(accountAfter.recoveryCodes.length, 10);
  });

  test('R17 pending expiry crossed while waiting for the session lock is refused at equality', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const { secret: pending } = await enroll(token);
    const row = await sessionRow(user.id);
    const until = row.pendingUntil;
    assert.ok(until, 'pending has a deadline');
    const real = createRecoveryRepo();
    let nowMs = Date.now();
    const repo: RecoveryRepo = {
      ...real,
      async lockRecoverySession(tx, tokenHash) {
        const locked = await real.lockRecoverySession(tx, tokenHash);
        nowMs = until.getTime(); // 等锁期间跨过 pendingUntil 等号
        return locked;
      },
    };
    const service = createRecoveryEnrollmentService({ db, repo, clock: () => new Date(nowMs) });
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const response = await handleRecoveryConfirm(
      withCookie(request('/api/auth-admin/recovery/confirm', {
        totp: authenticator.clone({ epoch: until.getTime() }).generate(pending),
      }), token),
      { recoveryEnrollment: service, apiCounter: counter },
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error: string }).error, 'recovery_expired');
    const after = await sessionRow(user.id);
    assert.ok(after.revokedAt, 'expiry is committed, not rolled back');
    assert.equal(after.pendingUntil, null);
    const accountAfter = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(accountAfter.sessionVersion, before.sessionVersion);
  });
});

/** R10 helper kept separate so the test can prove schema rejects before any DB read. */
async function confirmBody(token: string, body: unknown): Promise<Response> {
  return handleRecoveryConfirm(
    withCookie(request('/api/auth-admin/recovery/confirm', body), token),
    { recoveryEnrollment: createRecoveryEnrollmentService({ db }), apiCounter: counter },
  );
}
