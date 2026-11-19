import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';
import { PrismaClient, Prisma } from '@prisma/client';
import { createNotificationRepo, notificationToken, type NotificationDb, type NotificationRepo } from '../src/lib/server/chat/notification-repo';
import { processChatNotifications, NotificationPreSendFailure } from '../src/lib/server/chat/notification-service';
import { CHAT_NOTIFICATION_LEASE_MS, CHAT_NOTIFICATION_BACKOFF_MS, NotificationBudgetExceeded } from '../src/lib/server/chat/notification-policy';

const supplied = process.env.B10_M4T4_TEST_DATABASE_URL;
function loopback(value: string | undefined): value is string {
  try { const u = new URL(value ?? ''); return ['postgres:', 'postgresql:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname); } catch { return false; }
}
if (process.env.CHAT_REQUIRE_DATABASE === 'true' && !loopback(supplied)) throw new Error('B10_M4T4_TEST_DATABASE_URL must be a dedicated loopback PostgreSQL URL');
const skip = !loopback(supplied) && 'dedicated loopback B10_M4T4_TEST_DATABASE_URL unavailable';
const require = createRequire(import.meta.url);
const initial = new Date('2026-11-19T12:00:00.123Z');
let time = initial.getTime();
let conn: PrismaClient;
let admin: PrismaClient;
let schema = '';
let owned = false;
let probeInstalled = false;
let probeBefore = 0;
let expectedProbeDelta = 0;
let expectedCapId: string | null = null;
const clock = () => new Date(time);

function configuredDb(db: PrismaClient, onTransaction?: (tx: Prisma.TransactionClient) => Promise<void>, wrap?: (tx: Prisma.TransactionClient) => Prisma.TransactionClient): NotificationDb {
  return {
    chatMessage: db.chatMessage,
    $transaction: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>, options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) => db.$transaction(async (tx) => {
      const zone = process.env.M4T4_PG_SESSION_TZ;
      if (zone) {
        await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`;
        const settings = await tx.$queryRaw<{ zone: string }[]>`SELECT current_setting('TimeZone') AS zone`;
        assert.equal(settings[0].zone, zone);
      }
      await onTransaction?.(tx);
      return work(wrap ? wrap(tx) : tx);
    }, options),
  } as NotificationDb;
}
function repo(onClock = clock, db = configuredDb(conn)): NotificationRepo { return createNotificationRepo({ db, clock: onClock, env: {} }); }
async function stored(id: string) { return conn.chatNotification.findUniqueOrThrow({ where: { id } }); }
async function seed(data: Partial<Prisma.ChatNotificationUncheckedCreateInput> = {}) {
  const visitor = randomUUID(), conversation = randomUUID(), message = randomUUID(), id = randomUUID();
  await conn.chatVisitorSession.create({ data: { id: visitor, tokenHash: createHash('sha256').update(visitor).digest('hex'), createdAt: clock(), lastActivityAt: clock(), absoluteExpiresAt: new Date(time + 86400000) } });
  await conn.chatConversation.create({ data: { id: conversation, visitorSessionId: visitor, clientConversationId: randomUUID(), createPayloadHash: 'a'.repeat(64), locale: 'en', lastSeq: 1, createdAt: clock(), updatedAt: clock(), lastActivityAt: clock(), retainUntil: new Date(time + 86400000) } });
  await conn.chatMessage.create({ data: { id: message, conversationId: conversation, seq: 1, sender: 'VISITOR', clientMessageId: randomUUID(), payloadHash: 'b'.repeat(64), bodyText: 'private-body-probe', createdAt: clock() } });
  return conn.chatNotification.create({ data: { id, conversationId: conversation, messageId: message, stableMessageId: `<${message}@notifications.example.test>`, availableAt: clock(), createdAt: clock(), updatedAt: clock(), ...data } });
}
async function started(attempts = 1) {
  const row = await seed({ attempts: attempts - 1 });
  const r = repo(); const claimed = await r.claimDue('owner-a'); assert.equal(claimed?.id, row.id);
  const result = await r.startAttempt(notificationToken(claimed!)); assert.ok(result);
  return result;
}
async function probe() {
  const rows = await conn.$queryRawUnsafe<{ last_value: bigint; is_called: boolean }[]>(`SELECT last_value,is_called FROM "${schema}"."m4t4_cap_probe"`);
  return rows[0].is_called ? Number(rows[0].last_value) : 0;
}
async function invariants() {
  const rows = await conn.chatNotification.findMany();
  const bad = rows.filter((r) => r.attempts > 4 || (r.status === 'SENDING' && (!r.lockedUntil || !r.leaseOwner || (r.requestStartedAt === null && r.attempts >= 4))));
  const cap = rows.filter((r) => r.status === 'QUEUED' && r.attempts >= 4);
  return { bad: bad.map((r) => r.id), cap: cap.map((r) => r.id) };
}
async function installProbe() {
  // Four statements, each executed separately; function body is not split on semicolons.
  await conn.$executeRawUnsafe(`CREATE SEQUENCE "${schema}"."m4t4_cap_probe" AS bigint START 1`);
  await conn.$executeRawUnsafe(`CREATE TABLE "${schema}"."m4t4_ac15_exemption" ("singleton" boolean PRIMARY KEY CHECK ("singleton"), "notificationId" text NOT NULL,"armed" boolean NOT NULL DEFAULT true)`);
  await conn.$executeRawUnsafe(`CREATE FUNCTION "${schema}"."m4t4_reject_queued_cap"() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
    BEGIN
      IF NEW."status"::text='QUEUED' AND NEW."attempts">=4 THEN
        IF TG_OP='INSERT' THEN
          UPDATE "${schema}"."m4t4_ac15_exemption" SET "armed"=false WHERE "singleton"=true AND "armed"=true AND "notificationId"=NEW."id";
          IF FOUND THEN RETURN NEW; END IF;
        END IF;
        PERFORM pg_catalog.nextval('"${schema}"."m4t4_cap_probe"'::pg_catalog.regclass);
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='M4T4_QUEUED_CAP_INVARIANT';
      END IF;
      RETURN NEW;
    END; $fn$`);
  await conn.$executeRawUnsafe(`CREATE TRIGGER m4t4_reject_queued_cap BEFORE INSERT OR UPDATE ON "${schema}"."ChatNotification" FOR EACH ROW EXECUTE FUNCTION "${schema}"."m4t4_reject_queued_cap"()`);
}

before(async () => {
  if (skip) return;
  admin = new PrismaClient({ datasources: { db: { url: supplied! } } });
  const version = await admin.$queryRaw<{ version: string }[]>`SELECT current_setting('server_version_num') AS version`;
  assert.equal(Math.floor(Number(version[0].version) / 10000), 17, 'dedicated PostgreSQL 17 required');
  schema = `chatnotify_${process.pid}_${randomBytes(4).toString('hex')}`;
  const present = await admin.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM pg_namespace WHERE nspname=${schema}`;
  assert.equal(present.length, 0, 'refuse to claim a pre-existing schema');
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); owned = true;
  const u = new URL(supplied!); u.searchParams.set('schema', schema); u.searchParams.set('connection_limit', '8');
  const child = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: u.href }, encoding: 'utf8' });
  assert.equal(child.status, 0, 'owned-schema Prisma initialization failed');
  conn = new PrismaClient({ datasources: { db: { url: u.href } } });
  await installProbe(); probeInstalled = true;
});
after(async () => {
  if (owned && probeInstalled) {
    assert.match(schema, /^chatnotify_\d+_[a-f0-9]{8}$/);
    await conn.$executeRawUnsafe(`DROP TRIGGER m4t4_reject_queued_cap ON "${schema}"."ChatNotification"`);
    await conn.$executeRawUnsafe(`DROP FUNCTION "${schema}"."m4t4_reject_queued_cap"()`);
    await conn.$executeRawUnsafe(`DROP TABLE "${schema}"."m4t4_ac15_exemption"`);
    await conn.$executeRawUnsafe(`DROP SEQUENCE "${schema}"."m4t4_cap_probe"`);
  }
  await conn?.$disconnect();
  if (admin && owned) { assert.match(schema, /^chatnotify_\d+_[a-f0-9]{8}$/); await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
  await admin?.$disconnect();
});

describe('M4-T4 notification PostgreSQL', { skip, concurrency: false, timeout: 180000 }, () => {
  beforeEach(async () => {
    await conn.chatNotification.deleteMany(); await conn.chatMessage.deleteMany(); await conn.chatConversation.deleteMany(); await conn.chatVisitorSession.deleteMany();
    await conn.$executeRawUnsafe(`DELETE FROM "${schema}"."m4t4_ac15_exemption"`);
    time = initial.getTime(); expectedCapId = null; expectedProbeDelta = 0; probeBefore = await probe();
  });
  afterEach(async () => {
    const state = await invariants(); assert.deepEqual(state.bad, []);
    assert.deepEqual(state.cap, expectedCapId ? [expectedCapId] : []);
    assert.equal((await probe()) - probeBefore, expectedProbeDelta);
  });

  test('AC1/S1：写回后1m、毫秒到期边界、重复pre-send不计次', async () => {
    const row = await started(); const r = repo(); const token = notificationToken(row);
    assert.equal(await r.startAttempt(token), null);
    assert.equal(await r.finish(token, { kind: 'retry', code: 'CHAT_SMTP_TEMPORARY' }), true);
    const queued = await stored(row.id); assert.equal(queued.availableAt.getTime(), time + 60000);
    assert.equal(queued.updatedAt.getTime(), time); assert.equal(queued.leaseOwner, null); assert.equal(queued.lockedUntil, null); assert.ok(queued.requestStartedAt);
    time = queued.availableAt.getTime() - 1; assert.equal(await r.claimDue('owner-b'), null);
    time++; const next = await r.claimDue('owner-b'); assert.ok(next); assert.equal(next.attempts, 1); assert.equal(next.requestStartedAt, null);
    assert.equal((await r.startAttempt(notificationToken(next)))?.attempts, 2);
  });

  test('AC3/AC2：延迟sweep按锁后时钟为attempts1/2/3写三档，同ID重领', async () => {
    for (const attempts of [1, 2, 3]) {
      const row = await started(attempts); const stable = row.stableMessageId;
      time += 600000; await repo().recoverExpiredLease(clock());
      const unknown = await stored(row.id); assert.equal(unknown.status, 'UNKNOWN');
      assert.equal(unknown.availableAt.getTime(), time + CHAT_NOTIFICATION_BACKOFF_MS[attempts - 1]);
      assert.equal(await repo().claimDue('owner-b'), null);
      time = unknown.availableAt.getTime(); await repo().promoteUnknown(clock());
      const claimed = await repo().claimDue('owner-b'); assert.ok(claimed); assert.equal(claimed.stableMessageId, stable);
      const next = await repo().startAttempt(notificationToken(claimed)); assert.equal(next?.attempts, attempts + 1);
      await repo().finish(notificationToken(next!), { kind: 'sent' });
    }
  });

  test('AC2b/AC11b：空marker立即回队、不计次，缺配置的零次行随后DISABLED', async () => {
    const source = await seed(); const claimed = await repo().claimDue('owner-a'); assert.ok(claimed);
    time += CHAT_NOTIFICATION_LEASE_MS; await repo().recoverExpiredLease(clock());
    const queued = await stored(source.id); assert.equal(queued.status, 'QUEUED'); assert.equal(queued.attempts, 0); assert.equal(queued.availableAt.getTime(), time);
    await repo().disableNeverStartedQueued(); assert.equal((await stored(source.id)).status, 'DISABLED');
  });

  test('AC4：连续4次暂拒，第四次单CAS直FAILED，无中间QUEUED4和第五次', async () => {
    const source = await seed(); const r = repo();
    for (let n = 1; n <= 4; n++) {
      const claim = await r.claimDue('owner-a'); assert.ok(claim); const active = await r.startAttempt(notificationToken(claim)); assert.equal(active?.attempts, n);
      const oldAvailable = active!.availableAt.getTime();
      await r.finish(notificationToken(active!), { kind: 'retry', code: 'CHAT_SMTP_TEMPORARY' });
      const saved = await stored(source.id);
      if (n < 4) { assert.equal(saved.status, 'QUEUED'); assert.equal(saved.availableAt.getTime(), time + CHAT_NOTIFICATION_BACKOFF_MS[n - 1]); time = saved.availableAt.getTime(); }
      else { assert.equal(saved.status, 'FAILED'); assert.equal(saved.availableAt.getTime(), oldAvailable); }
    }
    assert.equal(await r.claimDue('owner-b'), null); assert.equal(await probe(), probeBefore);
  });

  test('AC5：第四次运行中断后从租约清扫到UNKNOWN，availableAt不变，无第五次', async () => {
    const row = await started(4); const old = row.availableAt.getTime();
    time = row.lockedUntil!.getTime();
    assert.equal(await repo().recoverExpiredLease(clock()), 1);
    const saved = await stored(row.id); assert.equal(saved.status, 'UNKNOWN'); assert.equal(saved.availableAt.getTime(), old);
    assert.equal(saved.attempts, 4);
    time += 86400000; assert.equal(await repo().promoteUnknown(clock()), 0); assert.equal(await repo().claimDue('owner-b'), null);
  });

  test('AC6a-e：owner/version/status/等号过期负控及有效令牌正控', async () => {
    const row = await started(); const token = notificationToken(row); const r = repo();
    for (const invalid of [{ ...token, owner: 'other' }, { ...token, leaseVersion: token.leaseVersion - 1 }]) {
      const before = await stored(row.id); assert.equal(await r.finish(invalid, { kind: 'sent' }), false); assert.deepEqual(await stored(row.id), before);
    }
    for (const status of ['QUEUED', 'UNKNOWN'] as const) {
      await conn.chatNotification.update({ where: { id: row.id }, data: { status } });
      const before = await stored(row.id); assert.equal(await r.finish(token, { kind: 'sent' }), false); assert.deepEqual(await stored(row.id), before);
    }
    await conn.chatNotification.update({ where: { id: row.id }, data: { status: 'SENDING' } });
    const oldTime = time; time = row.lockedUntil!.getTime();
    assert.equal(await r.finish(token, { kind: 'sent' }), false); time = oldTime;
    assert.equal(await r.finish(token, { kind: 'sent' }), true); assert.equal(await r.finish(token, { kind: 'sent' }), false);
    const sent = await stored(row.id); assert.equal(sent.lastErrorCode, null); assert.equal(sent.updatedAt.getTime(), time);
  });

  test('AC6f/K3：同owner真实重领version增加，旧0新1', async () => {
    const old = await started(); time = old.lockedUntil!.getTime(); await repo().recoverExpiredLease(clock());
    time = (await stored(old.id)).availableAt.getTime(); await repo().promoteUnknown(clock());
    const next = await repo().claimDue('owner-a'); assert.ok(next); assert.equal(next.leaseVersion, old.leaseVersion + 1);
    const before = await stored(old.id); assert.equal(await repo().finish(notificationToken(old), { kind: 'sent' }), false); assert.deepEqual(await stored(old.id), before);
    const marked = await repo().startAttempt(notificationToken(next)); assert.ok(marked);
    assert.equal(await repo().finish(notificationToken(marked), { kind: 'sent' }), true);
  });

  test('AC7/K2：精确阻塞pid、锁后时钟及now/旧参数对照0/1/1', async () => {
    for (const mode of ['product', 'positive', 'transaction-time', 'old-parameter'] as const) {
      const L = Date.now() + 60000; time = L - 5000;
      const row = await started(); await conn.chatNotification.update({ where: { id: row.id }, data: { lockedUntil: new Date(L) } });
      let release!: () => void, ready!: () => void;
      const releaseGate = new Promise<void>((r) => { release = r; }); const lockReady = new Promise<void>((r) => { ready = r; });
      let p1 = 0, p2 = 0; const rollback = new Error('controlled_rollback');
      const held = conn.$transaction(async (tx) => { p1 = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid; await tx.$queryRaw`SELECT "id" FROM "ChatNotification" WHERE "id"=${row.id} FOR UPDATE`; ready(); await releaseGate; throw rollback; }, { timeout: 10000 }).catch((e: unknown) => { if (e !== rollback) throw e; });
      await lockReady;
      let sampled = 0; const beforeParameter = clock();
      const observed = configuredDb(conn, async (tx) => { p2 = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid; });
      const original = await stored(row.id);
      const product = mode === 'product' || mode === 'positive';
      const action = product ? repo(() => { sampled++; return clock(); }, observed).finish(notificationToken(row), { kind: 'sent' }) : observed.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ChatNotification" WHERE "id"=${row.id} FOR UPDATE`;
        const condition = mode === 'transaction-time' ? Prisma.sql`CURRENT_TIMESTAMP AT TIME ZONE 'UTC'` : Prisma.sql`${beforeParameter.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
        return (await tx.$executeRaw`UPDATE "ChatNotification" SET "status"='SENT'::"ChatNotificationStatus", "updatedAt"=${condition} WHERE "id"=${row.id} AND "status"='SENDING'::"ChatNotificationStatus" AND "leaseOwner"=${row.leaseOwner} AND "leaseVersion"=${row.leaseVersion} AND "lockedUntil">${condition}`) === 1;
      });
      try {
        const end = Date.now() + 1000; let blocked = false;
        while (Date.now() < end) {
          if (p2) { const locks = await conn.$queryRaw<{ pids: number[] }[]>`SELECT pg_blocking_pids(${p2}) AS pids`; if (locks[0].pids.includes(p1)) { blocked = true; break; } }
          await delay(10);
        }
        assert.ok(blocked, 'C2 must be blocked by this exact C1'); assert.equal(sampled, 0);
        const real = await conn.$queryRaw<{ t: Date }[]>`SELECT CURRENT_TIMESTAMP AS t`; assert.ok(real[0].t.getTime() < L);
        if (mode !== 'positive') time = L + 1000;
      } finally { release(); await held; }
      assert.equal(await action, mode !== 'product');
      if (product) assert.equal(sampled, 1);
      if (mode === 'product') assert.deepEqual(await stored(row.id), original);
      await conn.chatNotification.delete({ where: { id: row.id } });
    }
  });

  test('AC7b：L写回0可清扫，L-1ms清扫0仍可写回1', async () => {
    const a = await started(); time = a.lockedUntil!.getTime();
    assert.equal(await repo().finish(notificationToken(a), { kind: 'sent' }), false);
    assert.equal(await repo().recoverExpiredLease(clock()), 1);
    const b = await started(); time = b.lockedUntil!.getTime() - 1;
    assert.equal(await repo().recoverExpiredLease(clock()), 0); assert.equal(await repo().finish(notificationToken(b), { kind: 'sent' }), true);
  });

  test('AC8：新出箱缺配置DISABLED，恢复不补建、不补发', async () => {
    const source = await seed(); await repo().disableNeverStartedQueued();
    assert.equal((await stored(source.id)).status, 'DISABLED'); assert.equal(await repo().claimDue('a'), null); assert.equal(await conn.chatNotification.count(), 1);
  });
  test('AC9：UNKNOWN缺配置逐列保持，恢复后同稳定ID发送', async () => {
    const row = await seed({ status: 'UNKNOWN', attempts: 1, requestStartedAt: clock() }); const before = await stored(row.id);
    await repo().disableNeverStartedQueued(); assert.deepEqual(await stored(row.id), before);
    await repo().promoteUnknown(clock()); const next = await repo().claimDue('a'); assert.equal(next?.stableMessageId, row.stableMessageId);
  });
  test('AC10：曾尝试QUEUED缺配置保持，恢复按due且attempts不重置', async () => {
    const row = await seed({ attempts: 1, requestStartedAt: clock() }); const before = await stored(row.id);
    await repo().disableNeverStartedQueued(); assert.deepEqual(await stored(row.id), before);
    const next = await repo().claimDue('a'); assert.ok(next); assert.equal((await repo().startAttempt(notificationToken(next)))?.attempts, 2);
  });
  test('AC11：缺配置仍先清扫两类SENDING，attempts1均不DISABLED', async () => {
    const marked = await seed({ status: 'SENDING', attempts: 1, leaseOwner: 'a', lockedUntil: clock(), requestStartedAt: clock() });
    const empty = await seed({ status: 'SENDING', attempts: 1, leaseOwner: 'a', lockedUntil: clock() });
    await repo().recoverExpiredLease(clock()); await repo().disableNeverStartedQueued();
    assert.equal((await stored(marked.id)).status, 'UNKNOWN'); assert.equal((await stored(empty.id)).status, 'QUEUED');
  });
  test('AC12：已标记后不可观测中断UNKNOWN，确知未调用则按已知失败', async () => {
    const dead = await started(); time = dead.lockedUntil!.getTime(); await repo().recoverExpiredLease(clock()); assert.equal((await stored(dead.id)).status, 'UNKNOWN');
    const live = await started(); await repo().finish(notificationToken(live), { kind: 'retry', code: 'CHAT_PRE_SEND_FAULT' }); assert.equal((await stored(live.id)).status, 'QUEUED');
  });
  test('AC13：cap UNKNOWN配置缺失/恢复均保持，不提升不认领', async () => {
    const row = await seed({ status: 'UNKNOWN', attempts: 4, requestStartedAt: clock() }); const before = await stored(row.id);
    await repo().disableNeverStartedQueued(); await repo().promoteUnknown(clock()); assert.deepEqual(await stored(row.id), before); assert.equal(await repo().claimDue('a'), null);
  });
  test('AC14：received/消息/读游标不变，通知最小投影无正文邮箱token', async () => {
    const row = await started(); const beforeMessage = await conn.chatMessage.findUnique({ where: { id: row.messageId } }); const beforeConversation = await conn.chatConversation.findUnique({ where: { id: row.conversationId } });
    const content = await repo().loadContent(row); assert.ok(content); assert.deepEqual(Object.keys(content).sort(), ['conversationId', 'locale', 'receivedAt']);
    await repo().finish(notificationToken(row), { kind: 'sent' });
    assert.deepEqual(await conn.chatMessage.findUnique({ where: { id: row.messageId } }), beforeMessage);
    assert.deepEqual(await conn.chatConversation.findUnique({ where: { id: row.conversationId } }), beforeConversation);
  });
  test('AC15：精确id一次INSERT豁免，异常QUEUED4不迁移或发送，UPDATE探针回滚仍可读', async () => {
    const id = randomUUID(); expectedCapId = id;
    await conn.$executeRawUnsafe(`INSERT INTO "${schema}"."m4t4_ac15_exemption" VALUES (true,$1,true)`, id);
    await seed({ id, attempts: 4 }); const before = await stored(id);
    assert.equal(await repo().claimDue('a'), null); assert.deepEqual(await stored(id), before);
    expectedProbeDelta = 1;
    await assert.rejects(conn.chatNotification.update({ where: { id }, data: { updatedAt: clock() } }));
    assert.equal((await probe()) - probeBefore, 1); assert.deepEqual(await stored(id), before);
  });
  test('AC16：第四次确知未调用单CAS FAILED，本次调用0/attempts4，安全码不泄露', async () => {
    const source = await seed({ attempts: 3 }); let calls = 0;
    const counts = await processChatNotifications({ repo: repo(), owner: 'a', getMailer: async () => ({ async send() { calls++; return { kind: 'sent' }; } }), beforeSend: async () => { throw new NotificationPreSendFailure(); } }, { now: clock(), budget: { deadlineAt: new Date(Date.now() + 54750), signal: new AbortController().signal } });
    const saved = await stored(source.id); assert.equal(saved.status, 'FAILED'); assert.equal(saved.attempts, 4); assert.equal(calls, 0); assert.equal(counts.failed, 1); assert.equal(saved.availableAt.getTime(), source.availableAt.getTime());
    assert.equal(saved.lastErrorCode, 'CHAT_PRE_SEND_FAULT');
  });
  test('AC-INV/K4：坏租约与空marker cap能被辅助查询检出，不做产品迁移', async () => {
    const bad = await seed({ status: 'SENDING', attempts: 1, lockedUntil: clock(), requestStartedAt: clock() });
    assert.ok((await invariants()).bad.includes(bad.id)); await conn.chatNotification.delete({ where: { id: bad.id } });
    const missingExpiry = await seed({ status: 'SENDING', attempts: 1, leaseOwner: 'a', requestStartedAt: clock() });
    const emptyCap = await seed({ status: 'SENDING', attempts: 4, leaseOwner: 'a', lockedUntil: clock() });
    assert.deepEqual((await invariants()).bad.sort(), [missingExpiry.id, emptyCap.id].sort());
    await conn.chatNotification.deleteMany({ where: { id: { in: [missingExpiry.id, emptyCap.id] } } });
  });
  test('AC17：并发真实claim同一行恰一方成功', async () => {
    await seed(); const results = await Promise.all([repo().claimDue('a'), repo().claimDue('b')]); assert.equal(results.filter(Boolean).length, 1);
  });
  test('AC18：pre-send后僵尸恢复不能覆盖新租约', async () => {
    const zombie = await started(); time = zombie.lockedUntil!.getTime(); await repo().recoverExpiredLease(clock()); time = (await stored(zombie.id)).availableAt.getTime(); await repo().promoteUnknown(clock());
    const next = await repo().claimDue('b'); assert.ok(next); const before = await stored(zombie.id);
    assert.equal(await repo().finish(notificationToken(zombie), { kind: 'sent' }), false); assert.deepEqual(await stored(zombie.id), before);
  });
  test('F04：有候选claim采样2次，其余有效单行方法采样1次', async () => {
    await seed(); let calls = 0; const r = repo(() => { calls++; return clock(); });
    const claim = await r.claimDue('a'); assert.ok(claim); assert.equal(calls, 2);
    calls = 0; const active = await r.startAttempt(notificationToken(claim)); assert.ok(active); assert.equal(calls, 1);
    calls = 0; await r.finish(notificationToken(active), { kind: 'sent' }); assert.equal(calls, 1);
    await seed({ status: 'SENDING', attempts: 1, lockedUntil: clock(), leaseOwner: 'a' });
    calls = 0; assert.equal(await r.recoverExpiredLease(clock()), 1); assert.equal(calls, 1);
    await seed({ status: 'UNKNOWN', attempts: 1, requestStartedAt: clock() });
    calls = 0; assert.equal(await r.promoteUnknown(clock()), 1); assert.equal(calls, 1);
    await seed();
    calls = 0; assert.equal(await r.disableNeverStartedQueued(), 1); assert.equal(calls, 1);
  });
  test('F08：通知锁不锁会话或ChatMessage，NOWAIT探针可获取两者', async () => {
    const row = await seed(); let unlock!: () => void, ready!: () => void;
    const gate = new Promise<void>((r) => { unlock = r; }); const entered = new Promise<void>((r) => { ready = r; });
    const withProbe = () => configuredDb(conn, undefined, (tx) => new Proxy(tx, {
      get(target, property) {
        if (property !== '$queryRaw') return Reflect.get(target, property, target);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join('?');
          const select = sql.includes('ORDER BY "id" LIMIT 1 FOR UPDATE');
          const result = await target.$queryRaw(strings, ...values);
          if (select) { ready(); await gate; }
          return result;
        };
      },
    }));
    const takeOtherLocks = () => conn.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChatConversation" WHERE "id"=${row.conversationId} FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT "id" FROM "ChatMessage" WHERE "id"=${row.messageId} FOR UPDATE NOWAIT`;
    });
    const worker = repo(clock, withProbe()).claimDue('a');
    await entered;
    try { await takeOtherLocks(); } finally { unlock(); }
    assert.ok(await worker);
    await conn.chatNotification.update({ where: { id: row.id }, data: { status: 'QUEUED', leaseOwner: null, lockedUntil: null } });
    const mutantGate = new Promise<void>((r) => { unlock = r; });
    const mutantReady = new Promise<void>((r) => { ready = r; });
    const mutantDb = configuredDb(conn, async (tx) => {
      await tx.$queryRaw`SELECT n."id" FROM "ChatNotification" n JOIN "ChatMessage" m ON n."messageId"=m."id" WHERE n."id"=${row.id} FOR UPDATE`;
      ready(); await mutantGate;
    });
    const mutant = repo(clock, mutantDb).claimDue('a');
    await mutantReady;
    try { await assert.rejects(takeOtherLocks(), (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.meta?.code === '55P03'); }
    finally { unlock(); await mutant; }
  });
  test('F02：实际锁超时是预算耗尽，不冒充affected0', async () => {
    const row = await started(); let release!: () => void, ready!: () => void;
    const gate = new Promise<void>((r) => { release = r; }); const entered = new Promise<void>((r) => { ready = r; });
    const hold = conn.$transaction(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "ChatNotification" WHERE "id"=${row.id} FOR UPDATE`; ready(); await gate; }, { timeout: 10000 });
    await entered;
    try { await assert.rejects(repo().finish(notificationToken(row), { kind: 'sent' }), NotificationBudgetExceeded); }
    finally { release(); await hold; }
  });
  test('AC-T：两种非UTC进程和同一事务会话时区重跑AC1/AC3/AC7', () => {
    for (const zone of ['Asia/Shanghai', 'America/Los_Angeles']) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern=AC1/S1|AC3/AC2|AC7/K2', 'tests/chat-notification-worker.db.test.ts'], { cwd: process.cwd(), env: { ...process.env, TZ: zone, M4T4_PG_SESSION_TZ: zone }, encoding: 'utf8', timeout: 120000 });
      assert.equal(result.status, 0, `non-UTC round failed: ${zone}`); assert.match(result.stdout, /# pass 3/); console.log(`AC_T ${zone} passed=3`);
    }
  });
  test('F05：仓库外源码副本裸Date变异必须被同一UTC租约断言检出', async () => {
    const sourcePath = path.resolve('src/lib/server/chat/notification-repo.ts'); const source = readFileSync(sourcePath, 'utf8');
    const needle = "return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;"; assert.equal(source.split(needle).length - 1, 1);
    const mutant = source.replace(needle, 'return date as unknown as Prisma.Sql;')
      .replace("'@prisma/client'", JSON.stringify(require.resolve('@prisma/client')))
      .replace("'../jobs/registry'", JSON.stringify(path.resolve('src/lib/server/jobs/registry.ts')))
      .replace("'./notification-policy'", JSON.stringify(path.resolve('src/lib/server/chat/notification-policy.ts')));
    const root = mkdtempSync(path.join(os.tmpdir(), 'nbshiyan-m4t4-utc-'));
    try {
      const output = ts.transpileModule(mutant, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const file = path.join(root, 'notification-repo.cjs'); writeFileSync(file, output);
      const mod = require(file) as { createNotificationRepo: typeof createNotificationRepo };
      const oldZone = process.env.M4T4_PG_SESSION_TZ; process.env.M4T4_PG_SESSION_TZ = 'Asia/Shanghai';
      try {
        await seed();
        const exercise = async (r: NotificationRepo) => { const claim = await r.claimDue('a'); assert.ok(claim); assert.equal(claim.lockedUntil!.getTime(), time + CHAT_NOTIFICATION_LEASE_MS, 'utc lease exact'); };
        await exercise(repo());
        await conn.chatNotification.deleteMany(); await seed();
        await assert.rejects(exercise(mod.createNotificationRepo({ db: configuredDb(conn), clock, env: {} })), { code: 'ERR_ASSERTION' });
        console.log(`UTC_MUTATION naked_date=DETECTED original=${createHash('sha256').update(source).digest('hex')} mutant=${createHash('sha256').update(mutant).digest('hex')}`);
      } finally { if (oldZone === undefined) delete process.env.M4T4_PG_SESSION_TZ; else process.env.M4T4_PG_SESSION_TZ = oldZone; }
    } finally { const resolved = realpathSync(root); assert.equal(path.dirname(resolved), realpathSync(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('nbshiyan-m4t4-utc-')); rmSync(resolved, { recursive: true }); }
  });
});
