import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { siteDayContaining, siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { AppError } from '../src/lib/server/http/errors';
import { ANALYTICS_SETTINGS_KEY } from '../src/lib/server/jobs/types';
import { ANALYTICS_RECOMPUTE_KEY, ANALYTICS_TIMEZONE_CHANGE_ACTION } from '../src/lib/server/analytics/settings-repo';
import { createAnalyticsSettingsService, type AnalyticsSettingsService } from '../src/lib/server/analytics/settings';

const base = process.env.DATABASE_URL;
const SCHEMA = `m5t9_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}&connection_limit=5&pool_timeout=10`
  : null;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no DATABASE_URL';
const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const EVENT_OCCURRED = '2026-01-02T03:04:05.006Z';
const EVENT_RECEIVED = '2026-01-02T03:04:06.007Z';

after(async () => {
  if (!db) return;
  assert.match(SCHEMA, /^m5t9_\d+$/);
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

type Snapshot = {
  settings: { key: string; value: string }[];
  audits: { action: string; actorId: string | null; meta: string | null }[];
  events: { eventId: string; occurredAt: string; receivedAt: string }[];
  daily: { localDate: string; timezoneRevision: number; timezone: string; dimension: string }[];
};

function service(): AnalyticsSettingsService {
  assert.ok(db);
  return createAnalyticsSettingsService({ db, clock: () => new Date(NOW) });
}

async function reset() {
  assert.ok(db);
  assert.match(SCHEMA, /^m5t9_\d+$/);
  await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SCHEMA}"."AuditLog"`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SCHEMA}"."AnalyticsEvent"`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SCHEMA}"."AnalyticsDaily"`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SCHEMA}"."SiteSetting"`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SCHEMA}"."User"`);
  await db.$executeRawUnsafe(`
    CREATE TABLE "${SCHEMA}"."User" (
      "id" TEXT PRIMARY KEY,
      "role" TEXT NOT NULL
    )
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE "${SCHEMA}"."SiteSetting" (
      "key" TEXT PRIMARY KEY,
      "value" JSONB NOT NULL
    )
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE "${SCHEMA}"."AuditLog" (
      "id" TEXT PRIMARY KEY,
      "actorId" TEXT,
      "action" TEXT NOT NULL,
      "target" TEXT,
      "meta" JSONB,
      "ip" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL
    )
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE "${SCHEMA}"."AnalyticsEvent" (
      "eventId" TEXT PRIMARY KEY,
      "occurredAt" TIMESTAMP(3) NOT NULL,
      "receivedAt" TIMESTAMP(3) NOT NULL
    )
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE "${SCHEMA}"."AnalyticsDaily" (
      "localDate" TEXT NOT NULL,
      "timezoneRevision" INTEGER NOT NULL,
      "timezone" TEXT NOT NULL,
      "dimension" TEXT NOT NULL,
      PRIMARY KEY ("localDate", "timezoneRevision", "dimension")
    )
  `);
  await db.$executeRaw`
    INSERT INTO "User" ("id", "role") VALUES
      ('admin-a', 'ADMIN'),
      ('admin-b', 'ADMIN'),
      ('sales-1', 'SALES'),
      ('editor-1', 'EDITOR')
  `;
  await db.$executeRaw`
    INSERT INTO "SiteSetting" ("key", "value") VALUES
      ('about.enabled', ${JSON.stringify({ enabled: true, version: 4 })}::jsonb),
      ('site.organization', ${JSON.stringify({ version: 2, name: 'PackJoyU' })}::jsonb)
  `;
  await db.$executeRaw`
    INSERT INTO "AnalyticsEvent" ("eventId", "occurredAt", "receivedAt") VALUES (
      'evt-1',
      ${EVENT_OCCURRED}::timestamptz AT TIME ZONE 'UTC',
      ${EVENT_RECEIVED}::timestamptz AT TIME ZONE 'UTC'
    )
  `;
  await db.$executeRaw`
    INSERT INTO "AnalyticsDaily" ("localDate", "timezoneRevision", "timezone", "dimension")
    VALUES ('2026-06-01', 1, 'UTC', 'site')
  `;
}

async function snapshot(): Promise<Snapshot> {
  assert.ok(db);
  const settings = await db.$queryRaw<{ key: string; value: string }[]>`
    SELECT "key", "value"::text AS "value" FROM "SiteSetting" ORDER BY "key"
  `;
  const audits = await db.$queryRaw<{ action: string; actorId: string | null; meta: string | null }[]>`
    SELECT "action", "actorId", "meta"::text AS "meta" FROM "AuditLog" ORDER BY "createdAt", "id"
  `;
  const events = await db.$queryRaw<{ eventId: string; occurredAt: string; receivedAt: string }[]>`
    SELECT "eventId",
      to_char("occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
      to_char("receivedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt"
    FROM "AnalyticsEvent" ORDER BY "eventId"
  `;
  const daily = await db.$queryRaw<{ localDate: string; timezoneRevision: number; timezone: string; dimension: string }[]>`
    SELECT "localDate", "timezoneRevision", "timezone", "dimension"
    FROM "AnalyticsDaily" ORDER BY "localDate", "timezoneRevision", "dimension"
  `;
  return { settings, audits, events, daily };
}

function valueOf(shot: Snapshot, key: string): unknown {
  const row = shot.settings.find((item) => item.key === key);
  assert.ok(row);
  return JSON.parse(row.value) as unknown;
}

function assertUntouchedFacts(shot: Snapshot) {
  assert.deepEqual(valueOf(shot, 'about.enabled'), { enabled: true, version: 4 });
  assert.deepEqual(valueOf(shot, 'site.organization'), { version: 2, name: 'PackJoyU' });
  assert.deepEqual(shot.events, [{ eventId: 'evt-1', occurredAt: EVENT_OCCURRED, receivedAt: EVENT_RECEIVED }]);
  assert.deepEqual(shot.daily, [{ localDate: '2026-06-01', timezoneRevision: 1, timezone: 'UTC', dimension: 'site' }]);
}

async function rejects(run: Promise<unknown>, code: AppError['code']) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  });
}

describe('版本化站点时区', { concurrency: false, skip }, () => {
  test('ADMIN 用版本 CAS 改有效时区，记下重算待办，UTC 事件不改写', async () => {
    await reset();
    const result = await service().update({ userId: 'admin-a' }, { timezone: 'America/New_York', expectedVersion: 0 });
    assert.equal(result.rebuildScheduled, true);
    assert.equal(result.version, 1);
    assert.equal(result.timezone, 'America/New_York');
    assert.equal(result.timezoneRevision, 2);
    assert.equal(result.recomputableFrom, '2026-05-17T04:00:00.000Z');
    const shot = await snapshot();
    assertUntouchedFacts(shot);
    assert.deepEqual(valueOf(shot, ANALYTICS_SETTINGS_KEY), {
      version: 1,
      timezone: 'America/New_York',
      timezoneRevision: 2,
      changedAt: '2026-06-15T12:00:00.000Z',
      updatedBy: 'admin-a',
    });
    assert.deepEqual(valueOf(shot, ANALYTICS_RECOMPUTE_KEY), {
      timezoneRevision: 2,
      timezone: 'America/New_York',
      recomputableFrom: '2026-05-17T04:00:00.000Z',
      requestedAt: '2026-06-15T12:00:00.000Z',
      updatedBy: 'admin-a',
      status: 'pending',
    });
    assert.equal(shot.audits.length, 1);
    assert.equal(shot.audits[0].action, ANALYTICS_TIMEZONE_CHANGE_ACTION);
    assert.equal(shot.audits[0].actorId, 'admin-a');
    assert.deepEqual(JSON.parse(shot.audits[0].meta ?? 'null'), {
      previousTimezone: 'UTC',
      timezone: 'America/New_York',
      timezoneRevision: 2,
      recomputableFrom: '2026-05-17T04:00:00.000Z',
    });
    const instant = new Date('2026-06-15T18:00:00.000Z');
    const first = siteDayContaining(instant, result.timezone, 'Pacific/Kiritimati');
    const second = siteDayContaining(instant, result.timezone, 'Pacific/Pago_Pago');
    assert.deepEqual(first, second);
    assert.equal(first.localDate, '2026-06-15');
    assert.notEqual(siteLocalDate(instant, 'Pacific/Kiritimati'), siteLocalDate(instant, 'Pacific/Pago_Pago'));
    const again = await service().update({ userId: 'admin-a' }, { timezone: 'America/New_York', expectedVersion: 1 });
    assert.equal(again.rebuildScheduled, false);
    assert.equal(again.version, 1);
    assert.equal(again.timezoneRevision, 2);
    assert.equal(again.recomputableFrom, '2026-05-17T04:00:00.000Z');
    const afterRepeat = await snapshot();
    assert.equal(afterRepeat.audits.length, 1);
    assert.deepEqual(valueOf(afterRepeat, ANALYTICS_SETTINGS_KEY), valueOf(shot, ANALYTICS_SETTINGS_KEY));
  });

  test('再次改时区替换待办，旧聚合行仍停在原 revision', async () => {
    await reset();
    const api = service();
    await api.update({ userId: 'admin-a' }, { timezone: 'America/New_York', expectedVersion: 0 });
    const next = await api.update({ userId: 'admin-b' }, { timezone: 'Asia/Shanghai', expectedVersion: 1 });
    assert.equal(next.rebuildScheduled, true);
    assert.equal(next.version, 2);
    assert.equal(next.timezoneRevision, 3);
    assert.equal(next.recomputableFrom, '2026-05-16T16:00:00.000Z');
    const shot = await snapshot();
    assertUntouchedFacts(shot);
    assert.equal(shot.settings.filter((row) => row.key === ANALYTICS_RECOMPUTE_KEY).length, 1);
    assert.equal((valueOf(shot, ANALYTICS_RECOMPUTE_KEY) as { timezoneRevision: number }).timezoneRevision, 3);
    assert.equal(shot.audits.length, 2);
    const read = await api.read({ userId: 'admin-a' });
    assert.equal(read.recomputableFrom, '2026-05-16T16:00:00.000Z');
    assert.equal(read.timezone, 'Asia/Shanghai');
  });

  test('非法 IANA、旧 version、非 ADMIN 和空身份都不改原值', async () => {
    await reset();
    const api = service();
    await api.update({ userId: 'admin-a' }, { timezone: 'UTC', expectedVersion: 0 });
    const before = await snapshot();
    await rejects(api.update({ userId: 'admin-a' }, { timezone: 'Not/AZone', expectedVersion: 0 }), 'invalid');
    await rejects(api.update({ userId: 'admin-a' }, { timezone: 'UTC+8', expectedVersion: 0 }), 'invalid');
    await rejects(api.update({ userId: 'admin-a' }, { timezone: 'America/New_York', expectedVersion: 0, browserTimezone: 'Pacific/Auckland' }), 'invalid');
    await rejects(api.update({ userId: 'admin-a' }, { timezone: 'Europe/Berlin', expectedVersion: 4 }), 'version_conflict');
    await rejects(api.update({ userId: 'admin-a' }, {}), 'invalid');
    await rejects(api.update({ userId: 'admin-a' }, null), 'invalid');
    await rejects(api.update({ userId: 'sales-1' }, { timezone: 'Pacific/Auckland', expectedVersion: 0 }), 'forbidden');
    await rejects(api.update({ userId: 'editor-1' }, { timezone: 'Europe/Berlin', expectedVersion: 0 }), 'forbidden');
    await rejects(api.update({ userId: 'missing-user' }, { timezone: 'Europe/Berlin', expectedVersion: 0 }), 'unauthorized');
    await rejects(api.update({ userId: '' }, { timezone: 'Europe/Berlin', expectedVersion: 0 }), 'unauthorized');
    await rejects(api.read({ userId: 'sales-1' }), 'forbidden');
    const after = await snapshot();
    assert.deepEqual(after, before);
    assertUntouchedFacts(after);
    const adminRead = await api.read({ userId: 'admin-a' });
    assert.equal(adminRead.timezone, 'UTC');
    assert.equal(adminRead.version, 0);
    assert.equal(adminRead.timezoneRevision, 1);
    assert.equal(adminRead.recomputableFrom, null);
  });

  test('没有设置行时，非 ADMIN 不创建，ADMIN 把 UTC 初值幂等写入', async () => {
    await reset();
    const api = service();
    const missing = await api.read({ userId: 'admin-a' });
    assert.deepEqual(missing, { version: 0, timezone: 'UTC', timezoneRevision: 1, recomputableFrom: null });
    await rejects(api.update({ userId: 'sales-1' }, { timezone: 'America/New_York', expectedVersion: 0 }), 'forbidden');
    let shot = await snapshot();
    assert.equal(shot.settings.some((row) => row.key === ANALYTICS_SETTINGS_KEY), false);
    assert.equal(shot.audits.length, 0);
    const created = await api.update({ userId: 'admin-a' }, { timezone: 'UTC', expectedVersion: 0 });
    assert.equal(created.rebuildScheduled, false);
    assert.equal(created.version, 0);
    assert.equal(created.timezoneRevision, 1);
    assert.equal(created.recomputableFrom, null);
    shot = await snapshot();
    assert.equal(shot.audits.length, 0);
    assert.equal(shot.settings.some((row) => row.key === ANALYTICS_RECOMPUTE_KEY), false);
    assert.deepEqual(valueOf(shot, ANALYTICS_SETTINGS_KEY), {
      version: 0,
      timezone: 'UTC',
      timezoneRevision: 1,
      changedAt: '2026-06-15T12:00:00.000Z',
      updatedBy: null,
    });
    await rejects(api.update({ userId: 'admin-a' }, { timezone: 'Europe/Berlin', expectedVersion: 3 }), 'version_conflict');
    const afterConflict = await snapshot();
    assert.deepEqual(valueOf(afterConflict, ANALYTICS_SETTINGS_KEY), valueOf(shot, ANALYTICS_SETTINGS_KEY));
  });

  test('两个 ADMIN 用同一个旧 version 并发保存，只有一个成功', async () => {
    await reset();
    const api = service();
    await api.update({ userId: 'admin-a' }, { timezone: 'UTC', expectedVersion: 0 });
    const results = await Promise.allSettled([
      api.update({ userId: 'admin-a' }, { timezone: 'Europe/Paris', expectedVersion: 0 }),
      api.update({ userId: 'admin-b' }, { timezone: 'Asia/Tokyo', expectedVersion: 0 }),
    ]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].status === 'rejected');
    assert.ok(rejected[0].reason instanceof AppError);
    assert.equal(rejected[0].reason.code, 'version_conflict');
    const shot = await snapshot();
    const stored = valueOf(shot, ANALYTICS_SETTINGS_KEY) as { version: number; timezoneRevision: number; timezone: string };
    assert.equal(stored.version, 1);
    assert.equal(stored.timezoneRevision, 2);
    assert.ok(stored.timezone === 'Europe/Paris' || stored.timezone === 'Asia/Tokyo');
    assert.equal(shot.audits.length, 1);
    assertUntouchedFacts(shot);
  });

  test('坏掉的设置和溢出的 version 保持原样', async () => {
    await reset();
    assert.ok(db);
    await db.$executeRaw`
      INSERT INTO "SiteSetting" ("key", "value")
      VALUES (${ANALYTICS_SETTINGS_KEY}, ${JSON.stringify({ timezone: 'UTC' })}::jsonb)
    `;
    const before = await snapshot();
    await rejects(service().update({ userId: 'admin-a' }, { timezone: 'Europe/Berlin', expectedVersion: 0 }), 'service_unavailable');
    await rejects(service().read({ userId: 'admin-a' }), 'service_unavailable');
    assert.deepEqual(await snapshot(), before);

    await db.$executeRaw`
      UPDATE "SiteSetting" SET "value" = ${JSON.stringify({
        version: 2_147_483_647,
        timezone: 'UTC',
        timezoneRevision: 1,
        changedAt: '2026-06-15T12:00:00.000Z',
        updatedBy: null,
      })}::jsonb
      WHERE "key" = ${ANALYTICS_SETTINGS_KEY}
    `;
    const capped = await snapshot();
    await rejects(service().update({ userId: 'admin-a' }, { timezone: 'Europe/Berlin', expectedVersion: 2_147_483_647 }), 'invalid');
    assert.deepEqual(await snapshot(), capped);
    assertUntouchedFacts(capped);
  });

  test('仓储只参数化读写设置、待办和审计', () => {
    const repo = readFileSync('src/lib/server/analytics/settings-repo.ts', 'utf8');
    const serviceSource = readFileSync('src/lib/server/analytics/settings.ts', 'utf8');
    assert.doesNotMatch(repo, /queryRawUnsafe|\$executeRawUnsafe|AnalyticsEvent|AnalyticsDaily|accept-data-loss|NextResponse/);
    assert.doesNotMatch(serviceSource, /AnalyticsEvent|AnalyticsDaily|process\.env|NextResponse|queryRawUnsafe/);
    assert.match(repo, /LOCK TABLE "SiteSetting" IN SHARE ROW EXCLUSIVE MODE/);
    assert.match(repo, /FOR UPDATE/);
  });
});
