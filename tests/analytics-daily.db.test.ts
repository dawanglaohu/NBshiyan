// M5-T12 无身份日聚合（AnalyticsDaily）在隔离 schema 的真实 PostgreSQL 验收。
//
// 门禁同 analytics-aggregate.db.test.ts：PG 回归步骤设 M5T12_REQUIRE_DATABASE=true 并注入
// DATABASE_URL；其它 job 无库时整组 skip。本地未连库的部分（迁移、13 月 GC、多实例）不在此伪装。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import { siteDayUtcBounds } from '../src/lib/analytics/day-boundaries';
import { classifyDayCompleteness } from '../src/lib/analytics/daily-aggregate';
import { runDailyAggregateRound } from '../src/lib/server/analytics/aggregate';
import { readDayState, readLiveMarkerVersions } from '../src/lib/server/analytics/aggregate-day-state';

const base = process.env.DATABASE_URL;
const SCHEMA = `daily_agg_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}&connection_limit=3&pool_timeout=10`
  : null;
if (process.env.M5T12_REQUIRE_DATABASE === 'true' && !url) {
  throw new Error('DATABASE_URL must be a postgres URL when M5T12_REQUIRE_DATABASE=true');
}
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no DATABASE_URL';

const TZ = 'Asia/Shanghai';
const REV = 2;
const TODAY = '2026-03-05';

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

function requireDb(): PrismaClient {
  if (!db) assert.fail('M5-T12 日聚合 PG 回归必须连真实 PostgreSQL：DATABASE_URL 未设置或缺库');
  return db;
}

