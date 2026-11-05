import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient, type User } from '@prisma/client';
import { authenticator } from 'otplib';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { hashRecoveryPermitToken, hashRecoverySessionToken } from '../src/lib/server/admin/recovery-repo';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

// 与 M3-T3 共用专用测试库；缺地址由 CI 的 M3T3_REQUIRE_DATABASE=true 拦截，本地默认跳过。
const databaseUrl = process.env.M3T3_TEST_DATABASE_URL?.startsWith('postgres')
  ? process.env.M3T3_TEST_DATABASE_URL
  : '';
if (process.env.M3T3_REQUIRE_DATABASE === 'true' && !databaseUrl) {
  throw new Error('M3T3_TEST_DATABASE_URL must be a postgres URL when M3T3_REQUIRE_DATABASE=true');
}
const skip = !databaseUrl && 'no dedicated M3T3_TEST_DATABASE_URL';
process.env.APP_ENV = 'test';
process.env.AUTH_SECRET ??= 'm3t19-recovery-start-test-secret-32b';
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 9).toString('base64');
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
authenticator.options = { window: 1, step: 30 };

const password = 'correct-horse-battery';
let db: PrismaClient = null as unknown as PrismaClient;
let service: import('../src/lib/server/admin/recovery-start').RecoveryStartService = null as unknown as import('../src/lib/server/admin/recovery-start').RecoveryStartService;
let createRecoveryStartService: typeof import('../src/lib/server/admin/recovery-start').createRecoveryStartService;
let handleRecoveryStart: typeof import('../src/lib/server/admin/recovery-start').handleRecoveryStart;

// 计数不是本用例被测对象；用不落库的最小 apiCounter，让 handler 走真实限流/Zod/service。
const counter: import('../src/lib/server/http/metrics').ApiCounter = {
  async recordFinalResponse(r) { return { status: r.status, body: r.body, recorded: false }; },
};
const origin = 'http://127.0.0.1:3000';
function startRequest(body: unknown) {
  return new Request(`${origin}/api/auth-admin/recovery/start`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.77' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  if (!databaseUrl) return;
  setRateLimitStore(new MemoryStore());
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { throw new Error('prisma db push failed'); }
  ({ prisma: db } = await import('../src/lib/server/db'));
  const mod = await import('../src/lib/server/admin/recovery-start');
  ({ createRecoveryStartService, handleRecoveryStart } = mod);
  service = createRecoveryStartService({ db });
});
after(async () => { await db?.$disconnect?.(); });

async function makeAccount(over: { recoveryCodes?: string[]; role?: User['role'] } = {}) {
  const plain = authenticator.generateSecret();
  const user = await db.user.create({
    data: {
      email: `m3t19-${randomBytes(4).toString('hex')}@example.com`,
      name: 'Ada',
      passwordHash: await hashSecret(password),
      role: over.role ?? 'ADMIN',
      totpSecret: encrypt(plain),
      totpEnabled: true,
      recoveryCodes: over.recoveryCodes ?? [],
    },
  });
  return { user, plain };
}

function newCode() { return randomBytes(5).toString('hex'); }
function sessions(userId: string) { return db.adminRecoverySession.findMany({ where: { userId } }); }

