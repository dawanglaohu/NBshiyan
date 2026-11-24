import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PrismaClient, type AnalyticsDaily, type AnalyticsEventKind } from '@prisma/client';
import { StatsDTOSchema } from '../src/lib/contracts/ops';
import { runDailyAggregateRound } from '../src/lib/server/analytics/aggregate';
import { AGGREGATE_JOB_KEY } from '../src/lib/server/analytics/aggregate-repo';
import { readCoreStats, selectStatsSources } from '../src/lib/server/ops/stats-query';

const connection = process.env.M6T1_TEST_DATABASE_URL;
if (!connection && process.env.M6T1_REQUIRE_DATABASE === 'true') {
  throw new Error('M6T1_TEST_DATABASE_URL is required');
}
const schema = 'm6t1_' + randomBytes(8).toString('hex');
let db: PrismaClient;
let schemaCreated = false;
const now = new Date('2026-03-11T16:00:00.000Z');
const aggregatedAt = new Date('2026-03-11T15:56:00.000Z');
const revision = { timezoneRevision: 2, timezone: 'America/New_York', legacyBefore: '2026-03-07' };
const product = 'color-boxes';
const march8 = { from: '2026-03-08', to: '2026-03-08' };
const march9 = { from: '2026-03-09', to: '2026-03-09' };

function read(query: Parameters<typeof readCoreStats>[1]['query'], overrides: Partial<Parameters<typeof readCoreStats>[1]> = {}) {
  return readCoreStats(db, { query, role: 'ADMIN', revision, connected: true, now, ...overrides });
}

function source(result: Awaited<ReturnType<typeof readCoreStats>>, name: string) {
  const dto = result.sources.find((candidate) => candidate.source === name);
  assert.ok(dto, name);
  return dto;
}

async function putDaily(localDate: string, overrides: Partial<AnalyticsDaily> = {}) {
  await db.analyticsDaily.create({
    data: {
      localDate, dimension: 'site', timezone: revision.timezone, timezoneRevision: revision.timezoneRevision,
      visitors: 0, pageViews: 0, productViews: 0, modelStarts: 0, modelSuccesses: 0, modelFailures: 0, chatStarts: 0,
      durationMsSum: 0n, loadDurationSamples: 0, sourceThrough: null, aggregatedAt,
      expiresAt: new Date('2027-04-01T00:00:00Z'), ...overrides,
    },
  });
}

async function putState(localDate: string, markerVersions: Record<string, string> = {}) {
  await db.analyticsAggregateDayState.create({
    data: { localDate, timezoneRevision: 2, timezone: revision.timezone, markerVersions },
  });
}

async function putLegacy(localDate: string, count: number, timezoneRevision = 2) {
  await db.analyticsRollupDay.create({
    data: { siteDate: localDate, timezoneRevision, eventCount: count, completedAt: aggregatedAt },
  });
  await db.analyticsDailyRollup.createMany({
    data: [
      { siteDate: localDate, kind: 'page_view', locale: 'en', count, uniqueBrowsers: 1 },
      { siteDate: localDate, kind: 'model_view_start', locale: 'en', productSlug: product, count, uniqueBrowsers: 1 },
      { siteDate: localDate, kind: 'model_load_success', locale: 'ru', productSlug: product, count, uniqueBrowsers: 1 },
    ],
  });
}

