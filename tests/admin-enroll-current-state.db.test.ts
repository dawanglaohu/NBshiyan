import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient, type User } from '@prisma/client';
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
process.env.AUTH_SECRET ??= 'm3t2-enroll-state-test-secret-32';
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 8).toString('base64');
process.env.EDGE_AUTH_SECRET = 'e'.repeat(40);
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;
delete process.env.ADMIN_ALERT_EMAIL;
delete process.env.INQUIRY_NOTIFY_EMAIL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

authenticator.options = { window: 1, step: 30 };

const prisma = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
const origin = 'http://127.0.0.1:3000';
const edge = process.env.EDGE_AUTH_SECRET;
const password = 'correct-horse-battery';
let ipSeq = 1;

let newEnrollToken: typeof import('../src/lib/server/admin/enroll-token').newEnrollToken = () => { throw new Error('token not loaded'); };
let enrollPost: (req: Request) => Promise<Response> = async () => { throw new Error('enroll not loaded'); };
let confirmPost: (req: Request) => Promise<Response> = async () => { throw new Error('confirm not loaded'); };
let commitPendingSecret: typeof import('../src/lib/server/admin/enroll-guard').commitPendingSecret = () => { throw new Error('guard not loaded'); };
let commitEnrollConfirmation: typeof import('../src/lib/server/admin/enroll-guard').commitEnrollConfirmation = () => { throw new Error('guard not loaded'); };
let checkPassword: typeof import('../src/lib/server/admin/login').checkPassword = async () => { throw new Error('login not loaded'); };

function nextIp() {
  const n = ipSeq++;
  if (n > 250) throw new Error('test ip range exhausted');
  return `198.51.100.${n}`;
}

function post(path: string, body: Record<string, string>, ip: string) {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      origin, 'content-type': 'application/json', 'x-edge-auth': edge, 'cf-connecting-ip': ip,
    },
    body: JSON.stringify(body),
  });
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
  ({ newEnrollToken } = await import('../src/lib/server/admin/enroll-token'));
  ({ POST: enrollPost } = await import('../src/app/api/auth-admin/enroll/route'));
  ({ POST: confirmPost } = await import('../src/app/api/auth-admin/enroll/confirm/route'));
  ({ commitPendingSecret, commitEnrollConfirmation } = await import('../src/lib/server/admin/enroll-guard'));
  ({ checkPassword } = await import('../src/lib/server/admin/login'));
});

after(async () => { await prisma?.$disconnect(); });

async function makeUser(over: Partial<Pick<User, 'totpSecret' | 'totpEnabled' | 'totpPendingUntil' | 'enrollTokenExpiresAt' | 'sessionVersion'>> = {}) {
  const client = prisma as PrismaClient;
  const issued = newEnrollToken();
  const email = `m3t2-enroll-${randomBytes(4).toString('hex')}@example.com`;
  const row = await client.user.create({
    data: {
      email, name: 'Ada', passwordHash: await hashSecret(password), role: 'ADMIN',
      totpEnabled: false,
      ...issued.data,
      ...over,
    },
  });
  return { row, email, token: issued.token };
}

function secretFrom(body: { otpauthUri?: string }) {
  const secret = new URL(body.otpauthUri ?? 'http://invalid').searchParams.get('secret');
  if (!secret) throw new Error('enroll response has no authenticator secret');
  return secret;
}

async function read(id: string) {
  return (prisma as PrismaClient).user.findUniqueOrThrow({ where: { id } });
}

const confirmData = {
  totpEnabled: true, recoveryCodes: [] as string[], sessionVersion: { increment: 1 }, failedLogins: 0,
  totpEnrollFails: 0, totpPendingUntil: null, enrollTokenHash: null, enrollTokenExpiresAt: null,
};

describe('enroll current state', { concurrency: 1, skip }, () => {
test('enroll keeps passwordless off and a wrong confirm does not submit', { timeout: 180_000 }, async () => {
  const member = await makeUser();
  assert.equal(member.row.passwordlessEnabled, false);
  const ip = nextIp();
  const started = await enrollPost(post('/api/auth-admin/enroll', {
    email: member.email, password, token: member.token,
  }, ip));
  assert.equal(started.status, 200);
  const secret = secretFrom(await started.json() as { otpauthUri: string });
  const pending = await read(member.row.id);
  assert.equal(pending.passwordlessEnabled, false);
  assert.equal(pending.totpEnabled, false);
  assert.equal(pending.enrollTokenHash, member.row.enrollTokenHash);
  assert.equal(pending.passwordHash, member.row.passwordHash);
  assert.equal(pending.totpSecret !== null, true);

  const wrongCode = authenticator.generate(secret) === '000000' ? '111111' : '000000';
  const rejected = await confirmPost(post('/api/auth-admin/enroll/confirm', {
    email: member.email, password, token: member.token, totp: wrongCode,
  }, nextIp()));
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { error: 'bad_totp' });
  const after = await read(member.row.id);
  assert.equal(after.passwordlessEnabled, false);
  assert.equal(after.totpEnabled, false);
  assert.equal(after.enrollTokenHash, member.row.enrollTokenHash);
  assert.equal(after.passwordHash, member.row.passwordHash);
  const still = await checkPassword(member.email, password, nextIp());
  assert.equal(typeof still === 'string', false);
});

test('an expired enroll token does not confirm', { skip, timeout: 180_000 }, async () => {
  const plain = authenticator.generateSecret();
  const member = await makeUser({
    totpSecret: encrypt(plain),
    totpPendingUntil: new Date(Date.now() + 10 * 60_000),
    enrollTokenExpiresAt: new Date(Date.now() - 1_000),
  });
  const rejected = await confirmPost(post('/api/auth-admin/enroll/confirm', {
    email: member.email, password, token: member.token, totp: authenticator.generate(plain),
  }, nextIp()));
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { error: 'bad_credentials' });
  const after = await read(member.row.id);
  assert.equal(after.totpEnabled, false);
  assert.equal(after.passwordlessEnabled, false);
  assert.equal(after.passwordHash, member.row.passwordHash);
});

