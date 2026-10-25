import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recomputableFrom, siteDayUtcBounds, siteLocalDate } from '../src/lib/analytics/day-boundaries';
import {
  aggregateSiteDay,
  eligibleSiteDates,
  isSmokeAnalyticsPath,
  latestContiguousDate,
  ROLLUP_MAX_DAYS,
  selectRollupDates,
  type RollupSourceEvent,
} from '../src/lib/analytics/rollup-plan';
import { alertAnalyticsRollupIssue } from '../src/lib/server/cron-alert';
import { API_ROUTE_IDS } from '../src/lib/server/http/metrics';
import { GET, POST } from '../src/app/api/admin/cron/analytics-rollup/route';

const NOW = new Date('2026-06-16T12:00:00.000Z');

function event(overrides: Partial<RollupSourceEvent> = {}): RollupSourceEvent {
  return {
    occurredAt: new Date('2026-06-15T18:00:00.000Z'),
    receivedAt: new Date('2026-06-15T18:00:01.000Z'),
    kind: 'page_view',
    locale: 'en',
    productSlug: null,
    path: '/en',
    browserHash: 'browser-a',
    ...overrides,
  };
}

test('站点本地日和 UTC 日不一致时，事件只落在本地日的左闭右开窗口里', () => {
  const occurred = new Date('2026-06-15T03:30:00.000Z');
  const local = siteLocalDate(occurred, 'America/New_York');
  assert.equal(local, '2026-06-14');
  assert.notEqual(local, occurred.toISOString().slice(0, 10));
  const onDay = aggregateSiteDay([event({ occurredAt: occurred, receivedAt: occurred })], siteDayUtcBounds(local, 'America/New_York'));
  const utcDay = aggregateSiteDay([event({ occurredAt: occurred, receivedAt: occurred })], siteDayUtcBounds('2026-06-15', 'America/New_York'));
  assert.equal(onDay.eventCount, 1);
  assert.equal(onDay.rows[0]?.siteDate, '2026-06-14');
  assert.equal(utcDay.eventCount, 0);
  const dates = eligibleSiteDates(NOW, 'America/New_York');
  assert.equal(dates[0], siteLocalDate(new Date(recomputableFrom(NOW, 'America/New_York')), 'America/New_York'));
  assert.equal(dates.at(-1), '2026-06-15');
  assert.equal(dates.includes(siteLocalDate(NOW, 'America/New_York')), false);
  assert.equal(dates.includes('2026-06-17'), false);
});

test('秋令时 25 小时里的两次 1:30 只属于同一个本地日', () => {
  const day = siteDayUtcBounds('2026-11-01', 'America/New_York');
  const first = event({ occurredAt: new Date('2026-11-01T05:30:00.000Z'), browserHash: 'one' });
  const second = event({ occurredAt: new Date('2026-11-01T06:30:00.000Z'), browserHash: 'two' });
  const rolled = aggregateSiteDay([first, second], day);
  assert.equal(rolled.eventCount, 2);
  assert.equal(rolled.rows.length, 1);
  assert.equal(rolled.rows[0]?.uniqueBrowsers, 2);
  assert.equal(aggregateSiteDay([first, second], siteDayUtcBounds('2026-10-31', 'America/New_York')).eventCount, 0);
  assert.equal(aggregateSiteDay([first, second], siteDayUtcBounds('2026-11-02', 'America/New_York')).eventCount, 0);
  assert.equal((Date.parse(day.endUtc) - Date.parse(day.startUtc)) / 3_600_000, 25);
});

test('冒烟路径不进入计数，同一浏览器的重复访问只算一个 uniqueBrowsers', () => {
  assert.equal(isSmokeAnalyticsPath('/en/nbs-smoke-probe'), true);
  assert.equal(isSmokeAnalyticsPath('/ru/nbs-smoke-widget/page'), true);
  assert.equal(isSmokeAnalyticsPath('nbs-smoke-raw'), true);
  assert.equal(isSmokeAnalyticsPath('/en/nbs-smoke-probe?token=1#frag'), true);
  assert.equal(isSmokeAnalyticsPath('/en/products'), false);
  assert.equal(isSmokeAnalyticsPath('/en/my-nbs-smoke-page'), false);
  assert.equal(isSmokeAnalyticsPath(null), false);
  const bounds = siteDayUtcBounds('2026-06-15', 'America/New_York');
  const rolled = aggregateSiteDay([
    event({ path: '/en', browserHash: 'browser-a' }),
    event({ path: '/en', browserHash: 'browser-a' }),
    event({ path: '/en', browserHash: 'browser-b' }),
    event({ path: '/en/nbs-smoke-probe', browserHash: 'smoke' }),
    event({ path: '/ru/nbs-smoke-widget/page', browserHash: 'smoke-2', locale: 'ru' }),
    event({ path: '/en/my-nbs-smoke-page', browserHash: 'browser-c' }),
    event({ path: '/en/products', kind: 'product_view', productSlug: null, browserHash: 'browser-b' }),
    event({ path: '/en/products', kind: 'product_view', productSlug: 'gift-boxes', browserHash: 'browser-d' }),
  ], bounds);
  assert.equal(rolled.eventCount, 6);
  assert.deepEqual(rolled.rows.map((row) => [row.kind, row.locale, row.productSlug, row.count, row.uniqueBrowsers]), [
    ['page_view', 'en', '', 4, 3],
    ['product_view', 'en', '', 1, 1],
    ['product_view', 'en', 'gift-boxes', 1, 1],
  ]);
  const again = aggregateSiteDay([
    event({ path: '/en/products', kind: 'product_view', productSlug: 'gift-boxes', browserHash: 'browser-d' }),
    event({ path: '/en/nbs-smoke-probe', browserHash: 'smoke' }),
    event({ path: '/en', browserHash: 'browser-b' }),
    event({ path: '/en', browserHash: 'browser-a' }),
    event({ path: '/en', browserHash: 'browser-a' }),
    event({ path: '/ru/nbs-smoke-widget/page', browserHash: 'smoke-2', locale: 'ru' }),
    event({ path: '/en/my-nbs-smoke-page', browserHash: 'browser-c' }),
    event({ path: '/en/products', kind: 'product_view', productSlug: null, browserHash: 'browser-b' }),
  ], bounds);
  assert.deepEqual(again, rolled);
});