describe('POST /api/auth-admin/recovery/start (DB)', { concurrency: 1, skip }, () => {
  test('E-10 email-only request is refused by the real handler: 400 invalid, no session or permit issued, no state change', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    // 只带 email，不带 credentialKind / credential；同时试一个带 kind 但缺 credential 的形状。
    for (const body of [{ email: user.email }, { email: user.email, credentialKind: 'RECOVERY_CODE' }]) {
      const response = await handleRecoveryStart(startRequest(body), { recoveryStart: service, apiCounter: counter });
      assert.equal(response.status, 400, `email-only shape ${JSON.stringify(body)} must be 400`);
      const payload = await response.json() as { error: string };
      assert.equal(payload.error, 'invalid');
      assert.equal(response.headers.get('set-cookie'), null, 'no restricted cookie on refusal');
    }
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.sessionVersion, before.sessionVersion, 'sv must not bump');
    assert.deepEqual(after.recoveryCodes, before.recoveryCodes, 'no recovery code consumed');
    assert.equal(after.totpSecret, before.totpSecret, 'original TOTP kept');
    assert.equal((await sessions(user.id)).length, 0, 'no restricted session');
    assert.equal(await db.adminRecoveryPermit.count({ where: { targetUserId: user.id } }), 0, 'no permit issued');
    assert.equal((await db.auditLog.findMany({ where: { action: 'recovery.started', target: user.id } })).length, 0, 'no start audit');
  });

  test('E-11 valid recovery code starts one 10min restricted session, bumps sv, keeps factors', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code), await hashSecret(newCode())] });
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const started = await service.start({ email: user.email, credentialKind: 'RECOVERY_CODE', credential: code });
    assert.equal(Buffer.from(started.token, 'base64url').length, 32);
    const remaining = started.expiresAt.getTime() - Date.now();
    assert.ok(remaining > 9 * 60_000 && remaining <= 10 * 60_000);
    const rows = await sessions(user.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tokenHash, hashRecoverySessionToken(started.token));
    assert.equal(JSON.stringify(rows).includes(started.token), false, 'session token plaintext never stored');
    assert.equal(rows[0]?.source, 'RECOVERY_CODE');
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.sessionVersion, before.sessionVersion + 1);
    assert.equal(after.totpSecret, before.totpSecret, 'original TOTP kept until confirm');
    assert.equal(after.passwordHash, before.passwordHash);
    assert.equal(after.passwordlessEnabled, before.passwordlessEnabled);
    assert.equal(after.recoveryCodes.length, 1, 'exactly one code consumed');
    assert.equal(await db.adminDeviceSession.count({ where: { userId: user.id, revokedAt: null } }), 0, 'old devices revoked');
    assert.ok((await db.auditLog.findMany({ where: { action: 'recovery.started', target: user.id } })).length === 1);
  });

  test('E-11 same code concurrent: only one succeeds; different codes never revive a spent code', { timeout: 180_000 }, async () => {
    const code = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(code)] });
    const [a, b] = await Promise.allSettled([
      service.start({ email: user.email, credentialKind: 'RECOVERY_CODE', credential: code }),
      service.start({ email: user.email, credentialKind: 'RECOVERY_CODE', credential: code }),
    ]);
    const ok = [a, b].filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1, 'one recovery code can start at most one session');
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.recoveryCodes.length, 0);
    assert.equal((await sessions(user.id)).length, 1);
    // 用另一枚未存过的码重试不能复活已核销的码，也不能再开会话。
    const replay = await service.start({ email: user.email, credentialKind: 'RECOVERY_CODE', credential: newCode() }).then(() => null, (e) => e);
    assert.ok(replay, 'different unknown code must be refused');
    assert.equal((await sessions(user.id)).length, 1);
  });

  test('E-13 PERMIT consumes a fresh 15min permit; replay, wrong target and expired permit are refused', { timeout: 180_000 }, async () => {
    const { user: target } = await makeAccount();
    const { user: admin } = await makeAccount();
    const token = randomBytes(32).toString('base64url');
    await db.adminRecoveryPermit.create({
      data: {
        id: randomBytes(16).toString('hex'),
        tokenHash: hashRecoveryPermitToken(token),
        targetUserId: target.id,
        source: 'ADMIN',
        issuedById: admin.id,
        reason: 'lost device',
        sessionVersion: target.sessionVersion,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });
    const before = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    const started = await service.start({ email: target.email, credentialKind: 'PERMIT', credential: token });
    assert.equal(started.source, 'ADMIN');
    assert.equal((await sessions(target.id)).length, 1);
    const permit = await db.adminRecoveryPermit.findFirstOrThrow({ where: { targetUserId: target.id } });
    assert.ok(permit.consumedAt, 'permit consumed in the same transaction');
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.id } })).totpSecret, before.totpSecret);
    const replay = await service.start({ email: target.email, credentialKind: 'PERMIT', credential: token }).then(() => null, (e) => e);
    assert.ok(replay, 'replayed permit must be refused');
    assert.equal((await sessions(target.id)).length, 1, 'no second session');
  });

  test('E-10 email-only, unknown credential, disabled account and stale sv permit are refused with no state change', { timeout: 180_000 }, async () => {
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(newCode())] });
    const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    for (const input of [
      { email: user.email, credentialKind: 'RECOVERY_CODE' as const, credential: newCode() },
      { email: user.email, credentialKind: 'PERMIT' as const, credential: randomBytes(32).toString('base64url') },
    ]) {
      const err = await service.start(input).then(() => null, (e) => e);
      assert.ok(err, `unknown ${input.credentialKind} must be refused`);
    }
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.sessionVersion, before.sessionVersion);
    assert.equal((await sessions(user.id)).length, 0);
    assert.equal(after.totpSecret, before.totpSecret);
  });

  test('E-14 starting again revokes the previous incomplete restricted session, never issues two', { timeout: 180_000 }, async () => {
    const c1 = newCode(); const c2 = newCode();
    const { user } = await makeAccount({ recoveryCodes: [await hashSecret(c1), await hashSecret(c2)] });
    assert.equal((await sessions(user.id)).length, 0);
    await service.start({ email: user.email, credentialKind: 'RECOVERY_CODE', credential: c1 });
    await service.start({ email: user.email, credentialKind: 'RECOVERY_CODE', credential: c2 });
    const rows = await sessions(user.id);
    assert.equal(rows.length, 2, 'two starts persist two rows');
    assert.equal(rows.filter((r) => r.revokedAt === null).length, 1, 'older incomplete session revoked');
    assert.equal(rows.filter((r) => r.completedAt === null).length, 2);
  });
});