test('confirm succeeds once, leaves passwordless off, and a replay does not submit', { skip, timeout: 180_000 }, async () => {
  const member = await makeUser();
  const started = await enrollPost(post('/api/auth-admin/enroll', {
    email: member.email, password, token: member.token,
  }, nextIp()));
  assert.equal(started.status, 200);
  const secret = secretFrom(await started.json() as { otpauthUri: string });
  const first = await confirmPost(post('/api/auth-admin/enroll/confirm', {
    email: member.email, password, token: member.token, totp: authenticator.generate(secret),
  }, nextIp()));
  assert.equal(first.status, 200);
  const body = await first.json() as { recoveryCodes: string[] };
  assert.equal(body.recoveryCodes.length, 10);
  const enabled = await read(member.row.id);
  assert.equal(enabled.totpEnabled, true);
  assert.equal(enabled.passwordlessEnabled, false);
  assert.equal(enabled.enrollTokenHash, null);
  assert.equal(enabled.sessionVersion, member.row.sessionVersion + 1);

  const replay = await confirmPost(post('/api/auth-admin/enroll/confirm', {
    email: member.email, password, token: member.token, totp: authenticator.generate(secret),
  }, nextIp()));
  assert.equal(replay.status, 401);
  const after = await read(member.row.id);
  assert.equal(after.totpEnabled, true);
  assert.equal(after.passwordlessEnabled, false);
  assert.equal(after.enrollTokenHash, null);
  assert.equal(after.sessionVersion, member.row.sessionVersion + 1);
  assert.equal(after.passwordHash, member.row.passwordHash);
});

test('two concurrent confirms enable the authenticator once', { skip, timeout: 180_000 }, async () => {
  const member = await makeUser();
  const started = await enrollPost(post('/api/auth-admin/enroll', {
    email: member.email, password, token: member.token,
  }, nextIp()));
  const secret = secretFrom(await started.json() as { otpauthUri: string });
  const code = authenticator.generate(secret);
  const [left, right] = await Promise.all([
    confirmPost(post('/api/auth-admin/enroll/confirm', {
      email: member.email, password, token: member.token, totp: code,
    }, nextIp())),
    confirmPost(post('/api/auth-admin/enroll/confirm', {
      email: member.email, password, token: member.token, totp: code,
    }, nextIp())),
  ]);
  assert.equal([left, right].filter((response) => response.status === 200).length, 1);
  const after = await read(member.row.id);
  assert.equal(after.totpEnabled, true);
  assert.equal(after.passwordlessEnabled, false);
  assert.equal(after.sessionVersion, member.row.sessionVersion + 1);
  assert.equal(after.enrollTokenHash, null);
});

test('two concurrent enrolls keep a single pending secret and passwordless stays off', { skip, timeout: 180_000 }, async () => {
  const member = await makeUser();
  const body = { email: member.email, password, token: member.token };
  const [left, right] = await Promise.all([
    enrollPost(post('/api/auth-admin/enroll', body, nextIp())),
    enrollPost(post('/api/auth-admin/enroll', body, nextIp())),
  ]);
  assert.equal([left, right].filter((response) => response.status === 200).length, 1);
  const after = await read(member.row.id);
  assert.equal(after.totpSecret !== null, true);
  assert.equal(after.totpEnabled, false);
  assert.equal(after.passwordlessEnabled, false);
  assert.equal(after.enrollTokenHash, member.row.enrollTokenHash);
});

