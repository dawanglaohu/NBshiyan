import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient, type User } from '@prisma/client';
import { authenticator } from 'otplib';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';
import { AppError } from '../src/lib/server/http/errors';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

// 只连本任务专用库；必执行步骤缺地址直接失败，不回退到 DATABASE_URL。
const databaseUrl = process.env.M3T3_TEST_DATABASE_URL?.startsWith('postgres')
  ? process.env.M3T3_TEST_DATABASE_URL
  : '';
if (process.env.M3T3_REQUIRE_DATABASE === 'true' && !databaseUrl) {
  throw new Error('M3T3_TEST_DATABASE_URL must be a postgres URL when M3T3_REQUIRE_DATABASE=true');
}
const skip = !databaseUrl && 'no dedicated M3T3_TEST_DATABASE_URL';
process.env.APP_ENV = 'test';
process.env.AUTH_SECRET ??= 'm3t3-action-grant-test-secret-32b';
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 9).toString('base64');
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
authenticator.options = { window: 1, step: 30 };

const password = 'correct-horse-battery';
const start = new Date('2026-03-01T00:00:00.000Z');
let now = start;
let db: PrismaClient = null as unknown as PrismaClient;
let service: import('../src/lib/server/admin/action-grant').ActionGrantService = null as unknown as import('../src/lib/server/admin/action-grant').ActionGrantService;
let consumeTotpStep: typeof import('../src/lib/server/admin/login').consumeTotpStep = async () => { throw new Error('login not loaded'); };

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
  const loaded = await import('../src/lib/server/db');
  db = loaded.prisma;
  const { createActionGrantService } = await import('../src/lib/server/admin/action-grant');
  ({ consumeTotpStep } = await import('../src/lib/server/admin/login'));
  service = createActionGrantService({ clock: () => now });
});

after(async () => { await db?.$disconnect?.(); });

async function makeAccount(role: User['role'] = 'ADMIN') {
  const plain = authenticator.generateSecret();
  const user = await db.user.create({
    data: {
      email: `m3t3-${randomBytes(4).toString('hex')}@example.com`,
      name: 'Ada',
      passwordHash: await hashSecret(password),
      role,
      totpSecret: encrypt(plain),
      totpEnabled: true,
    },
  });
  const device = await db.adminDeviceSession.create({
    data: {
      id: randomBytes(24).toString('base64url'),
      userId: user.id,
      sessionVersion: user.sessionVersion,
      remembered: false,
      createdAt: start,
      lastActivityAt: start,
      hardExpiresAt: new Date(start.getTime() + ADMIN_SESSION_POLICY.ordinaryAbsoluteMs),
    },
  });
  return { user, device, plain };
}

async function grants(userId: string) {
  return db.adminActionGrant.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
}

