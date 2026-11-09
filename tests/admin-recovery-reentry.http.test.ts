import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient, type User } from '@prisma/client';
import { authenticator } from 'otplib';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { createRecoveryRepo, type RecoveryRepo } from '../src/lib/server/admin/recovery-repo';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

/**
 * M3-T5 受限重入（R1/R2/R3/R10-enroll）真库用例。
 *
 * 目标校验器：只接受 loopback + 显式 schema=m3t3 + 非空 database；不接受通用 DATABASE_URL 回退。
 * 失败在 import 时抛错，不 skip、不回退（矩阵 R1 §3 / H1）。
 */
export function validateDatabaseUrl(raw: string | undefined): string {
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

process.env.APP_ENV = 'test';
process.env.AUTH_SECRET ??= 'm3t5-recovery-reentry-test-secret-32b';
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.EDGE_AUTH_SECRET ??= 'm'.repeat(40);
const edgeAuth = process.env.EDGE_AUTH_SECRET as string;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
authenticator.options = { window: 1, step: 30 };

const origin = 'http://127.0.0.1:3000';
const password = 'correct-horse-battery';
let ipCounter = 10;
function nextIp() { ipCounter += 1; return `198.51.100.${ipCounter}`; }

let db: PrismaClient = null as unknown as PrismaClient;
let startService: import('../src/lib/server/admin/recovery-start').RecoveryStartService =
  null as unknown as import('../src/lib/server/admin/recovery-start').RecoveryStartService;
let handleRecoveryStart: typeof import('../src/lib/server/admin/recovery-start').handleRecoveryStart;
let createRecoveryEnrollmentService: typeof import('../src/lib/server/admin/recovery-enrollment').createRecoveryEnrollmentService;
let handleRecoveryEnroll: typeof import('../src/lib/server/admin/recovery-enrollment').handleRecoveryEnroll;
let createRecoveryStartService: typeof import('../src/lib/server/admin/recovery-start').createRecoveryStartService;

const counter: import('../src/lib/server/http/metrics').ApiCounter = {
  async recordFinalResponse(r) { return { status: r.status, body: r.body, recorded: false }; },
};

const createdUserIds: string[] = [];

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
  ({ createRecoveryEnrollmentService, handleRecoveryEnroll } = enrollMod);
});

after(async () => {
  if (db && createdUserIds.length > 0) {
    // 只清本测试创建的账号与以其为 target/actor 的审计行；User 删除级联设备/恢复会话/permit。
    await db.auditLog.deleteMany({
      where: { OR: [{ target: { in: createdUserIds } }, { actorId: { in: createdUserIds } }] },
    }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
  }
  await db?.$disconnect?.();
});

async function makeAccount(over: { recoveryCodes?: string[] } = {}) {
  const plain = authenticator.generateSecret();
  const user = await db.user.create({
    data: {
      email: `m3t5-reentry-${randomBytes(4).toString('hex')}@example.com`,
      name: 'Ada',
      passwordHash: await hashSecret(password),
      role: 'ADMIN',
      totpSecret: encrypt(plain),
      totpEnabled: true,
      recoveryCodes: over.recoveryCodes ?? [],
    },
  });
  createdUserIds.push(user.id);
  return { user, plain };
}

function newCode() { return randomBytes(5).toString('hex'); }

function startRequest(email: string, credential: string) {
  return new Request(`${origin}/api/auth-admin/recovery/start`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-edge-auth': edgeAuth, 'cf-connecting-ip': nextIp() },
    body: JSON.stringify({ email, credentialKind: 'RECOVERY_CODE', credential }),
  });
}

async function restrictedToken(user: User, code: string): Promise<string> {
  const response = await handleRecoveryStart(startRequest(user.email, code), { recoveryStart: startService, apiCounter: counter });
  assert.equal(response.status, 200, 'start must issue a restricted cookie');
  const cookie = response.headers.getSetCookie().find((item) => item.startsWith('pj_recovery='));
  assert.ok(cookie, 'restricted cookie present');
  const pair = cookie.split(';', 1)[0] ?? '';
  return decodeURIComponent(pair.slice('pj_recovery='.length));
}