describe('M6-T1 core statistics on dedicated PostgreSQL', { skip: !connection && 'no M6T1_TEST_DATABASE_URL' }, () => {
  before(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.pathname !== '/m6t1_stats_test' || url.searchParams.has('schema')) {
      throw new Error('Use a dedicated local m6t1_stats_test database without a schema parameter');
    }
    url.searchParams.set('schema', schema);
    db = new PrismaClient({ datasourceUrl: url.toString() });
    const [identity] = await db.$queryRaw<Array<{ name: string; version: number }>>`
      SELECT current_database() AS name, current_setting('server_version_num')::int AS version
    `;
    assert.equal(identity.name, 'm6t1_stats_test');
    assert.equal(Math.trunc(identity.version / 10_000), 17);
    await db.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    schemaCreated = true;
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      timeout: 60_000,
    });
  });

  after(async () => {
    if (!db) return;
    try {
      if (schemaCreated) await db.$executeRawUnsafe('DROP SCHEMA "' + schema + '" CASCADE');
    } finally {
      await db.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.$transaction([
      db.analyticsDaily.deleteMany(), db.analyticsAggregateDayState.deleteMany(),
      db.analyticsDayChange.deleteMany(), db.analyticsDailyRollup.deleteMany(),
      db.analyticsRollupDay.deleteMany(), db.analyticsEvent.deleteMany(),
      db.jobState.deleteMany(), db.siteSetting.deleteMany(),
    ]);
  });

  test('E-49/E-50 distinguish covered zero, a hole, first use and disconnection', async () => {
    assert.equal(source(await read(march9), 'page_views').state, 'no_data');
    await putDaily(march9.from);
    await putState(march9.from);
    const result = await read(march9);
    assert.deepEqual(source(result, 'page_views'), {
      source: 'page_views', state: 'zero', value: 0, coverage: 'full',
      timezone: revision.timezone, timezoneRevision: 2,
      queriedAt: now.toISOString(), lastSucceededAt: aggregatedAt.toISOString(), dataThrough: null,
    });
    assert.equal(result.scope.from, '2026-03-09');
    assert.equal(result.scope.toExclusive, '2026-03-10');
    StatsDTOSchema.parse({ sources: result.sources });
    const partial = source(await read({ ...march9, from: march8.from }), 'page_views');
    assert.deepEqual([partial.state, partial.value, partial.coverage], ['no_data', null, 'partial']);
    const disconnected = source(await read(march9, { connected: false }), 'page_views');
    assert.deepEqual([disconnected.state, disconnected.value, disconnected.lastSucceededAt], ['not_connected', null, null]);
  });

  test('E-55 uses the selected revision, DST bounds and stored site UV', async () => {
    await putDaily(march8.from, { visitors: 2, pageViews: 3 });
    await putDaily(march8.from, { dimension: 'product:' + product, visitors: 2, pageViews: null });
    await putDaily(march8.from, { dimension: 'product:paper-bags', visitors: 2, pageViews: null });
    await putDaily(march8.from, { timezoneRevision: 3, timezone: 'Asia/Tokyo', visitors: 99, pageViews: 99 });
    await putDaily(march9.from, { visitors: 88, pageViews: 88 });
    await putState(march8.from);
    const query = { ...march8, timezoneRevision: 2 };
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      const first = await read(query);
      process.env.TZ = 'Pacific/Honolulu';
      assert.deepEqual(await read(query), first);
      assert.equal(first.scope.startUtc, '2026-03-08T05:00:00.000Z');
      assert.equal(first.scope.endUtc, '2026-03-09T04:00:00.000Z');
      assert.equal(source(first, 'visitors').value, 2);
      assert.equal(source(first, 'page_views').value, 3);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    const selected = await read({ ...query, productSlug: product });
    assert.deepEqual([source(selected, 'page_views').state, source(selected, 'page_views').value], ['no_data', null]);
    assert.equal(source(selected, 'visitors').value, 2);
    await assert.rejects(read({ ...query, timezoneRevision: 3 }), { code: 'invalid' });
  });

  test('legacy data needs a pre-cutover day and matching watermark; new rows take precedence', async () => {
    await putLegacy('2026-03-03', 99, 1);
    await putLegacy('2026-03-04', 7);
    await putLegacy('2026-03-06', 66);
    await putLegacy('2026-03-07', 77);
    await putLegacy(march8.from, 88);
    await db.analyticsDailyRollup.create({
      data: { siteDate: '2026-03-05', kind: 'page_view', locale: 'en', count: 55, uniqueBrowsers: 1 },
    });
    await putDaily('2026-03-06', { pageViews: 3, visitors: 1, modelStarts: 1, modelSuccesses: 1 });
    await putDaily(march8.from, { pageViews: 5, visitors: 2, modelStarts: 3, modelFailures: 1 });
    await putState('2026-03-06');
    await putState(march8.from);
    const range = { from: '2026-03-03', to: '2026-03-08' };
    const result = await read(range);
    assert.deepEqual([source(result, 'page_views').value, source(result, 'page_views').coverage], [15, 'partial']);
    assert.equal(source(result, 'model_starts').value, 11);
    assert.equal(source(result, 'model_successes').value, 1);
    assert.equal(source(result, 'visitors').value, 3);
    assert.deepEqual(result.modelSuccessRate, { value: 0.25, coverage: 'partial' });
    const onlyLegacy = { from: '2026-03-04', to: '2026-03-04' };
    assert.equal(source(await read(onlyLegacy), 'page_views').coverage, 'partial');
    const noCutover = await read(onlyLegacy, { revision: { ...revision, legacyBefore: null } });
    assert.equal(source(noCutover, 'page_views').state, 'no_data');
  });

  test('site row, state, expiry and both sides of the live marker determine completeness', async () => {
    const query = { ...march8, productSlug: product };
    await putDaily(query.from, { dimension: 'product:' + product, pageViews: null, visitors: 4 });
    assert.equal(source(await read(query), 'visitors').state, 'no_data');
    await putDaily(query.from);
    assert.equal(source(await read(query), 'visitors').coverage, 'partial');
    await putState(query.from, { '2026-03-09': '9007199254740993' });
    assert.equal(source(await read(query), 'visitors').coverage, 'partial');
    await db.analyticsDayChange.create({ data: { utcDate: '2026-03-09', version: 9007199254740993n } });
    const complete = await read(query);
    assert.deepEqual([source(complete, 'visitors').value, source(complete, 'visitors').coverage], [4, 'full']);
    await db.analyticsDayChange.update({ where: { utcDate: '2026-03-09' }, data: { version: { increment: 1n } } });
    assert.equal(source(await read(query), 'visitors').coverage, 'partial');
    await db.analyticsDayChange.update({ where: { utcDate: '2026-03-09' }, data: { version: 9007199254740993n } });
    await db.analyticsAggregateDayState.updateMany({ data: { deferUntil: new Date('2026-03-09T00:00:00Z') } });
    assert.equal(source(await read(query), 'visitors').coverage, 'partial');
    await db.analyticsAggregateDayState.updateMany({ data: { deferUntil: null, gapKind: 'raw_partial' } });
    assert.equal(source(await read(query), 'visitors').coverage, 'partial');
    await db.analyticsDaily.updateMany({ where: { dimension: 'site' }, data: { expiresAt: now } });
    assert.equal(source(await read(query), 'visitors').state, 'no_data');
  });

  test('E-63 reads paired terminals and weighted samples from the real aggregate writer', async () => {
    const writeAt = new Date('2026-03-11T15:55:00Z');
    await db.siteSetting.create({
      data: { key: 'analytics.settings', value: { timezone: revision.timezone, timezoneRevision: 2,
        version: 1, changedAt: writeAt.toISOString(), updatedBy: null } },
    });
    await db.jobState.create({
      data: { key: AGGREGATE_JOB_KEY, generation: 1, leaseOwner: 'm6-test', lockedUntil: now, lastStatus: 'RUNNING' },
    });
    const events: Array<[AnalyticsEventKind, string, string, number | null]> = [
      ['model_view_start', 'a', '2026-03-08T05:00:00Z', null],
      ['model_load_failure', 'a', '2026-03-08T05:00:00.100Z', 100],
      ['model_view_start', 'b', '2026-03-09T04:00:00Z', null],
      ['model_load_success', 'b', '2026-03-09T04:00:00.200Z', 200],
      ['model_view_start', 'c', '2026-03-09T04:01:00Z', null],
      ['model_load_failure', 'c', '2026-03-09T04:01:00.400Z', 400],
      ['model_view_start', 'd', '2026-03-09T04:02:00Z', null],
      ['model_load_success', 'orphan', '2026-03-09T04:03:00Z', 50_000],
    ];
    await db.analyticsEvent.createMany({
      data: events.map(([kind, viewId, at, durationMs], index) => ({
        eventId: 'event-' + index, semanticKey: 'key-' + index, payloadHash: 'test-hash',
        kind, viewId, durationMs, occurredAt: new Date(at), receivedAt: new Date(at),
        browserHash: 'test-browser', productSlug: product, locale: 'en',
      })),
    });
    const written = await runDailyAggregateRound({
      db, now: writeAt, clock: () => writeAt, timezoneRevision: 2, siteTimezone: revision.timezone,
      generation: 1, leaseOwner: 'm6-test', currentDate: '2026-03-11',
      baseDates: ['2026-03-08', '2026-03-09', '2026-03-10'],
    });
    assert.equal(written.status, 'ok');
    assert.deepEqual(written.committed, ['2026-03-08', '2026-03-09', '2026-03-10']);
    const all = await read({ from: march8.from, to: march9.to });
    assert.equal(source(all, 'model_starts').value, 4);
    assert.equal(source(all, 'model_successes').value, 1);
    assert.equal(source(all, 'model_failures').value, 2);
    assert.equal(source(all, 'mean_load_duration_ms').value, 700 / 3);
    assert.equal(source(all, 'mean_load_duration_ms').loadDurationSamples, 3);
    assert.equal(all.modelSuccessRate?.value, 0.25);
    const failed = await read({ ...march8, productSlug: product });
    assert.deepEqual(failed.modelSuccessRate, { value: 0, coverage: 'full' });
    const noSamples = await read({ from: '2026-03-10', to: '2026-03-10' });
    assert.deepEqual(noSamples.modelSuccessRate, { value: null, coverage: 'full' });
    const mean = source(noSamples, 'mean_load_duration_ms');
    assert.deepEqual([mean.state, mean.value, mean.loadDurationSamples], ['no_data', null, 0]);
    StatsDTOSchema.parse({ sources: noSamples.sources });
  });

  test('returns source failure from a PostgreSQL error and preserves unsupported product page views', async () => {
    const url = new URL(connection!);
    url.searchParams.set('schema', schema + '_missing');
    const unavailable = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      const result = await readCoreStats(unavailable, {
        query: { ...march8, productSlug: product, sources: ['visitors', 'page_views'] },
        role: 'EDITOR', revision, connected: true, now,
      });
      const visitors = source(result, 'visitors');
      assert.deepEqual(
        [visitors.state, visitors.value, visitors.dataThrough, visitors.lastSucceededAt],
        ['query_failed', null, null, null],
      );
      assert.equal(source(result, 'page_views').state, 'no_data');
      StatsDTOSchema.parse({ sources: result.sources });
    } finally {
      await unavailable.$disconnect();
    }
  });

  test('uses JobState for freshness and filters unauthorized sources before querying', async () => {
    assert.throws(() => selectStatsSources('EDITOR', ['mail']), { code: 'forbidden' });
    assert.deepEqual(selectStatsSources('SALES', ['visitors', 'inquiries', 'storage']), ['visitors', 'inquiries']);
    assert.deepEqual(selectStatsSources('EDITOR', ['chat_starts', 'model_starts']), ['model_starts']);
    const through = new Date('2026-03-08T05:00:00Z');
    await putDaily(march8.from, { pageViews: 1, chatStarts: 5, sourceThrough: through });
    await putState(march8.from);
    await db.jobState.create({
      data: { key: AGGREGATE_JOB_KEY, lastStatus: 'FAILED', lastFinishedAt: now, lastSucceededAt: aggregatedAt },
    });
    const result = await read(march8, { role: 'EDITOR' });
    const page = source(result, 'page_views');
    assert.deepEqual([page.state, page.dataThrough, page.lastSucceededAt],
      ['stale', through.toISOString(), aggregatedAt.toISOString()]);
    assert.equal(result.sources.some((dto) => dto.source === 'chat_starts'), false);
    assert.equal((await db.jobState.findUniqueOrThrow({ where: { key: AGGREGATE_JOB_KEY } })).lastStatus, 'FAILED');
    assert.equal(source(await read(march9), 'page_views').state, 'no_data');
  });
});