describe('action grant consumption', { concurrency: 1, skip }, () => {
  test('a spent authenticator step does not issue another grant', { timeout: 180_000 }, async () => {
    now = start;
    const member = await makeAccount();
    const code = authenticator.generate(member.plain);
    assert.equal(await consumeTotpStep(member.user, code), true);
    await assert.rejects(() => service.issue({
      userId: member.user.id, sid: member.device.id, purpose: 'PASSWORD', password, totp: code,
    }), (error: unknown) => error instanceof AppError && error.code === 'bad_credentials');
    assert.equal((await grants(member.user.id)).length, 0);
    const activity = await db.adminDeviceSession.findUniqueOrThrow({ where: { id: member.device.id } });
    assert.equal(activity.lastActivityAt.toISOString(), start.toISOString());
  });

  test('E-73 E-74 one transaction consumes a matching grant once and leaves mismatches unused', { timeout: 180_000 }, async () => {
    now = start;
    const member = await makeAccount();
    const other = await makeAccount();
    const firstCode = unusedCode(member.plain, null);
    const issued = await service.issue({
      userId: member.user.id, sid: member.device.id, purpose: 'PASSWORD', password, totp: firstCode,
    });
    assert.equal(Buffer.from(issued.token, 'base64url').length, 32);
    assert.equal(issued.expiresAt.toISOString(), new Date(start.getTime() + 5 * 60_000).toISOString());
    const stored = (await grants(member.user.id))[0];
    assert.ok(stored);
    assert.equal(stored.tokenHash.length, 64);
    assert.equal(JSON.stringify(stored).includes(issued.token), false);
    assert.equal(stored.targetId, null);
    assert.equal(stored.usedAt, null);
    assert.equal(stored.sessionVersion, member.user.sessionVersion);

    const base = {
      token: issued.token, purpose: 'PASSWORD' as const, targetId: null, userId: member.user.id, sid: member.device.id,
    };
    assert.equal(await service.consume({ ...base, purpose: 'LOGIN_MODE' }), false);
    assert.equal(await service.consume({ ...base, targetId: other.user.id }), false);
    assert.equal(await service.consume({ ...base, userId: other.user.id, sid: other.device.id }), false);
    assert.equal(await service.consume({ ...base, sid: other.device.id }), false);
    now = issued.expiresAt;
    assert.equal(await service.consume(base), false);
    await db.adminDeviceSession.update({ where: { id: member.device.id }, data: { revokedAt: issued.expiresAt } });
    now = new Date(start.getTime() + 60_000);
    assert.equal(await service.consume(base), false);
    await db.adminDeviceSession.update({ where: { id: member.device.id }, data: { revokedAt: null } });
    await db.user.update({ where: { id: member.user.id }, data: { sessionVersion: { increment: 1 } } });
    assert.equal(await service.consume(base), false);
    await db.user.update({ where: { id: member.user.id }, data: { sessionVersion: member.user.sessionVersion } });
    const untouched = (await grants(member.user.id))[0];
    assert.equal(untouched?.usedAt, null);

    now = new Date(issued.expiresAt.getTime() - 1);
    assert.equal(await service.consume(base), true);
    assert.equal(await service.consume(base), false);
    const used = (await grants(member.user.id))[0];
    assert.equal(used?.usedAt?.toISOString(), now.toISOString());
    const activity = await db.adminDeviceSession.findUniqueOrThrow({ where: { id: member.device.id } });
    assert.equal(activity.lastActivityAt.toISOString(), start.toISOString());
    assert.equal(activity.hardExpiresAt?.toISOString(), new Date(start.getTime() + ADMIN_SESSION_POLICY.ordinaryAbsoluteMs).toISOString());
  });

  test('two consumers of one grant and two issuers of one step each succeed once', { timeout: 180_000 }, async () => {
    now = start;
    const member = await makeAccount();
    const code = unusedCode(member.plain, null);
    const issued = await service.issue({
      userId: member.user.id, sid: member.device.id, purpose: 'LOGOUT_ALL', password, totp: code,
    });
    const input = {
      token: issued.token, purpose: 'LOGOUT_ALL' as const, targetId: null, userId: member.user.id, sid: member.device.id,
    };
    const consumed = await Promise.all([service.consume(input), service.consume(input)]);
    assert.deepEqual(consumed.slice().sort(), [false, true]);
    assert.equal((await grants(member.user.id)).filter((row) => row.usedAt).length, 1);

    const again = await makeAccount();
    const shared = unusedCode(again.plain, null);
    const calls = [0, 1].map(() => service.issue({
      userId: again.user.id, sid: again.device.id, purpose: 'TOTP_RESET', password, totp: shared,
    }));
    const settled = await Promise.allSettled(calls);
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((item) => item.status === 'rejected').length, 1);
    assert.equal((await grants(again.user.id)).length, 1);
  });

  test('only an admin can bind recovery to someone else, and a wrong password does not spend the code', { timeout: 180_000 }, async () => {
    now = start;
    const admin = await makeAccount('ADMIN');
    const sales = await makeAccount('SALES');
    const target = await makeAccount('EDITOR');
    const salesCode = unusedCode(sales.plain, null);
    await assert.rejects(() => service.issue({
      userId: sales.user.id, sid: sales.device.id, purpose: 'RECOVERY_AUTHORIZE', targetId: target.user.id,
      password, totp: salesCode,
    }), (error: unknown) => error instanceof AppError && error.code === 'forbidden');
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: sales.user.id } })).totpLastStep, null);
    assert.equal((await grants(sales.user.id)).length, 0);

    const selfCode = unusedCode(admin.plain, null);
    await assert.rejects(() => service.issue({
      userId: admin.user.id, sid: admin.device.id, purpose: 'RECOVERY_AUTHORIZE', targetId: admin.user.id,
      password, totp: selfCode,
    }), (error: unknown) => error instanceof AppError && error.code === 'forbidden');
    const foreign = unusedCode(admin.plain, null);
    await assert.rejects(() => service.issue({
      userId: admin.user.id, sid: admin.device.id, purpose: 'LOGIN_MODE', targetId: target.user.id,
      password, totp: foreign,
    }), (error: unknown) => error instanceof AppError && error.code === 'forbidden');
    const wrong = unusedCode(admin.plain, null);
    await assert.rejects(() => service.issue({
      userId: admin.user.id, sid: admin.device.id, purpose: 'PASSWORD', password: 'wrong-password-value', totp: wrong,
    }), (error: unknown) => error instanceof AppError && error.code === 'bad_credentials');
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: admin.user.id } })).totpLastStep, null);

    const okCode = unusedCode(admin.plain, null);
    const issued = await service.issue({
      userId: admin.user.id, sid: admin.device.id, purpose: 'RECOVERY_AUTHORIZE', targetId: target.user.id,
      password, totp: okCode,
    });
    const row = (await grants(admin.user.id))[0];
    assert.equal(row?.purpose, 'RECOVERY_AUTHORIZE');
    assert.equal(row?.targetId, target.user.id);
    assert.equal(await service.consume({
      token: issued.token, purpose: 'PASSWORD', targetId: target.user.id, userId: admin.user.id, sid: admin.device.id,
    }), false);
    assert.equal(await service.consume({
      token: issued.token, purpose: 'RECOVERY_AUTHORIZE', targetId: target.user.id, userId: admin.user.id, sid: admin.device.id,
    }), true);
    const audit = await db.auditLog.findFirstOrThrow({ where: { actorId: admin.user.id, action: 'account.reauth_issued' } });
    const auditText = JSON.stringify(audit);
    assert.equal(auditText.includes(issued.token), false);
    assert.equal(auditText.includes(password), false);
    assert.equal(auditText.includes(okCode), false);
  });

  test('deleting the account removes the grant and does not keep the device row', { timeout: 180_000 }, async () => {
    now = start;
    const member = await makeAccount();
    const code = unusedCode(member.plain, null);
    await service.issue({
      userId: member.user.id, sid: member.device.id, purpose: 'LOGIN_MODE', password, totp: code,
    });
    await db.user.delete({ where: { id: member.user.id } });
    assert.equal(await db.adminActionGrant.count({ where: { userId: member.user.id } }), 0);
    assert.equal(await db.adminDeviceSession.count({ where: { id: member.device.id } }), 0);
  });

  test('E-74 real PostgreSQL lock waits cannot consume expired grants or devices', { timeout: 60_000 }, async () => {
    const { createActionGrantService } = await import('../src/lib/server/admin/action-grant');
    // 缩短测试授权 TTL；时钟、事务、行锁和消费都是真实实现，生产的 5 分钟策略不变。
    const live = createActionGrantService({ db, grantTtlMs: 2_000 });
    async function liveAccount() {
      const member = await makeAccount();
      const opened = new Date();
      await db.adminDeviceSession.update({ where: { id: member.device.id }, data: {
        createdAt: opened, lastActivityAt: opened,
        hardExpiresAt: new Date(opened.getTime() + ADMIN_SESSION_POLICY.ordinaryAbsoluteMs),
      } });
      return member;
    }
    const control = await liveAccount();
    try {
      const grant = await live.issue({ userId: control.user.id, sid: control.device.id, purpose: 'PASSWORD', password, totp: unusedCode(control.plain, null) });
      const input = { token: grant.token, purpose: 'PASSWORD' as const, targetId: null, userId: control.user.id, sid: control.device.id };
      assert.ok(Date.now() < grant.expiresAt.getTime());
      assert.equal(await live.consume(input), true);
      assert.equal(await live.consume(input), false);
    } finally {
      await db.user.delete({ where: { id: control.user.id } });
    }

    for (const lock of ['User', 'Device'] as const) {
      for (const expiry of ['grant', 'device'] as const) {
        const member = await liveAccount();
        const locker = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let lockReady!: (pid: number) => void;
        let lockFailed!: (error: unknown) => void;
        const ready = new Promise<number>((resolve, reject) => { lockReady = resolve; lockFailed = reject; });
        let locking: Promise<unknown> | undefined;
        let consuming: Promise<boolean> | undefined;
        let settled = false;
        try {
          const grantService = expiry === 'grant' ? live : createActionGrantService({ db });
          const grant = await grantService.issue({ userId: member.user.id, sid: member.device.id, purpose: 'PASSWORD', password, totp: unusedCode(member.plain, null) });
          const deadline = expiry === 'grant' ? grant.expiresAt : new Date(Date.now() + 2_000);
          if (expiry === 'device') await db.adminDeviceSession.update({ where: { id: member.device.id }, data: { hardExpiresAt: deadline } });
          const input = { token: grant.token, purpose: 'PASSWORD' as const, targetId: null, userId: member.user.id, sid: member.device.id };
          locking = locker.$transaction(async (tx) => {
            const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            if (lock === 'User') await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${member.user.id} FOR UPDATE`;
            else await tx.$queryRaw`SELECT id FROM "AdminDeviceSession" WHERE id = ${member.device.id} FOR UPDATE`;
            lockReady(backend.pid);
            await held;
          }, { timeout: 20_000 });
          void locking.catch(lockFailed);
          const blockerPid = await ready;
          let consumerReady!: (pid: number) => void;
          let consumerFailed!: (error: unknown) => void;
          const consumerStarted = new Promise<number>((resolve, reject) => { consumerReady = resolve; consumerFailed = reject; });
          consuming = db.$transaction(async (tx) => {
            const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            consumerReady(backend.pid);
            return grantService.consume(input, tx);
          }, { timeout: 20_000 }).finally(() => { settled = true; });
          void consuming.catch(consumerFailed);
          const consumerPid = await consumerStarted;
          assert.notEqual(consumerPid, blockerPid);
          const waiting = async () => {
            const [backend] = await db.$queryRaw<{ blockers: number[]; waitType: string | null }[]>`
              SELECT pg_blocking_pids(pid) AS blockers, wait_event_type AS "waitType"
              FROM pg_stat_activity WHERE pid = ${consumerPid}
            `;
            return backend?.waitType === 'Lock' && backend.blockers.includes(blockerPid);
          };
          const observeUntil = Date.now() + 5_000;
          while (!(await waiting())) {
            assert.equal(settled, false, 'consume completed without the expected PostgreSQL lock wait');
            assert.ok(Date.now() < observeUntil, 'PostgreSQL never confirmed the consumer blocking on the independent holder');
            await delay(10);
          }
          const waitingAt = Date.now();
          assert.ok(waitingAt < deadline.getTime(), 'lock wait must be witnessed before the deadline');
          // 按实际到期条件等待，不把固定 sleep 当成行锁证据；到期后再次核对同一 blocker。
          while (Date.now() <= deadline.getTime()) await delay(10);
          assert.equal(await waiting(), true);
          assert.equal(settled, false);
          const releasedAt = Date.now();
          release();
          await locking;
          assert.equal(await consuming, false);
          assert.equal((await db.adminActionGrant.findUniqueOrThrow({ where: { tokenHash: (await grants(member.user.id))[0].tokenHash } })).usedAt, null);
          console.log(`ACTION_GRANT_LOCK_EXPIRY_EVIDENCE ${JSON.stringify({ lock, expiry, blockerPid, consumerPid, waitingAt, expiresAt: deadline.toISOString(), releasedAt, consumed: false, usedAt: null })}`);
        } finally {
          release();
          await locking?.catch(() => {});
          await consuming?.catch(() => {});
          await locker.$disconnect();
          await db.user.delete({ where: { id: member.user.id } });
        }
      }
    }
  });
});
