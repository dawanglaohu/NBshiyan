// 分析保留清理在隔离 schema 的真实 PostgreSQL 上验收。没有 DATABASE_URL 时整组跳过。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { eligibleSiteDates } from '../src/lib/analytics/rollup-plan';
import { ANALYTICS_SETTINGS_KEY } from '../src/lib/server/jobs/types';
import { createJobLeaseRepo } from '../src/lib/server/jobs/lease-repo';
import { runAnalyticsRollup } from '../src/lib/server/analytics/rollup';
import { runRetentionCleanup } from '../src/lib/server/analytics/retention-cleanup';

const base = process.env.DATABASE_URL;
const SCHEMA = `retclean_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}&connection_limit=5&pool_timeout=10`
  : null;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no DATABASE_URL';

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

after(async () => {
  if (!db) return;
  assert.match(SCHEMA, /^retclean_\d+$/);
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

describe('analytics retention cleanup', { concurrency: false, skip, timeout: 120_000 }, () => {
  before(async () => {
    assert.ok(db);
    const ddl = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgresql://dummy:dummy@127.0.0.1:1/dummy', PRISMA_HIDE_UPDATE_MESSAGE: '1' } as unknown as NodeJS.ProcessEnv,
      timeout: 60_000,
    });
    const detail = `${ddl.stderr ?? ''}`.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://redacted');
    assert.equal(ddl.status, 0, detail.slice(0, 500));
    assert.match(SCHEMA, /^retclean_\d+$/);
    await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    const statements = ddl.stdout.split(/;\s*$/m).map((statement) => statement.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    for (const statement of statements) await db.$executeRawUnsafe(statement);
  });

  beforeEach(async () => {
    assert.ok(db);
    await db.$executeRaw`DELETE FROM "AnalyticsDailyRollup"`;
    await db.$executeRaw`DELETE FROM "AnalyticsRollupDay"`;
    await db.$executeRaw`DELETE FROM "AnalyticsEvent"`;
    await db.$executeRaw`DELETE FROM "JobState"`;
    await db.$executeRaw`DELETE FROM "SiteSetting"`;
  });

  async function setTimezone(timezone: string, revision: number, at: Date) {
    assert.ok(db);
    const value = JSON.stringify({
      version: Math.max(0, revision - 1),
      timezone,
      timezoneRevision: revision,
      changedAt: at.toISOString(),
      updatedBy: null,
    });
    await db.$executeRaw`
      INSERT INTO "SiteSetting" ("key", "value")
      VALUES (${ANALYTICS_SETTINGS_KEY}, ${value}::jsonb)
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"
    `;
  }

  async function insertEvent(input: { occurredAt: Date; receivedAt: Date; path: string; browserHash: string }) {
    assert.ok(db);
    await db.$executeRaw`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind",
        "occurredAt", "receivedAt", "locale", "path", "productSlug",
        "navigationId", "viewId", "durationMs", "failureReason"
      ) VALUES (
        ${randomUUID()}, ${randomUUID()}, 'hash', ${input.browserHash},
        'page_view'::"AnalyticsEventKind",
        ${utc(input.occurredAt)}, ${utc(input.receivedAt)},
        'en', ${input.path}, '', NULL, NULL, NULL, NULL
      )
    `;
  }

  async function insertRollup(siteDate: string, revision: number, eventCount: number, at: Date) {
    assert.ok(db);
    await db.$executeRaw`
      INSERT INTO "AnalyticsRollupDay" (
        "siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt"
      ) VALUES (
        ${siteDate}, ${revision}, ${utc(at)}, ${eventCount}, ${utc(at)}, ${utc(at)}, ${utc(at)}
      )
    `;
    await db.$executeRaw`
      INSERT INTO "AnalyticsDailyRollup" (
        "siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers", "createdAt", "updatedAt"
      ) VALUES (
        ${siteDate}, 'page_view'::"AnalyticsEventKind", 'en', '', ${eventCount}, 1, ${utc(at)}, ${utc(at)}
      )
    `;
  }

  async function hashes(): Promise<string[]> {
    assert.ok(db);
    const rows = await db.$queryRaw<{ browserHash: string }[]>`SELECT "browserHash" FROM "AnalyticsEvent" ORDER BY "browserHash"`;
    return rows.map((row) => row.browserHash);
  }

  async function rollupDates(): Promise<string[]> {
    assert.ok(db);
    const rows = await db.$queryRaw<{ siteDate: string }[]>`SELECT "siteDate" FROM "AnalyticsRollupDay" ORDER BY "siteDate"`;
    return rows.map((row) => row.siteDate);
  }

  async function dailyCount(siteDate: string): Promise<number | null> {
    assert.ok(db);
    const rows = await db.$queryRaw<{ count: number }[]>`
      SELECT "count" FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${siteDate}
    `;
    return rows.length === 0 ? null : Number(rows[0]?.count);
  }

  test('只删除已汇总且过了保留期的原始事件，冒烟行走同一规则', async () => {
    assert.ok(db);
    const now = new Date('2026-06-15T12:00:00.000Z');
    await setTimezone('UTC', 1, now);
    await insertRollup('2026-05-15', 1, 2, now);
    await insertRollup('2026-05-16', 1, 2, now);
    await insertRollup('2026-05-14', 9, 1, now);
    await insertEvent({ occurredAt: new Date('2026-05-15T12:00:00.000Z'), receivedAt: new Date('2026-05-15T12:00:00.000Z'), path: '/en', browserHash: 'old-rolled' });
    await insertEvent({ occurredAt: new Date('2026-05-15T13:00:00.000Z'), receivedAt: new Date('2026-05-15T13:00:00.000Z'), path: 'nbs-smoke-probe', browserHash: 'smoke-rolled' });
    await insertEvent({ occurredAt: new Date('2026-05-16T18:00:00.000Z'), receivedAt: new Date('2026-05-16T18:00:00.000Z'), path: '/en', browserHash: 'late-same-day' });
    await insertEvent({ occurredAt: new Date('2026-05-16T12:00:00.000Z'), receivedAt: new Date('2026-05-16T12:00:00.000Z'), path: '/en', browserHash: 'exact-cutoff' });
    await insertEvent({ occurredAt: new Date('2026-05-10T12:00:00.000Z'), receivedAt: new Date('2026-05-10T12:00:00.000Z'), path: '/en', browserHash: 'unrolled' });
    await insertEvent({ occurredAt: new Date('2026-05-14T12:00:00.000Z'), receivedAt: new Date('2026-05-14T12:00:00.000Z'), path: '/en', browserHash: 'bad-rev' });
    await insertEvent({ occurredAt: new Date('2026-05-17T00:00:00.000Z'), receivedAt: new Date('2026-05-01T00:00:00.000Z'), path: '/en', browserHash: 'floor-day' });
    await insertEvent({ occurredAt: new Date('2026-06-01T12:00:00.000Z'), receivedAt: new Date('2026-06-01T12:00:00.000Z'), path: '/en', browserHash: 'fresh' });
    const result = await runRetentionCleanup({ db, clock: () => now, mode: 'delete', audit: async () => {} });
    assert.equal(result.status, 'succeeded');
    if (result.status !== 'succeeded') return;
    assert.equal(result.mode, 'delete');
    assert.equal(result.deletedEvents, 2);
    assert.equal(result.skippedRevisionMismatchDays, 1);
    assert.ok(result.keptExpiredEvents >= 1);
    assert.deepEqual(await hashes(), ['bad-rev', 'exact-cutoff', 'floor-day', 'fresh', 'late-same-day', 'unrolled']);
    assert.deepEqual(await rollupDates(), ['2026-05-14', '2026-05-15', '2026-05-16']);
  });

  test('汇总空缺之后的日子不删，即使那天已有汇总行', async () => {
    assert.ok(db);
    const now = new Date('2026-06-15T12:00:00.000Z');
    await setTimezone('UTC', 1, now);
    await insertRollup('2026-05-01', 1, 1, now);
    await insertRollup('2026-05-03', 1, 1, now);
    await insertEvent({ occurredAt: new Date('2026-05-01T12:00:00.000Z'), receivedAt: new Date('2026-05-01T12:00:00.000Z'), path: '/en', browserHash: 'inside-prefix' });
    await insertEvent({ occurredAt: new Date('2026-05-03T12:00:00.000Z'), receivedAt: new Date('2026-05-03T12:00:00.000Z'), path: '/en', browserHash: 'after-gap' });
    const result = await runRetentionCleanup({ db, clock: () => now, mode: 'delete', audit: async () => {} });
    assert.equal(result.status, 'succeeded');
    if (result.status !== 'succeeded') return;
    assert.equal(result.skippedAfterGapDays, 1);
    assert.deepEqual(await hashes(), ['after-gap']);
  });

  test('dry-run 只统计并写审计，不删行', async () => {
    assert.ok(db);
    const now = new Date('2026-06-15T12:00:00.000Z');
    await setTimezone('UTC', 1, now);
    await insertRollup('2026-05-15', 1, 1, now);
    await insertEvent({ occurredAt: new Date('2026-05-15T12:00:00.000Z'), receivedAt: new Date('2026-05-15T12:00:00.000Z'), path: '/en', browserHash: 'counted' });
    const audits: { action: string; meta?: { mode?: string; deletedEvents?: number; candidateEvents?: number } }[] = [];
    const result = await runRetentionCleanup({
      db,
      clock: () => now,
      mode: 'dry-run',
      audit: async (entry) => { audits.push(entry as typeof audits[number]); },
    });
    assert.equal(result.status, 'succeeded');
    if (result.status !== 'succeeded') return;
    assert.equal(result.deletedEvents, 0);
    assert.equal(result.deletedRollupRows, 0);
    assert.equal(result.candidateEvents, 1);
    assert.equal(result.batches, 0);
    assert.deepEqual(await hashes(), ['counted']);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, 'cron.retention_cleanup');
    assert.equal(audits[0]?.meta?.mode, 'dry-run');
    assert.equal(audits[0]?.meta?.deletedEvents, 0);
    assert.equal(audits[0]?.meta?.candidateEvents, 1);
  });

  test('分批和每次运行的行数上限会停住', async () => {
    assert.ok(db);
    const now = new Date('2026-06-15T12:00:00.000Z');
    await setTimezone('UTC', 1, now);
    await insertRollup('2026-05-15', 1, 5, now);
    for (let index = 0; index < 5; index += 1) {
      await insertEvent({
        occurredAt: new Date('2026-05-15T08:00:00.000Z'),
        receivedAt: new Date(`2026-05-15T08:00:0${index}.000Z`),
        path: '/en',
        browserHash: `batch-${index}`,
      });
    }
    const result = await runRetentionCleanup({ db, clock: () => now, mode: 'delete', batchSize: 2, maxPerRun: 3, audit: async () => {} });
    assert.equal(result.status, 'succeeded');
    if (result.status !== 'succeeded') return;
    assert.equal(result.deletedEvents, 3);
    assert.equal(result.batches, 2);
    assert.equal((await hashes()).length, 2);
  });

  test('超过 13 个月的汇总行删除，边界当天保留', async () => {
    assert.ok(db);
    const now = new Date('2026-06-15T12:00:00.000Z');
    await setTimezone('UTC', 1, now);
    await insertRollup('2025-05-14', 1, 3, now);
    await insertRollup('2025-05-15', 1, 4, now);
    await insertRollup('2026-05-01', 1, 5, now);
    const result = await runRetentionCleanup({ db, clock: () => now, mode: 'delete', audit: async () => {} });
    assert.equal(result.status, 'succeeded');
    if (result.status !== 'succeeded') return;
    assert.equal(result.deletedRollupRows, 2);
    assert.deepEqual(await rollupDates(), ['2025-05-15', '2026-05-01']);
    assert.equal(await dailyCount('2025-05-14'), null);
    assert.equal(await dailyCount('2025-05-15'), 4);
  });

  test('analytics-aggregate 租约被占用时不删，并发第二次也进不去', async () => {
    assert.ok(db);
    const now = new Date('2026-06-15T12:00:00.000Z');
    await setTimezone('UTC', 1, now);
    await insertRollup('2026-05-15', 1, 1, now);
    await insertEvent({ occurredAt: new Date('2026-05-15T12:00:00.000Z'), receivedAt: new Date('2026-05-15T12:00:00.000Z'), path: '/en', browserHash: 'leased' });
    const repo = createJobLeaseRepo({ db, clock: () => now });
    const claim = await repo.claim({ key: 'analytics-aggregate', owner: 'other-worker' });
    assert.equal(claim.acquired, true);
    const blocked = await runRetentionCleanup({ db, clock: () => now, mode: 'delete', audit: async () => {} });
    assert.equal(blocked.status, 'busy');
    assert.deepEqual(await hashes(), ['leased']);
    await db.$executeRaw`DELETE FROM "JobState"`;
    const pair = await Promise.all([
      runRetentionCleanup({ db, clock: () => now, mode: 'delete', audit: async () => {} }),
      runRetentionCleanup({ db, clock: () => now, mode: 'delete', audit: async () => {} }),
    ]);
    assert.deepEqual(pair.map((item) => item.status).sort(), ['busy', 'succeeded']);
    assert.deepEqual(await hashes(), []);
  });

  test('时区代次切换后，已删除原始事件的汇总不会被空数据覆盖', async () => {
    assert.ok(db);
    const now = new Date('2026-06-16T12:00:00.000Z');
    await setTimezone('UTC', 1, now);
    await insertRollup('2026-05-17', 1, 1, now);
    await insertEvent({
      occurredAt: new Date('2026-05-17T15:00:00.000Z'),
      receivedAt: new Date('2026-05-17T11:00:00.000Z'),
      path: '/en',
      browserHash: 'purged',
    });
    const cleaned = await runRetentionCleanup({ db, clock: () => now, mode: 'delete', audit: async () => {} });
    assert.equal(cleaned.status, 'succeeded');
    if (cleaned.status !== 'succeeded') return;
    assert.equal(cleaned.deletedEvents, 1);
    assert.equal(await dailyCount('2026-05-17'), 1);
    assert.equal(eligibleSiteDates(now, 'Etc/GMT+12').includes('2026-05-17'), true);
    await setTimezone('Etc/GMT+12', 2, now);
    const rolled = await runAnalyticsRollup({ db, clock: () => now, maxDays: 40 });
    assert.equal(rolled.status, 'succeeded');
    assert.equal(await dailyCount('2026-05-17'), 1);
    const days = await db.$queryRaw<{ timezoneRevision: number; eventCount: number }[]>`
      SELECT "timezoneRevision", "eventCount" FROM "AnalyticsRollupDay" WHERE "siteDate" = '2026-05-17'
    `;
    assert.equal(Number(days[0]?.timezoneRevision), 1);
    assert.equal(Number(days[0]?.eventCount), 1);
  });
});
