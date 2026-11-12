// M5-T12 day-state（AnalyticsAggregateDayState / AnalyticsDayChange）在隔离 schema 的真实 PostgreSQL 验收。
//
// 与 analytics-aggregate.db.test.ts 同一套门禁：PG 回归步骤设 M5T12_REQUIRE_DATABASE=true 并注入
// DATABASE_URL，缺库时逐用例具名失败；其它 job（无库）按仓库惯例整组 skip。
// 覆盖：state 插入/读回精度、CAS 双列守卫（markers + updatedAt）、行存在时 expected NULL 永不匹配、
// bootstrap ON CONFLICT DO NOTHING、UTC 日 marker bump（含终态 bump start 日）、M6 四条件分类。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import { siteDayUtcBounds } from '../src/lib/analytics/day-boundaries';
import { classifyDayCompleteness, toVersion } from '../src/lib/analytics/daily-aggregate';
import {
  bumpDayChangeVersions,
  casWriteDayState,
  createAnalyticsDayMarkerSink,
  dailyExpiresAt,
  insertDayStateIfAbsent,
  mergeDeferUntil,
  parseMarkerVersions,
  readDayState,
  readLiveMarkerVersions,
} from '../src/lib/server/analytics/aggregate-day-state';

const base = process.env.DATABASE_URL;
const SCHEMA = `day_state_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}&connection_limit=3&pool_timeout=10`
  : null;
if (process.env.M5T12_REQUIRE_DATABASE === 'true' && !url) {
  throw new Error('DATABASE_URL must be a postgres URL when M5T12_REQUIRE_DATABASE=true');
}
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no DATABASE_URL';

const TZ = 'Asia/Kolkata';
const REV = 3;

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

function requireDb(): PrismaClient {
  if (!db) assert.fail('M5-T12 day-state PG 回归必须连真实 PostgreSQL：DATABASE_URL 未设置或缺库');
  return db;
}