function enrollRequest(token: string | null, body: unknown = {}) {
  const headers: Record<string, string> = {
    origin, 'content-type': 'application/json', 'x-edge-auth': edgeAuth, 'cf-connecting-ip': nextIp(),
  };
  if (token) headers.cookie = `pj_recovery=${encodeURIComponent(token)}`;
  return new Request(`${origin}/api/auth-admin/recovery/enroll`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

function services(clock?: () => Date) {
  return {
    recoveryEnrollment: createRecoveryEnrollmentService({ db, clock }),
    apiCounter: counter,
  };
}

async function sessionRow(userId: string) {
  return db.adminRecoverySession.findFirstOrThrow({ where: { userId } });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 记录锁序：hint 无锁且最先，随后必须是 User 再 session。 */
function spyRepo(calls: string[]): RecoveryRepo {
  const real = createRecoveryRepo();
  return {
    ...real,
    async readRecoverySessionHint(tx, tokenHash) {
      calls.push('hint');
      return real.readRecoverySessionHint(tx, tokenHash);
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

/** 在 User 锁之后停住事务，把 start 与 enroll 的交错变成可断言的顺序。 */
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

describe('POST /api/auth-admin/recovery/enroll (DB)', { concurrency: 1, skip }, () => {
  test('R1 first enroll creates encrypted pending secret and keeps sv', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const response = await handleRecoveryEnroll(enrollRequest(token), services());
    assert.equal(response.status, 200);
    const body = await response.json() as { otpauthUri: string; expiresAt: string };
    assert.ok(body.otpauthUri.startsWith('otpauth://totp/'));
    assert.ok(body.otpauthUri.length > 'otpauth://totp/'.length);
    const secret = new URL(body.otpauthUri).searchParams.get('secret');
    assert.ok(secret && secret.length >= 16, 'otpauth URI carries a secret');
    assert.match(body.expiresAt, /Z$/);
    assert.ok(Number.isFinite(Date.parse(body.expiresAt)));
    const row = await sessionRow(user.id);
    assert.ok(row.pendingSecretEncrypted, 'encrypted pending secret persisted');
    assert.ok(
      row.pendingUntil && row.pendingUntil.getTime() > Date.now(),
      JSON.stringify({ expiresAt: row.expiresAt, pendingUntil: row.pendingUntil, now: new Date().toISOString() }),
    );
    assert.equal(row.pendingUntil.toISOString(), body.expiresAt);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.sessionVersion, before.sessionVersion, 'enroll never bumps sv');
    assert.equal(after.totpSecret, before.totpSecret, 'old factor kept until confirm');
  });

  test('R2 reentry returns the same URI/expiry without rotating or extending', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const first = await handleRecoveryEnroll(enrollRequest(token), services());
    const firstBody = await first.json() as { otpauthUri: string; expiresAt: string };
    const pending1 = await sessionRow(user.id);
    const second = await handleRecoveryEnroll(enrollRequest(token), services());
    const secondBody = await second.json() as { otpauthUri: string; expiresAt: string };
    const pending2 = await sessionRow(user.id);
    assert.equal(second.status, 200);
    assert.equal(secondBody.otpauthUri, firstBody.otpauthUri);
    assert.equal(secondBody.expiresAt, firstBody.expiresAt);
    assert.equal(pending2.pendingSecretEncrypted, pending1.pendingSecretEncrypted);
    assert.equal(pending2.pendingUntil?.getTime(), pending1.pendingUntil?.getTime());
  });

  test('R3 enroll at the exact expiresAt is recovery_expired and persists revocation', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const row = await sessionRow(user.id);
    const frozen = services(() => row.expiresAt);
    const response = await handleRecoveryEnroll(enrollRequest(token), frozen);
    assert.equal(response.status, 401);
    const body = await response.json() as { error: string };
    assert.equal(body.error, 'recovery_expired');
    const after = await sessionRow(user.id);
    assert.equal(after.pendingSecretEncrypted, null, 'pending not written on expiry');
    assert.equal(after.pendingUntil, null);
    assert.ok(after.revokedAt, 'expired flow is persisted as REVOKED');
    const actor = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(actor.totpSecret, user.totpSecret, 'old secret unchanged');
    assert.equal(actor.passwordHash, user.passwordHash, 'old password unchanged');
  });

  test('R10-enroll body with extra fields is 400 invalid and writes nothing', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    for (const body of [{ extra: 1 }, { email: user.email }]) {
      const response = await handleRecoveryEnroll(enrollRequest(token, body), services());
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: string }).error, 'invalid');
    }
    const row = await sessionRow(user.id);
    assert.equal(row.pendingSecretEncrypted, null);
    assert.equal(row.failedAttempts, 0);
  });

  test('enroll without a restricted cookie is 401 and creates nothing', { timeout: 180_000 }, async () => {
    const response = await handleRecoveryEnroll(enrollRequest(null), services());
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error: string }).error, 'bad_credentials');
    assert.equal(response.headers.get('set-cookie'), null);
  });

  test('R11 enroll locks User before session after a lock-free hint', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const token = await restrictedToken(user, code);
    const calls: string[] = [];
    const response = await handleRecoveryEnroll(enrollRequest(token), {
      recoveryEnrollment: createRecoveryEnrollmentService({ db, repo: spyRepo(calls) }),
      apiCounter: counter,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.slice(0, 3), ['hint', 'user', 'session']);
  });

  test('R12 start and enroll interleave without a lock cycle (no 5xx, state consistent)', { timeout: 240_000 }, async () => {
    const code1 = newCode();
    const code2 = newCode();
    const { user } = await makeAccount({
      recoveryCodes: [await hashSecret(code1), await hashSecret(code2)],
    });
    const token = await restrictedToken(user, code1);
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const { repo, entered, release } = gatedRepo();
    let settled = false;
    const enrollPromise = handleRecoveryEnroll(enrollRequest(token), {
      recoveryEnrollment: createRecoveryEnrollmentService({ db, repo }),
      apiCounter: counter,
    }).then((response) => {
      settled = true;
      return response;
    });
    await entered;
    // enroll 已按 User→session 持 User 锁；start 必须排在 User 行后面，而不是持 User 等 session。
    const startPromise = handleRecoveryStart(startRequest(user.email, code2), {
      recoveryStart: startService, apiCounter: counter,
    });
    await sleep(300);
    assert.equal(settled, false, 'start waits on the User row held by enroll');
    release();
    const [enrollResponse, startResponse] = await Promise.all([enrollPromise, startPromise]);
    assert.equal(enrollResponse.status, 200);
    assert.equal(startResponse.status, 200);
    const rows = await db.adminRecoverySession.findMany({ where: { userId: user.id } });
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.revokedAt).length, 1, 'start revokes the enrolling session');
    const active = rows.find((row) => row.revokedAt === null);
    assert.ok(active, 'exactly one active restricted session');
    assert.equal(active.completedAt, null);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.sessionVersion, before.sessionVersion + 1);
  });
});

describe('M3-T5 database target validator (H1)', () => {
  test('rejects non-loopback, missing schema and empty database', () => {
    assert.throws(() => validateDatabaseUrl(undefined), /required/);
    assert.throws(() => validateDatabaseUrl('postgresql://u:p@db.example.com:5432/e2e?schema=m3t3'), /loopback/);
    assert.throws(() => validateDatabaseUrl('postgresql://u:p@localhost:5432/e2e'), /schema=m3t3/);
    assert.throws(() => validateDatabaseUrl('postgresql://u:p@localhost:5432/e2e?schema=public'), /schema=m3t3/);
    assert.throws(() => validateDatabaseUrl('postgresql://u:p@localhost:5432/?schema=m3t3'), /database/);
    assert.throws(() => validateDatabaseUrl('mysql://u:p@localhost:5432/e2e?schema=m3t3'), /postgres/);
    assert.equal(
      validateDatabaseUrl('postgresql://u:p@127.0.0.1:5432/b9_m3t5_20261109?schema=m3t3'),
      'postgresql://u:p@127.0.0.1:5432/b9_m3t5_20261109?schema=m3t3',
    );
  });
});