after(async () => {
  if (!db) return;
  assert.match(SCHEMA, /^daily_agg_\d+$/);
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

describe('M5-T12 anonymous daily aggregate on real PostgreSQL', { concurrency: false, skip, timeout: 180_000 }, () => {
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
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsDaily"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsAggregateDayState"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsDayChange"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsEvent"`);
  }

  let seq = 0;
  async function insertEvent(input: {
    occurredAt: Date;
    receivedAt?: Date;
    kind: 'page_view' | 'product_view' | 'model_view_start' | 'model_load_success' | 'model_load_failure' | 'chat_start';
    browserHash?: string;
    viewId?: string | null;
    productSlug?: string | null;
    path?: string | null;
    locale?: string;
    durationMs?: number | null;
  }) {
    const conn = requireDb();
    seq += 1;
    await conn.$executeRaw`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "viewId", "durationMs", "occurredAt", "receivedAt"
      ) VALUES (
        ${`agg-ev-${process.pid}-${seq}`},
        ${`agg-sk-${process.pid}-${seq}`},
        ${'p'.repeat(64)},
        ${input.browserHash ?? `bh-${seq}`},
        ${input.kind}::"AnalyticsEventKind",
        ${input.locale ?? 'en'},
        ${input.productSlug ?? null},
        ${input.path ?? null},
        ${input.viewId ?? null},
        ${input.durationMs ?? null},
        ${utc(input.occurredAt)},
        ${utc(input.receivedAt ?? input.occurredAt)}
      )
    `;
  }

  async function dailyRows(localDate: string) {
    const conn = requireDb();
    return conn.$queryRaw<{
      dimension: string;
      visitors: number;
      pageViews: number | null;
      productViews: number;
      modelStarts: number;
      modelSuccesses: number;
      modelFailures: number;
      chatStarts: number;
      durationMsSum: bigint;
      loadDurationSamples: number;
      timezone: string;
      sourceThrough: string | null;
      expiresAt: string;
    }[]>`
      SELECT
        "dimension", "visitors", "pageViews", "productViews", "modelStarts",
        "modelSuccesses", "modelFailures", "chatStarts", "durationMsSum",
        "loadDurationSamples", "timezone",
        to_char("sourceThrough", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceThrough",
        to_char("expiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
      FROM "AnalyticsDaily"
      WHERE "localDate" = ${localDate} AND "timezoneRevision" = ${REV}
      ORDER BY "dimension"
    `;
  }

  function roundRun(overrides: Partial<Parameters<typeof runDailyAggregateRound>[0]> = {}) {
    return runDailyAggregateRound({
      db: requireDb(),
      now: new Date('2026-03-05T02:00:00.000Z'),
      siteTimezone: TZ,
      timezoneRevision: REV,
      generation: 1,
      leaseOwner: 'test-lease',
      currentDate: TODAY,
      ...overrides,
    });
  }

  test('基本日聚合：站点/产品行、BigInt 总和、sourceThrough、13 月 expiresAt', async () => {
    await reset();
    await insertEvent({ kind: 'page_view', browserHash: 'b1', path: '/en', occurredAt: new Date('2026-03-02T02:00:00Z') });
    await insertEvent({
      kind: 'product_view',
      browserHash: 'b1',
      productSlug: 'cube',
      occurredAt: new Date('2026-03-02T02:30:00Z'),
    });
    await insertEvent({
      kind: 'model_view_start',
      browserHash: 'b2',
      viewId: 'v1',
      productSlug: 'cube',
      occurredAt: new Date('2026-03-02T03:00:00Z'),
    });
    await insertEvent({
      kind: 'model_load_success',
      browserHash: 'b2',
      viewId: 'v1',
      productSlug: 'cube',
      durationMs: 1200,
      occurredAt: new Date('2026-03-02T03:00:05Z'),
    });
    await insertEvent({
      kind: 'page_view',
      browserHash: 'b3',
      path: '/en/products/cube',
      occurredAt: new Date('2026-03-02T04:00:00Z'),
    });

    const run = await roundRun({ baseDates: ['2026-03-02'] });
    assert.equal(run.status, 'ok');
    assert.deepEqual(run.committed, ['2026-03-02']);
    assert.equal(run.gaps.length, 0);

    const rows = await dailyRows('2026-03-02');
    const site = rows.find((row) => row.dimension === 'site');
    const cube = rows.find((row) => row.dimension === 'product:cube');
    assert.ok(site);
    assert.ok(cube);
    // 站点 UV 含终态自身 browserHash（b1/b2/b3 = 3）。
    assert.equal(site.visitors, 3);
    assert.equal(site.pageViews, 2);
    assert.equal(site.productViews, 1);
    assert.equal(site.modelStarts, 1);
    assert.equal(site.modelSuccesses, 1);
    assert.equal(site.modelFailures, 0);
    assert.equal(site.durationMsSum, 1200n);
    assert.equal(site.loadDurationSamples, 1);
    assert.equal(site.chatStarts, 0);
    assert.equal(site.timezone, TZ);
    assert.equal(site.sourceThrough, '2026-03-02T04:00:00.000Z');
    // 产品 UV：product_view(b1) + start(b2) + 路径命中 page_view(b3)；终态不加 UV。
    assert.equal(cube.visitors, 3);
    assert.equal(cube.pageViews, null);
    assert.equal(cube.productViews, 1);
    assert.equal(cube.modelStarts, 1);
    assert.equal(cube.modelSuccesses, 1);
    assert.equal(cube.durationMsSum, 1200n);
    // 2026-03-02 + 13 自然月 = 2027-04-02 本地日首；Asia/Shanghai = 2027-04-01T16:00Z。
    assert.equal(site.expiresAt, '2027-04-01T16:00:00.000Z');

    // 同日 second run：state 已消费 markers、无 defer/gap、无新版本 → 不再入队。
    const again = await roundRun({ baseDates: [] });
    assert.equal(again.status, 'ok');
    assert.deepEqual(again.targets, []);
    assert.deepEqual(again.committed, []);

    const bounds = siteDayUtcBounds('2026-03-02', TZ);
    const state = await readDayState(requireDb(), { localDate: '2026-03-02', timezoneRevision: REV });
    assert.ok(state);
    assert.equal(state.gapKind, null);
    assert.equal(state.deferUntil, null);
    const completeness = classifyDayCompleteness({
      siteRow: { timezone: TZ },
      state,
      bounds,
      liveVersions: await readLiveMarkerVersions(requireDb()),
    });
    assert.equal(completeness.status, 'complete');
  });

  test('冒烟路径不计入任何指标；marker 前进后重算仍保持 0 贡献', async () => {
    await reset();
    const conn = requireDb();
    await insertEvent({
      kind: 'page_view',
      browserHash: 'smoke-1',
      path: '/nbs-smoke-home',
      occurredAt: new Date('2026-03-02T02:00:00Z'),
    });
    await insertEvent({
      kind: 'page_view',
      browserHash: 'real-1',
      path: '/en',
      occurredAt: new Date('2026-03-02T02:10:00Z'),
    });
    // 冒烟 start + 终态：终态没有真实 start 可归属 → late_unattributable gap（可见而非静默丢失）。
    await insertEvent({
      kind: 'model_view_start',
      browserHash: 'smoke-2',
      viewId: 'sv1',
      productSlug: 'cube',
      path: '/en/nbs-smoke-x',
      occurredAt: new Date('2026-03-02T03:00:00Z'),
    });
    await insertEvent({
      kind: 'model_load_success',
      browserHash: 'smoke-2',
      viewId: 'sv1',
      productSlug: 'cube',
      durationMs: 500,
      occurredAt: new Date('2026-03-02T03:00:05Z'),
    });
    await conn.$executeRaw`
      INSERT INTO "AnalyticsDayChange" ("utcDate", "version", "updatedAt")
      VALUES ('2026-03-02', 1, ${utc(new Date('2026-03-02T05:00:00Z'))})
      ON CONFLICT ("utcDate") DO UPDATE SET "version" = EXCLUDED."version"
    `;

    const run = await roundRun({ baseDates: ['2026-03-02'] });
    assert.equal(run.status, 'ok');
    const rows = await dailyRows('2026-03-02');
    const site = rows.find((row) => row.dimension === 'site');
    assert.ok(site);
    // 冒烟 page_view 与冒烟 start 都不计入；终态本身仍在当日 UV 里（模型 compute_metrics 的 all_facts）。
    assert.equal(site.visitors, 2);
    assert.equal(site.pageViews, 1);
    assert.equal(site.modelStarts, 0);
    assert.equal(site.modelSuccesses, 0);
    assert.equal(site.durationMsSum, 0n);
    assert.equal(rows.some((row) => row.dimension.startsWith('product:')), false);

    const state = await readDayState(requireDb(), { localDate: '2026-03-02', timezoneRevision: REV });
    assert.equal(state?.gapKind, 'late_unattributable');
    assert.equal(state?.markerVersions['2026-03-02'], '1');
  });

  test('站点日内 receivedAt 晚于 cutoff：Q4 guard 让整组回滚，只写 clock_inversion gap', async () => {
    await reset();
    await insertEvent({ kind: 'page_view', browserHash: 'b1', path: '/en', occurredAt: new Date('2026-03-02T02:00:00Z') });
    await insertEvent({
      kind: 'page_view',
      browserHash: 'b2',
      path: '/en/about',
      occurredAt: new Date('2026-03-02T02:30:00Z'),
      receivedAt: new Date('2026-03-05T02:00:01Z'),
    });

    const run = await roundRun({ baseDates: ['2026-03-02'] });
    assert.equal(run.status, 'guard');
    assert.deepEqual(run.committed, []);
    assert.deepEqual(await dailyRows('2026-03-02'), []);
    assert.equal(run.guard?.localDate, '2026-03-02');
    assert.equal(run.gaps[0]?.gapKind, 'clock_inversion');
    assert.equal(run.gaps[0]?.write, 'written');
    const state = await readDayState(requireDb(), { localDate: '2026-03-02', timezoneRevision: REV });
    assert.equal(state?.gapKind, 'clock_inversion');
  });

  test('初始 target 集超过 maxDays：整组中止、写 budget gap、不提交任何行', async () => {
    await reset();
    await insertEvent({ kind: 'page_view', browserHash: 'b1', path: '/en', occurredAt: new Date('2026-03-01T02:00:00Z') });
    await insertEvent({ kind: 'page_view', browserHash: 'b2', path: '/en', occurredAt: new Date('2026-03-02T02:00:00Z') });

    const run = await roundRun({ baseDates: ['2026-03-01', '2026-03-02'], maxDays: 1 });
    assert.equal(run.status, 'budget');
    assert.equal(run.budget?.reason, 'max_days_initial');
    assert.deepEqual(run.committed, []);
    assert.deepEqual(await dailyRows('2026-03-01'), []);
    assert.deepEqual(await dailyRows('2026-03-02'), []);
    const state = await readDayState(requireDb(), { localDate: '2026-03-01', timezoneRevision: REV });
    assert.equal(state?.gapKind, 'budget');
  });

  test('跨日 start 闭包：终态在次日，归属仍落 start 日的产品行', async () => {
    await reset();
    // start 在 03-01 23:30 本地（15:30Z），终态在 03-02 00:10 本地（16:10Z）。
    await insertEvent({
      kind: 'model_view_start',
      browserHash: 'b1',
      viewId: 'v9',
      productSlug: 'cube',
      occurredAt: new Date('2026-03-01T15:30:00Z'),
    });
    await insertEvent({
      kind: 'model_load_failure',
      browserHash: 'b1',
      viewId: 'v9',
      productSlug: 'cube',
      durationMs: 700,
      occurredAt: new Date('2026-03-02T15:00:00Z'),
    });

    const run = await roundRun({ baseDates: ['2026-03-02'] });
    assert.equal(run.status, 'ok');
    assert.deepEqual([...run.committed].sort(), ['2026-03-01', '2026-03-02']);

    const startDay = await dailyRows('2026-03-01');
    const startSite = startDay.find((row) => row.dimension === 'site');
    const startCube = startDay.find((row) => row.dimension === 'product:cube');
    assert.equal(startSite?.modelStarts, 1);
    assert.equal(startSite?.modelFailures, 1);
    assert.equal(startSite?.durationMsSum, 700n);
    assert.equal(startCube?.modelFailures, 1);

    const terminalDay = await dailyRows('2026-03-02');
    const terminalSite = terminalDay.find((row) => row.dimension === 'site');
    // 终态本身不重复计成功/失败；当日 UV 仍含该 browserHash（模型 compute_metrics 的 all_facts）。
    assert.equal(terminalSite?.modelFailures, 0);
    const terminalState = await readDayState(requireDb(), { localDate: '2026-03-02', timezoneRevision: REV });
    assert.equal(terminalState?.gapKind, null);
  });

  test('defer：occurredAt 晚于 notAfter 的事实不提前计入；defer 到期后下一轮自动重算', async () => {
    await reset();
    const now = new Date('2026-03-03T02:00:00.000Z');
    await insertEvent({ kind: 'page_view', browserHash: 'b1', path: '/en', occurredAt: new Date('2026-03-02T09:59:00Z') });
    await insertEvent({
      kind: 'page_view',
      browserHash: 'b2',
      path: '/en/late',
      occurredAt: new Date('2026-03-02T10:03:00Z'),
      receivedAt: new Date('2026-03-02T10:00:00Z'),
    });

    // 业务时钟停在 10:00：10:03 的事实已可见（receivedAt 更早）但 occurredAt 还没到，必须并入 defer。
    const first = await roundRun({ now, baseDates: ['2026-03-02'], notAfter: new Date('2026-03-02T10:00:00Z') });
    assert.equal(first.status, 'ok');
    assert.deepEqual(first.committed, ['2026-03-02']);
    let site = (await dailyRows('2026-03-02')).find((row) => row.dimension === 'site');
    assert.equal(site?.pageViews, 1);
    let state = await readDayState(requireDb(), { localDate: '2026-03-02', timezoneRevision: REV });
    assert.equal(state?.deferUntil?.toISOString(), '2026-03-02T10:03:00.000Z');

    // 没有 base：defer 到期（cutoff >= deferUntil）就让该日重新入队，计入第二条事实并清空 defer。
    const second = await roundRun({ now, baseDates: [], notAfter: new Date('2026-03-02T10:04:00Z') });
    assert.equal(second.status, 'ok');
    assert.deepEqual(second.committed, ['2026-03-02']);
    site = (await dailyRows('2026-03-02')).find((row) => row.dimension === 'site');
    assert.equal(site?.pageViews, 2);
    state = await readDayState(requireDb(), { localDate: '2026-03-02', timezoneRevision: REV });
    assert.equal(state?.deferUntil, null);
  });
});