test('the final enroll write rejects a stale token, version, secret, or deadline', { skip, timeout: 180_000 }, async () => {
  const client = prisma as PrismaClient;
  const encrypted = encrypt(authenticator.generateSecret());

  const bumped = await makeUser();
  await client.user.update({ where: { id: bumped.row.id }, data: { sessionVersion: { increment: 1 } } });
  assert.equal((await commitPendingSecret(bumped.row, encrypted)).count, 0);

  const rotated = await makeUser();
  await client.user.update({ where: { id: rotated.row.id }, data: { enrollTokenHash: 'ab'.repeat(32) } });
  assert.equal((await commitPendingSecret(rotated.row, encrypted)).count, 0);

  const expired = await makeUser();
  await client.user.update({ where: { id: expired.row.id }, data: { enrollTokenExpiresAt: new Date(Date.now() - 1_000) } });
  assert.equal((await commitPendingSecret(expired.row, encrypted)).count, 0);

  const replaced = await makeUser();
  await client.user.update({ where: { id: replaced.row.id }, data: { totpSecret: encrypt(authenticator.generateSecret()) } });
  assert.equal((await commitPendingSecret(replaced.row, encrypted)).count, 0);

  for (const id of [bumped.row.id, rotated.row.id, expired.row.id, replaced.row.id]) {
    const row = await read(id);
    assert.equal(row.totpEnabled, false);
    assert.equal(row.passwordlessEnabled, false);
  }
  assert.equal((await read(bumped.row.id)).totpSecret, null);

  const fresh = await makeUser();
  assert.equal((await commitPendingSecret(fresh.row, encrypted)).count, 1);
  const written = await read(fresh.row.id);
  assert.equal(written.totpSecret, encrypted);
  assert.equal(written.totpEnabled, false);
  assert.equal(written.passwordlessEnabled, false);
  assert.ok(written.totpPendingUntil && written.totpPendingUntil.getTime() > Date.now());

  const pendingSecret = encrypt(authenticator.generateSecret());
  const pendingUntil = new Date(Date.now() + 10 * 60_000);
  const confirmBumped = await makeUser({ totpSecret: pendingSecret, totpPendingUntil: pendingUntil });
  await client.user.update({ where: { id: confirmBumped.row.id }, data: { sessionVersion: { increment: 1 } } });
  assert.equal((await commitEnrollConfirmation(confirmBumped.row, confirmData)).count, 0);

  const confirmRotated = await makeUser({ totpSecret: pendingSecret, totpPendingUntil: pendingUntil });
  await client.user.update({ where: { id: confirmRotated.row.id }, data: { enrollTokenHash: 'cd'.repeat(32) } });
  assert.equal((await commitEnrollConfirmation(confirmRotated.row, confirmData)).count, 0);

  const confirmExpired = await makeUser({ totpSecret: pendingSecret, totpPendingUntil: pendingUntil });
  await client.user.update({ where: { id: confirmExpired.row.id }, data: { enrollTokenExpiresAt: new Date(Date.now() - 1_000) } });
  assert.equal((await commitEnrollConfirmation(confirmExpired.row, confirmData)).count, 0);

  const confirmReplaced = await makeUser({ totpSecret: pendingSecret, totpPendingUntil: pendingUntil });
  await client.user.update({ where: { id: confirmReplaced.row.id }, data: { totpSecret: encrypt(authenticator.generateSecret()) } });
  assert.equal((await commitEnrollConfirmation(confirmReplaced.row, confirmData)).count, 0);

  const confirmStalePending = await makeUser({ totpSecret: pendingSecret, totpPendingUntil: new Date(Date.now() - 1_000) });
  assert.equal((await commitEnrollConfirmation(confirmStalePending.row, confirmData)).count, 0);

  for (const id of [confirmBumped.row.id, confirmRotated.row.id, confirmExpired.row.id, confirmReplaced.row.id, confirmStalePending.row.id]) {
    const row = await read(id);
    assert.equal(row.totpEnabled, false);
    assert.equal(row.passwordlessEnabled, false);
  }

  const confirmFresh = await makeUser({ totpSecret: pendingSecret, totpPendingUntil: pendingUntil });
  assert.equal((await commitEnrollConfirmation(confirmFresh.row, confirmData)).count, 1);
  const confirmed = await read(confirmFresh.row.id);
  assert.equal(confirmed.totpEnabled, true);
  assert.equal(confirmed.passwordlessEnabled, false);
  assert.equal(confirmed.enrollTokenHash, null);
  assert.equal(confirmed.sessionVersion, confirmFresh.row.sessionVersion + 1);
});

test('confirm accepts a current code that keeps its leading zero', { skip, timeout: 180_000 }, async () => {
  let plain = '';
  let code = '';
  for (let i = 0; i < 500; i++) {
    plain = authenticator.generateSecret();
    code = authenticator.generate(plain);
    if (/^0[0-9]{5}$/.test(code)) break;
  }
  assert.match(code, /^0[0-9]{5}$/);
  const member = await makeUser({
    totpSecret: encrypt(plain),
    totpPendingUntil: new Date(Date.now() + 10 * 60_000),
  });
  const accepted = await confirmPost(post('/api/auth-admin/enroll/confirm', {
    email: member.email, password, token: member.token, totp: code,
  }, nextIp()));
  assert.equal(accepted.status, 200);
  const body = await accepted.json() as { recoveryCodes: string[] };
  assert.equal(body.recoveryCodes.length, 10);
  const after = await read(member.row.id);
  assert.equal(after.totpEnabled, true);
  assert.equal(after.passwordlessEnabled, false);
});
});
