// 统计日汇总在隔离 schema 的真实 PostgreSQL 上验收。没有 DATABASE_URL 时整组跳过。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { siteDayUtcBounds, siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { eligibleSiteDates, isSmokeAnalyticsPath } from '../src/lib/analytics/rollup-plan';
import { ANALYTICS_SETTINGS_KEY } from '../src/lib/server/jobs/types';
import { createJobLeaseRepo } from '../src/lib/server/jobs/lease-repo';
import {
  isSiteDateRolledUp,
  latestContiguousRolledUpDate,
  rolledUpDatesBefore,
  runAnalyticsRollup,
} from '../src/lib/server/analytics/rollup';

const base = process.env.DATABASE_URL;
const SCHEMA = `rollup_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}&connection_limit=5&pool_timeout=10`
  : null;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no DATABASE_URL';

const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

after(async () => {
  if (!db) return;
  assert.match(SCHEMA, /^rollup_\d+$/);
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

describe('analytics daily rollup', { concurrency: false, skip, timeout: 120_000 }, () => {
  before(async () => {
    assert.ok(db);
    const ddl = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgresql://dummy:dummy@127.0.0.1:1/dummy', PRISMA_HIDE_UPDATE_MESSAGE: '1' } as unknown as NodeJS.ProcessEnv,
      timeout: 60_000,
    });
    const detail = `${ddl.stderr ?? ''}`.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://redacted');
    assert.equal(ddl.status, 0, detail.slice(0, 500));
    assert.match(SCHEMA, /^rollup_\d+$/);
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

  async function insertEvent(input: {
    occurredAt: Date;
    receivedAt: Date;
    kind?: 'page_view' | 'product_view';
    locale?: string;
    path: string | null;
    productSlug?: string | null;
    browserHash: string;
  }) {
    assert.ok(db);
    await db.$executeRaw`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind",
        "occurredAt", "receivedAt", "locale", "path", "productSlug",
        "navigationId", "viewId", "durationMs", "failureReason"
      ) VALUES (
        ${randomUUID()},
        ${randomUUID()},
        'hash',
        ${input.browserHash},
        ${input.kind ?? 'page_view'}::"AnalyticsEventKind",
        ${utc(input.occurredAt)},
        ${utc(input.receivedAt)},
        ${input.locale ?? 'en'},
        ${input.path},
        ${input.productSlug ?? null},
        NULL,
        NULL,
        NULL,
        NULL
      )
    `;
  }

  async function eventRows(): Promise<number> {
    assert.ok(db);
    const rows = await db.$queryRaw<{ count: number }[]>`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`;
    return Number(rows[0]?.count ?? 0);
  }

  async function grain(): Promise<{ siteDate: string; kind: string; locale: string; productSlug: string; count: number; uniqueBrowsers: number }[]> {
    assert.ok(db);
    const rows = await db.$queryRaw<{ siteDate: string; kind: string; locale: string; productSlug: string; count: number; uniqueBrowsers: number }[]>`
      SELECT "siteDate", "kind"::text AS "kind", "locale", "productSlug", "count", "uniqueBrowsers"
      FROM "AnalyticsDailyRollup"
      ORDER BY "siteDate", "kind", "locale", "productSlug"
    `;
    return rows.map((row) => ({ ...row, count: Number(row.count), uniqueBrowsers: Number(row.uniqueBrowsers) }));
  }

  async function days(): Promise<{ siteDate: string; timezoneRevision: number; eventCount: number; sourceMaxReceivedAt: string | null }[]> {
    assert.ok(db);
    const rows = await db.$queryRaw<{ siteDate: string; timezoneRevision: number; eventCount: number; sourceMaxReceivedAt: string | null }[]>`
      SELECT
        "siteDate",
        "timezoneRevision",
        "eventCount",
        to_char("sourceMaxReceivedAt", ${ISO_FORMAT}) AS "sourceMaxReceivedAt"
      FROM "AnalyticsRollupDay"
      ORDER BY "siteDate"
    `;
    return rows.map((row) => ({
      siteDate: row.siteDate,
      timezoneRevision: Number(row.timezoneRevision),
      eventCount: Number(row.eventCount),
      sourceMaxReceivedAt: row.sourceMaxReceivedAt,
    }));
  }

  test('跨日边界按站点本地日汇总，今天和未来不写', async () => {
    assert.ok(db);
    const now = new Date('2026-06-16T12:00:00.000Z');
    await setTimezone('America/New_York', 1, now);
    const early = new Date('2026-06-15T03:30:00.000Z');
    const midnight = new Date('2026-06-15T04:00:00.000Z');
    await insertEvent({ occurredAt: early, receivedAt: early, path: '/en', browserHash: 'early' });
    await insertEvent({ occurredAt: midnight, receivedAt: midnight, path: '/en', browserHash: 'midnight' });
    await insertEvent({ occurredAt: now, receivedAt: now, path: '/en', browserHash: 'today' });
    await insertEvent({ occurredAt: new Date('2026-06-17T15:00:00.000Z'), receivedAt: now, path: '/en', browserHash: 'future' });
    const before = await eventRows();
    const result = await runAnalyticsRollup({ db, clock: () => now, maxDays: 40 });
    assert.equal(result.status, 'succeeded');
    if (result.status !== 'succeeded') return;
    assert.equal(await eventRows(), before);
    const earlyDate = siteLocalDate(early, 'America/New_York');
    const midnightDate = siteLocalDate(midnight, 'America/New_York');
    assert.equal(earlyDate, '2026-06-14');
    assert.equal(midnightDate, '2026-06-15');
    assert.notEqual(earlyDate, early.toISOString().slice(0, 10));
    const rows = await grain();
    assert.equal(rows.find((row) => row.siteDate === earlyDate)?.count, 1);
    assert.equal(rows.find((row) => row.siteDate === midnightDate)?.count, 1);
    assert.equal(rows.some((row) => row.siteDate === '2026-06-16' || row.siteDate === '2026-06-17'), false);
    const progress = await days();
    assert.equal(progress.some((day) => day.siteDate === siteLocalDate(now, 'America/New_York')), false);
    assert.equal(await isSiteDateRolledUp('2026-06-16', db), false);
    assert.equal(await isSiteDateRolledUp(earlyDate, db), true);
    const window = siteDayUtcBounds(earlyDate, 'America/New_York');
    assert.equal(progress.find((day) => day.siteDate === earlyDate)?.eventCount, 1);
    assert.ok(Date.parse(early.toISOString()) >= Date.parse(window.startUtc));
    assert.ok(Date.parse(early.toISOString()) < Date.parse(window.endUtc));
  });

  test('冒烟路径不进汇总也不进 eventCount，原始行仍在', async () => {
    assert.ok(db);
    const now = new Date('2026-06-16T12:00:00.000Z');
    await setTimezone('UTC', 1, now);
    const occurred = new Date('2026-06-15T08:00:00.000Z');
    const paths = [null, '/en/products', '/en/my-nbs-smoke-page', '/en/nbs-smoke-probe', '/ru/nbs-smoke-widget/page', 'nbs-smoke-raw', '/en/nbs-smoke-probe?x=1'];
    for (const path of paths) {
      await insertEvent({ occurredAt: occurred, receivedAt: occurred, path, browserHash: `b-${path ?? 'null'}` });
    }
    const before = await eventRows();
    const result = await runAnalyticsRollup({ db, clock: () => now, maxDays: 40 });
    assert.equal(result.status, 'succeeded');
    assert.equal(await eventRows(), before);
    const expected = paths.filter((path) => !isSmokeAnalyticsPath(path)).length;
    const progress = await days();
    assert.equal(progress.find((day) => day.siteDate === '2026-06-15')?.eventCount, expected);
    const rows = await grain();
    assert.equal(rows.reduce((sum, row) => sum + row.count, 0), expected);
    assert.equal(rows.some((row) => row.productSlug.includes('nbs-smoke') || row.locale.includes('nbs-smoke')), false);
  });

  test('重复运行结果不变，迟到的非冒烟事件才重算这一天', async () => {
    assert.ok(db);
    const now = new Date('2026-06-16T12:00:00.000Z');
    await setTimezone('UTC', 1, now);
    const occurred = new Date('2026-06-15T08:00:00.000Z');
    await insertEvent({ occurredAt: occurred, receivedAt: new Date('2026-06-15T08:00:00.000Z'), path: '/en', browserHash: 'browser-a' });
    await insertEvent({ occurredAt: occurred, receivedAt: new Date('2026-06-15T08:00:00.000Z'), path: '/en', browserHash: 'browser-a' });
    const first = await runAnalyticsRollup({ db, clock: () => now, maxDays: 40 });
    assert.equal(first.status, 'succeeded');
    const afterFirst = await grain();
    assert.equal(afterFirst.find((row) => row.siteDate === '2026-06-15')?.count, 2);
    assert.equal(afterFirst.find((row) => row.siteDate === '2026-06-15')?.uniqueBrowsers, 1);
    const second = await runAnalyticsRollup({ db, clock: () => now, maxDays: 40 });
    assert.deepEqual(second, { status: 'succeeded', days: 0, eventCount: 0 });
    assert.deepEqual(await grain(), afterFirst);
    await insertEvent({
      occurredAt: occurred,
      receivedAt: new Date('2026-06-15T09:00:00.000Z'),
      path: '/en/nbs-smoke-late',
      browserHash: 'smoke',
    });
    const smokeOnly = await runAnalyticsRollup({ db, clock: () => now, maxDays: 40 });
    assert.deepEqual(smokeOnly, { status: 'succeeded', days: 0, eventCount: 0 });
    assert.deepEqual(await grain(), afterFirst);
    await insertEvent({
      occurredAt: occurred,
      receivedAt: new Date('2026-06-15T10:00:00.000Z'),
      path: '/en',
      browserHash: 'browser-b',
    });
    const late = await runAnalyticsRollup({ db, clock: () => now, maxDays: 40 });
    assert.equal(late.status, 'succeeded');
    if (late.status !== 'succeeded') return;
    assert.equal(late.days, 1);
    const afterLate = await grain();
    assert.equal(afterLate.find((row) => row.siteDate === '2026-06-15')?.count, 3);
    assert.equal(afterLate.find((row) => row.siteDate === '2026-06-15')?.uniqueBrowsers, 2);
    const progress = await days();
    assert.equal(Date.parse(progress.find((day) => day.siteDate === '2026-06-15')?.sourceMaxReceivedAt ?? ''), Date.parse('2026-06-15T10:00:00.000Z'));
    const third = await runAnalyticsRollup({ db, clock: () => now, maxDays: 40 });
    assert.deepEqual(third, { status: 'succeeded', days: 0, eventCount: 0 });
    assert.deepEqual(await grain(), afterLate);
  });

  test('每次运行从最早未完成日开始，最多 7 天', async () => {
    assert.ok(db);
    const now = new Date('2026-06-16T12:00:00.000Z');
    await setTimezone('UTC', 1, now);
    const first = await runAnalyticsRollup({ db, clock: () => now });
    assert.equal(first.status, 'succeeded');
    if (first.status !== 'succeeded') return;
    assert.equal(first.days, 7);
    const eligible = eligibleSiteDates(now, 'UTC');
    const wrote = (await days()).map((day) => day.siteDate);
    assert.deepEqual(wrote, eligible.slice(0, 7));
    assert.equal(await latestContiguousRolledUpDate(db), eligible[6]);
    assert.deepEqual(await rolledUpDatesBefore(eligible[3], db), eligible.slice(0, 3));
    assert.equal(await isSiteDateRolledUp(eligible[0], db), true);
    assert.equal(await isSiteDateRolledUp(siteLocalDate(now, 'UTC'), db), false);
    assert.equal(await isSiteDateRolledUp('2026-06-16T00:00:00.000Z', db), false);
    await assert.rejects(() => rolledUpDatesBefore('2026-6-1', db), /invalid_date/);
    const second = await runAnalyticsRollup({ db, clock: () => now });
    assert.equal(second.status, 'succeeded');
    if (second.status !== 'succeeded') return;
    assert.equal(second.days, 7);
    assert.deepEqual((await days()).map((day) => day.siteDate), eligible.slice(0, 14));
    assert.equal(await latestContiguousRolledUpDate(db), eligible[13]);
  });

  test('时区切换后同一事件只在当前代次里计算一次', async () => {
    assert.ok(db);
    const now = new Date('2026-06-16T20:00:00.000Z');
    const occurred = new Date('2026-05-18T18:00:00.000Z');
    const previous = 'America/New_York';
    const next = 'Asia/Shanghai';
    const previousDate = siteLocalDate(occurred, previous);
    const nextDate = siteLocalDate(occurred, next);
    assert.notEqual(previousDate, nextDate);
    await setTimezone(previous, 1, now);
    await insertEvent({ occurredAt: occurred, receivedAt: occurred, path: '/en', browserHash: 'boundary' });
    const first = await runAnalyticsRollup({ db, clock: () => now, maxDays: 40 });
    assert.equal(first.status, 'succeeded');
    assert.equal((await grain()).find((row) => row.siteDate === previousDate)?.count, 1);
    assert.equal(await isSiteDateRolledUp(previousDate, db), true);
    await setTimezone(next, 2, now);
    const second = await runAnalyticsRollup({ db, clock: () => now, maxDays: 40 });
    assert.equal(second.status, 'succeeded');
    const progress = await days();
    const currentDates = new Set(progress.filter((day) => day.timezoneRevision === 2).map((day) => day.siteDate));
    const currentCount = (await grain())
      .filter((row) => currentDates.has(row.siteDate))
      .reduce((sum, row) => sum + row.count, 0);
    assert.equal(currentCount, 1);
    assert.equal((await grain()).find((row) => row.siteDate === nextDate)?.count, 1);
    assert.equal(await isSiteDateRolledUp(nextDate, db), true);
    assert.equal(currentDates.has(previousDate), false);
    assert.equal(await isSiteDateRolledUp(previousDate, db), false);
    const kept = progress.find((day) => day.siteDate === previousDate);
    assert.equal(kept?.timezoneRevision, 1);
    assert.equal(kept?.eventCount, 1);
    const eligible = eligibleSiteDates(now, next);
    assert.equal(await latestContiguousRolledUpDate(db), eligible.at(-1));
    assert.notEqual(eligible.at(-1), siteLocalDate(now, next));
    assert.equal(await eventRows(), 1);
  });

  test('analytics-aggregate 租约没到期时第二次运行不写', async () => {
    assert.ok(db);
    const now = new Date('2026-06-16T12:00:00.000Z');
    await setTimezone('UTC', 1, now);
    const repo = createJobLeaseRepo({ db, clock: () => now });
    const claim = await repo.claim({ key: 'analytics-aggregate', owner: 'other-worker' });
    assert.equal(claim.acquired, true);
    const blocked = await runAnalyticsRollup({ db, clock: () => now });
    assert.deepEqual(blocked, { status: 'busy' });
    assert.equal((await days()).length, 0);
    await db.$executeRaw`DELETE FROM "JobState"`;
    const pair = await Promise.all([
      runAnalyticsRollup({ db, clock: () => new Date() }),
      runAnalyticsRollup({ db, clock: () => new Date() }),
    ]);
    assert.deepEqual(pair.map((item) => item.status).sort(), ['busy', 'succeeded']);
    assert.equal((await days()).length, 7);
  });

  test('设置行不可读时不写汇总', async () => {
    assert.ok(db);
    const now = new Date('2026-06-16T12:00:00.000Z');
    await db.$executeRaw`
      INSERT INTO "SiteSetting" ("key", "value")
      VALUES (${ANALYTICS_SETTINGS_KEY}, ${JSON.stringify({ timezoneRevision: 1 })}::jsonb)
    `;
    const result = await runAnalyticsRollup({ db, clock: () => now, maxDays: 40 });
    assert.deepEqual(result, { status: 'failed', days: 0, errorCode: 'service_unavailable' });
    assert.equal((await days()).length, 0);
    assert.equal(await isSiteDateRolledUp('2026-06-15', db), false);
    assert.equal(await latestContiguousRolledUpDate(db), null);
  });
});