after(async () => {
  if (!db) return;
  assert.match(SCHEMA, /^day_state_\d+$/);
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

describe('M5-T12 analytics day-state CAS and live markers', { concurrency: false, skip, timeout: 120_000 }, () => {
  before(async () => {
    if (!db) return;
    const conn = requireDb();
    await conn.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await conn.$executeRawUnsafe(`SET search_path TO "${SCHEMA}"`);
    const pushed = await Promise.resolve()
      .then(async () => {
        const { execFileSync } = await import('node:child_process');
        const { createRequire } = await import('node:module');
        const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
        execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: url! },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return true;
      })
      .catch(() => false);
    assert.equal(pushed, true, 'prisma db push failed');
  });

  async function reset() {
    const conn = requireDb();
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsAggregateDayState"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsDayChange"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsEvent"`);
  }

  let seq = 0;
  async function insertEvent(input: {
    occurredAt: Date;
    kind: 'model_view_start' | 'model_load_success' | 'page_view';
    browserHash: string;
    viewId?: string | null;
    receivedAt?: Date;
  }) {
    const conn = requireDb();
    seq += 1;
    await conn.$executeRaw`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "viewId", "occurredAt", "receivedAt"
      ) VALUES (
        ${`ds-ev-${process.pid}-${seq}`},
        ${`ds-sk-${process.pid}-${seq}`},
        ${'p'.repeat(64)},
        ${input.browserHash},
        ${input.kind}::"AnalyticsEventKind",
        ${'en'},
        NULL,
        ${'/en'},
        ${input.viewId ?? null},
        ${utc(input.occurredAt)},
        ${utc(input.receivedAt ?? input.occurredAt)}
      )
    `;
  }

  test('插入后读回：markers 十进制字符串、defer/gap/updatedAt 毫秒精度', async () => {
    await reset();
    const now = new Date('2026-03-02T18:30:00.123Z');
    const defer = new Date('2026-03-03T00:00:00.456Z');
    const affected = await casWriteDayState(requireDb(), {
      localDate: '2026-03-02',
      timezoneRevision: REV,
      timezone: TZ,
      markerVersions: { '2026-03-01': '7', '2026-03-02': '9' },
      deferUntil: defer,
      gapKind: null,
      gapSince: null,
      expectedMarkers: {},
      expectedUpdatedAt: null,
      now,
    });
    assert.equal(affected, 1);

    const row = await readDayState(requireDb(), { localDate: '2026-03-02', timezoneRevision: REV });
    assert.ok(row);
    assert.equal(row.timezone, TZ);
    assert.deepEqual(row.markerVersions, { '2026-03-01': '7', '2026-03-02': '9' });
    assert.equal(row.deferUntil?.toISOString(), defer.toISOString());
    assert.equal(row.gapKind, null);
    assert.equal(row.updatedAt.toISOString(), now.toISOString());

    const live = await readLiveMarkerVersions(requireDb());
    assert.equal(live.size, 0);
  });

  test('CAS 双列守卫：markers 相同但 updatedAt 不同 → 0 行；行存在时 expected NULL → 0 行', async () => {
    await reset();
    const first = new Date('2026-03-02T01:00:00.000Z');
    const second = new Date('2026-03-02T02:00:00.000Z');
    const later = new Date('2026-03-02T03:00:00.000Z');
    const conn = requireDb();
    await casWriteDayState(conn, {
      localDate: '2026-03-01',
      timezoneRevision: REV,
      timezone: TZ,
      markerVersions: { '2026-03-01': '4' },
      deferUntil: null,
      gapKind: null,
      gapSince: null,
      expectedMarkers: {},
      expectedUpdatedAt: null,
      now: first,
    });

    // 匹配：markers 与 updatedAt 都是读回的真实值。
    assert.equal(await casWriteDayState(conn, {
      localDate: '2026-03-01',
      timezoneRevision: REV,
      timezone: TZ,
      markerVersions: { '2026-03-01': '5' },
      deferUntil: null,
      gapKind: 'late_unattributable',
      gapSince: second,
      expectedMarkers: { '2026-03-01': '4' },
      expectedUpdatedAt: first,
      now: second,
    }), 1);

    // 第二守卫：markers 相同、updatedAt 早 1 小时 → 影响 0 行，行不变。
    assert.equal(await casWriteDayState(conn, {
      localDate: '2026-03-01',
      timezoneRevision: REV,
      timezone: TZ,
      markerVersions: { '2026-03-01': '6' },
      deferUntil: null,
      gapKind: null,
      gapSince: null,
      expectedMarkers: { '2026-03-01': '5' },
      expectedUpdatedAt: first,
      now: later,
    }), 0);
    const afterSecondGuard = await readDayState(conn, { localDate: '2026-03-01', timezoneRevision: REV });
    assert.deepEqual(afterSecondGuard?.markerVersions, { '2026-03-01': '5' });
    assert.equal(afterSecondGuard?.gapKind, 'late_unattributable');
    assert.equal(afterSecondGuard?.updatedAt.toISOString(), second.toISOString());

    // 行存在 + expected NULL：SQL `= NULL` 永不匹配。
    assert.equal(await casWriteDayState(conn, {
      localDate: '2026-03-01',
      timezoneRevision: REV,
      timezone: TZ,
      markerVersions: { '2026-03-01': '9' },
      deferUntil: null,
      gapKind: null,
      gapSince: null,
      expectedMarkers: {},
      expectedUpdatedAt: null,
      now: later,
    }), 0);

    // 过期 markers 同样 0 行。
    assert.equal(await casWriteDayState(conn, {
      localDate: '2026-03-01',
      timezoneRevision: REV,
      timezone: TZ,
      markerVersions: { '2026-03-01': '9' },
      deferUntil: null,
      gapKind: null,
      gapSince: null,
      expectedMarkers: { '2026-03-01': '4' },
      expectedUpdatedAt: second,
      now: later,
    }), 0);
  });

  test('bootstrap：ON CONFLICT DO NOTHING，已存在的行不被覆盖', async () => {
    await reset();
    const now = new Date('2026-03-02T05:00:00.000Z');
    const conn = requireDb();
    const args = {
      localDate: '2026-02-20',
      timezoneRevision: REV,
      timezone: TZ,
      markerVersions: { '2026-02-20': '2' },
      deferUntil: null,
      gapKind: 'not_backfilled',
      gapSince: now,
      now,
    };
    assert.equal(await insertDayStateIfAbsent(conn, args), 1);
    assert.equal(await insertDayStateIfAbsent(conn, { ...args, gapKind: 'raw_partial' }), 0);
    const row = await readDayState(conn, { localDate: '2026-02-20', timezoneRevision: REV });
    assert.equal(row?.gapKind, 'not_backfilled');
    assert.deepEqual(row?.markerVersions, { '2026-02-20': '2' });
  });

  test('marker bump：一次调用内同日去重、跨调用继续推进；终态额外 bump 配对 start 的 UTC 日', async () => {
    await reset();
    const conn = requireDb();
    const now = new Date('2026-03-02T06:00:00.000Z');
    await bumpDayChangeVersions(conn, ['2026-03-02', '2026-03-02'], now);
    await bumpDayChangeVersions(conn, ['2026-03-02'], now);
    const live = await readLiveMarkerVersions(conn);
    // 同一调用内的同日按 Set 去重：重复日只前进 1，跨调用才再 +1。
    assert.equal(live.get('2026-03-02'), '2');
    // 跨日不吞：不同 UTC 日同批各 +1（只去重同日）。
    await bumpDayChangeVersions(conn, ['2026-03-03', '2026-03-03'], now);
    const multiDay = await readLiveMarkerVersions(conn);
    assert.equal(multiDay.get('2026-03-03'), '1');
    assert.equal(multiDay.get('2026-03-02'), '2');

    // start 在 03-01，终态在 03-02：sink 必须同时 bump 03-01 与 03-02。
    const start = new Date('2026-03-01T20:00:00.000Z');
    await insertEvent({ kind: 'model_view_start', browserHash: 'bh-start', viewId: 'v-1', occurredAt: start });
    await insertEvent({
      kind: 'model_load_success',
      browserHash: 'bh-start',
      viewId: 'v-1',
      occurredAt: new Date('2026-03-02T01:00:00.000Z'),
    });
    const sink = createAnalyticsDayMarkerSink();
    await sink.bumpInTx(conn, [
      {
        kind: 'model_load_success',
        browserHash: 'bh-start',
        viewId: 'v-1',
        occurredAt: new Date('2026-03-02T01:00:00.000Z'),
      },
    ], new Date('2026-03-02T01:00:01.000Z'));
    const afterBump = await readLiveMarkerVersions(conn);
    assert.equal(afterBump.get('2026-03-01'), '1');
    assert.equal(afterBump.get('2026-03-02'), '3');
  });

  test('M6 分类接真实行：markers 全等 → complete；bump 后 → live_marker_ahead；gap → partial', async () => {
    await reset();
    const conn = requireDb();
    const now = new Date('2026-03-02T07:00:00.000Z');
    const bounds = siteDayUtcBounds('2026-03-02', TZ);
    const mapped = classifyDayCompleteness({
      siteRow: { timezone: TZ },
      state: { markerVersions: {}, deferUntil: null, gapKind: null },
      bounds,
      liveVersions: new Map(),
    });
    // 空 markers 但映射日 live 都是缺键 0 → 视为 complete（缺键=0）。
    assert.equal(mapped.status, 'complete');

    const markerDates = ['2026-03-01', '2026-03-02'];
    const live = await readLiveMarkerVersions(conn);
    const consumed: Record<string, string> = {};
    for (const utcDate of markerDates) consumed[utcDate] = toVersion(live.get(utcDate));
    await casWriteDayState(conn, {
      localDate: '2026-03-02',
      timezoneRevision: REV,
      timezone: TZ,
      markerVersions: consumed,
      deferUntil: null,
      gapKind: null,
      gapSince: null,
      expectedMarkers: {},
      expectedUpdatedAt: null,
      now,
    });
    const state = await readDayState(conn, { localDate: '2026-03-02', timezoneRevision: REV });
    assert.ok(state);
    const complete = classifyDayCompleteness({
      siteRow: { timezone: TZ },
      state,
      bounds,
      liveVersions: await readLiveMarkerVersions(conn),
    });
    assert.equal(complete.status, 'complete');

    await bumpDayChangeVersions(conn, ['2026-03-02'], now);
    const ahead = classifyDayCompleteness({
      siteRow: { timezone: TZ },
      state,
      bounds,
      liveVersions: await readLiveMarkerVersions(conn),
    });
    assert.equal(ahead.reason, 'live_marker_ahead');
    assert.equal(ahead.utcDate, '2026-03-02');

    const gapped = classifyDayCompleteness({
      siteRow: { timezone: TZ },
      state: { ...state, gapKind: 'clock_inversion' },
      bounds,
      liveVersions: new Map(),
    });
    assert.equal(gapped.reason, 'gap:clock_inversion');
  });

  test('到期与 defer 纯函数：13 自然月正推到日首，旧 defer 只在晚于 now 时保留', () => {
    assert.equal(dailyExpiresAt('2026-01-31', 'UTC').toISOString(), '2027-02-28T00:00:00.000Z');
    assert.equal(dailyExpiresAt('2024-02-29', 'UTC').toISOString(), '2025-03-29T00:00:00.000Z');
    assert.equal(dailyExpiresAt('2026-01-31', TZ).toISOString(), '2027-02-27T18:30:00.000Z');

    const now = new Date('2026-03-02T00:00:00.000Z');
    assert.equal(mergeDeferUntil(null, null, now), null);
    assert.equal(mergeDeferUntil(new Date('2026-03-01T00:00:00Z'), null, now), null);
    assert.equal(
      mergeDeferUntil(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-05T00:00:00Z'), now)?.toISOString(),
      '2026-03-05T00:00:00.000Z',
    );
    assert.equal(
      mergeDeferUntil(new Date('2026-03-09T00:00:00Z'), new Date('2026-03-05T00:00:00Z'), now)?.toISOString(),
      '2026-03-05T00:00:00.000Z',
    );
    assert.deepEqual(parseMarkerVersions({ a: 2, b: '3', c: null, d: true }), { a: '2', b: '3' });
  });
});