test('今天和未来不汇总；迟到事件、旧时区代次和天数上限决定要重算的日子', () => {
  assert.equal(ROLLUP_MAX_DAYS, 7);
  const dates = eligibleSiteDates(NOW, 'UTC');
  assert.equal(dates.includes(siteLocalDate(NOW, 'UTC')), false);
  assert.equal(aggregateSiteDay([event({ occurredAt: NOW })], siteDayUtcBounds(dates.at(-1) as string, 'UTC')).eventCount, 0);
  const eligible = ['2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-23', '2026-05-24', '2026-05-25', '2026-05-26', '2026-05-27'];
  const stored = eligible.slice(0, 2).map((siteDate) => ({
    siteDate,
    timezoneRevision: 1,
    sourceMaxReceivedAt: '2026-05-18T00:00:00.000Z',
  }));
  const same = stored.map((day) => ({ siteDate: day.siteDate, sourceMaxReceivedAt: day.sourceMaxReceivedAt }));
  assert.deepEqual(selectRollupDates({ eligible, stored, freshness: same, timezoneRevision: 1 }).slice(0, 2), ['2026-05-20', '2026-05-21']);
  assert.equal(selectRollupDates({ eligible, stored, freshness: same, timezoneRevision: 1 }).length, 7);
  assert.equal(selectRollupDates({ eligible, stored, freshness: same, timezoneRevision: 1 })[0], '2026-05-20');
  const late = [{ siteDate: '2026-05-18', sourceMaxReceivedAt: '2026-05-18T01:00:00.000Z' }, same[1]];
  assert.equal(selectRollupDates({ eligible, stored, freshness: late, timezoneRevision: 1 })[0], '2026-05-18');
  assert.deepEqual(
    selectRollupDates({ eligible: eligible.slice(0, 2), stored, freshness: same, timezoneRevision: 2 }),
    ['2026-05-18', '2026-05-19'],
  );
  assert.equal(latestContiguousDate(['2026-05-20', '2026-05-18', '2026-05-19', '2026-05-21']), '2026-05-21');
  assert.equal(latestContiguousDate(['2026-05-18', '2026-05-19', '2026-05-21']), '2026-05-19');
  assert.equal(latestContiguousDate([]), null);
});

test('汇总表只新增计数，cron 沿用 CRON_SECRET，不把原始标识写进表或告警', async () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const body = (name: string) => {
    const start = schema.indexOf(`model ${name} {`);
    const end = schema.indexOf('\n}', start);
    return schema.slice(start, end);
  };
  const daily = body('AnalyticsDailyRollup');
  const progress = body('AnalyticsRollupDay');
  const events = body('AnalyticsEvent');
  assert.match(daily, /@@unique\(\[siteDate, kind, locale, productSlug\]\)/);
  assert.match(schema, /productSlug 没有产品时存 ''/);
  assert.match(progress, /siteDate\s+String\s+@id/);
  assert.match(progress, /timezoneRevision\s+Int/);
  assert.match(events, /eventId\s+String\s+@id/);
  for (const block of [daily, progress]) {
    assert.doesNotMatch(block, /browserHash|eventId|navigationId|viewId|\bpath\b/);
  }
  const source = readFileSync('src/lib/server/analytics/rollup.ts', 'utf8');
  assert.match(source, /::timestamptz AT TIME ZONE 'UTC'/);
  assert.match(source, /DELETE FROM "AnalyticsDailyRollup"/);
  assert.doesNotMatch(source, /DELETE FROM "AnalyticsEvent"|queryRawUnsafe/);
  assert.equal(API_ROUTE_IDS.includes('GET /api/admin/cron/analytics-rollup' as never), false);
  assert.equal(API_ROUTE_IDS.includes('POST /api/admin/cron/analytics-rollup' as never), false);
  const route = readFileSync('src/app/api/admin/cron/analytics-rollup/route.ts', 'utf8');
  assert.match(route, /secretMatches\(token, process\.env\.CRON_SECRET\)/);
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'unit-test-cron-secret-not-a-real-value';
  try {
    const missing = await GET(new Request('http://127.0.0.1/api/admin/cron/analytics-rollup'));
    const wrong = await POST(new Request('http://127.0.0.1/api/admin/cron/analytics-rollup', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    }));
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    const body = await wrong.json() as { error: string };
    assert.equal(body.error, 'unauthorized');
    assert.equal(JSON.stringify(body).includes('unit-test-cron-secret'), false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
  let lines: Record<string, string | number> | undefined;
  await alertAnalyticsRollupIssue({ errorCode: 'internal_error', days: 2 }, async (_kind, sent) => {
    lines = sent;
  });
  assert.deepEqual(lines, { 任务: 'analytics-rollup', 已完成天数: 2, 错误码: 'internal_error' });
  assert.equal(JSON.stringify(lines).includes('/en/nbs-smoke-probe'), false);
});
