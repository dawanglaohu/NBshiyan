// M5-T12 无身份日聚合（AnalyticsDaily）在隔离 schema 的真实 PostgreSQL 验收。
//
// 门禁同 analytics-aggregate.db.test.ts：PG 回归步骤设 M5T12_REQUIRE_DATABASE=true 并注入
// DATABASE_URL；其它 job 无库时整组 skip。本地未连库的部分（迁移、13 月 GC、多实例）不在此伪装。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';
import { siteDayUtcBounds } from '../src/lib/analytics/day-boundaries';
import { classifyDayCompleteness } from '../src/lib/analytics/daily-aggregate';
import { runAggregateOnce, runDailyAggregateRound } from '../src/lib/server/analytics/aggregate';
import { planSnapshot } from '../src/lib/analytics/aggregate-plan';
import { AGGREGATE_JOB_KEY } from '../src/lib/server/analytics/aggregate-repo';
import { readDayState, readLiveMarkerVersions } from '../src/lib/server/analytics/aggregate-day-state';

// 专属入口（M5-T12）：只认 M5T12_TEST_DATABASE_URL，不 fallback 通用 DATABASE_URL。
// 本机库名/角色尚未分配：非 CI 即使给了 URL 也拒绝，不靠“看起来不像保留库”推断授权。
// CI 必须三个开关同时成立：CI=true + M5T12_CI_MODE=true + M5T12_REQUIRE_DATABASE=true，
// 且 URL 只接受 loopback / database=e2e / user=postgres / 不带 schema 参数。
const REQUIRE = process.env.M5T12_REQUIRE_DATABASE === 'true';
const CI_FLAG = process.env.CI === 'true';
const CI_MODE = process.env.M5T12_CI_MODE === 'true';
/** DSN 解析与用户名解码失败一律给固定安全码，不把原始 URL 带进 TypeError/URIError。 */
function parseDsn(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error('E_M5T12_URL_UNPARSEABLE');
  }
}
function dsnUsername(parsed: URL): string {
  try {
    return decodeURIComponent(parsed.username);
  } catch {
    throw new Error('E_M5T12_URL_UNPARSEABLE');
  }
}

const base = process.env.M5T12_TEST_DATABASE_URL;
const parsedDsn = base === undefined ? null : parseDsn(base);
const schemaParam = parsedDsn === null ? null : parsedDsn.searchParams.get('schema');

if (REQUIRE && base === undefined) throw new Error('E_M5T12_URL_MISSING');
if (parsedDsn !== null) {
  if (!(CI_FLAG && CI_MODE && REQUIRE)) throw new Error('E_M5T12_LOCAL_DB_NOT_PROVISIONED');
  if (!['127.0.0.1', 'localhost'].includes(parsedDsn.hostname)) throw new Error('E_M5T12_HOST_NOT_LOOPBACK');
  if (parsedDsn.pathname.replace(/^\//, '') !== 'e2e') throw new Error('E_M5T12_DB_NOT_E2E');
  if (dsnUsername(parsedDsn) !== 'postgres') throw new Error('E_M5T12_USER_NOT_POSTGRES');
  if (schemaParam !== null) throw new Error('E_M5T12_URL_HAS_SCHEMA');
}

// 随机 owned schema：每次运行独立命名，收尾只清这一个；正则与创建时的名字严格对应。
const SCHEMA = `m5t12_daily_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
const url = parsedDsn === null
  ? null
  : (() => {
      const parsed = new URL(parsedDsn.toString());
      parsed.search = '';
      parsed.searchParams.set('schema', SCHEMA);
      parsed.searchParams.set('connection_limit', '3');
      parsed.searchParams.set('pool_timeout', '10');
      return parsed.toString();
    })();
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no M5T12_TEST_DATABASE_URL';
/** 被入口探针 spawn 的子进程：只允许模块加载，绝不再跑 PG 组或再 spawn 一层。 */
const probeChild = process.env.M5T12_ENTRY_PROBE_CHILD === '1';

const TZ = 'Asia/Shanghai';
const REV = 2;
const TODAY = '2026-03-05';

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

/** 只有本次 `CREATE SCHEMA` 真的成功才置 true；失败/碰撞不接管、不 DROP。 */
let schemaCreated = false;

function requireDb(): PrismaClient {
  if (!db) assert.fail('M5-T12 日聚合 PG 回归必须连真实 PostgreSQL：M5T12_TEST_DATABASE_URL 缺失或 CI 开关不齐');
  return db;
}

after(async () => {
  if (!db) return;
  try {
    // 只清本次 owned schema：名字必须精确匹配创建时的随机格式，否则拒绝 DROP。
    if (!schemaCreated) return;
    if (!/^m5t12_daily_\d+_[0-9a-f]{8}$/.test(SCHEMA)) throw new Error('E_M5T12_SCHEMA_NOT_OWNED');
    // 失败 loud（不吞、不 IF EXISTS 掩盖）：交给 runner 报 after-hook 失败。
    await db.$executeRawUnsafe(`DROP SCHEMA "${SCHEMA}" CASCADE`);
  } finally {
    await db.$disconnect();
  }
});

describe('M5-T12 anonymous daily aggregate on real PostgreSQL', { concurrency: false, skip: probeChild ? 'entry probe child' : skip, timeout: 180_000 }, () => {
  before(async () => {
    if (!db) return;
    const conn = requireDb();
    // 只读身份核对必须早于任何 CREATE；错误只给安全码，不回显 DSN。
    let identity: Array<{ db: string; user: string }>;
    try {
      identity = await conn.$queryRaw<{ db: string; user: string }[]>`
        SELECT current_database() AS "db", current_user AS "user"
      `;
    } catch {
      throw new Error('E_M5T12_IDENTITY_UNAVAILABLE');
    }
    if (identity[0]?.db !== 'e2e' || identity[0]?.user !== 'postgres') {
      throw new Error('E_M5T12_IDENTITY_MISMATCH');
    }
    // 普通 CREATE（不用 IF NOT EXISTS）：碰撞/失败都不接管、不 DROP。
    try {
      await conn.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    } catch {
      throw new Error('E_M5T12_SCHEMA_CREATE_FAILED');
    }
    schemaCreated = true;
    try {
      await conn.$executeRawUnsafe(`SET search_path TO "${SCHEMA}"`);
    } catch {
      throw new Error('E_M5T12_SEARCH_PATH_FAILED');
    }
    try {
      const { execFileSync } = await import('node:child_process');
      const { createRequire } = await import('node:module');
      const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
      execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: url! },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
        killSignal: 'SIGKILL',
      });
    } catch {
      // 有界失败；不打印捕获对象，避免把 DSN 带进 CI 日志。
      throw new Error('E_M5T12_DBPUSH_FAILED');
    }
  });

  async function reset() {
    const conn = requireDb();
    // 只清本 owned schema 的相关表；不动其它 schema 或其它任务数据。
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsDaily"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsAggregateDayState"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsDayChange"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsEvent"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsDailyRollup"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsRollupDay"`);
    await conn.$executeRawUnsafe(`DELETE FROM "JobState"`);
    await conn.$executeRawUnsafe(`DELETE FROM "SiteSetting"`);
  }

  /**
   * 真实守卫行：analytics-aggregate 租约 + analytics.settings 时区代次。
   * 守卫 fail-closed，缺行会 `stale_generation`/`stale_timezone_revision`，所以必须真写，
   * 不能用 always-pass 桩。
   */
  async function seedGuards(input: {
    generation: number;
    leaseOwner: string;
    revision: number;
    timezone: string;
    now: Date;
  }) {
    const conn = requireDb();
    const until = new Date(Date.now() + 60_000);
    await conn.$executeRaw`
      INSERT INTO "JobState" (
        "key", "leaseOwner", "generation", "lockedUntil", "lastStartedAt",
        "lastStatus", "lastErrorCode", "summary", "createdAt", "updatedAt"
      ) VALUES (
        ${AGGREGATE_JOB_KEY}, ${input.leaseOwner}, ${input.generation}, ${utc(until)}, ${utc(input.now)},
        ${'RUNNING'}::"JobRunStatus", NULL, NULL, ${utc(input.now)}, ${utc(input.now)}
      )
      ON CONFLICT ("key") DO UPDATE SET
        "leaseOwner" = EXCLUDED."leaseOwner",
        "generation" = EXCLUDED."generation",
        "lockedUntil" = EXCLUDED."lockedUntil",
        "lastStatus" = EXCLUDED."lastStatus",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
    await conn.$executeRaw`
      INSERT INTO "SiteSetting" ("key", "value")
      VALUES ('analytics.settings', ${JSON.stringify({
        version: 1,
        timezone: input.timezone,
        timezoneRevision: input.revision,
        changedAt: input.now.toISOString(),
        updatedBy: null,
      })}::jsonb)
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"
    `;
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
    assert.ok(run.committed !== null, '确认提交时必须有列表');
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
  test('原子回滚：两条链在同一 RR 已实际写入后，租约结算钩子失败 → 本次写全部不落库', async () => {
    await reset();
    const now = new Date('2026-03-03T02:00:00.000Z');
    const currentDate = '2026-03-03';
    const generation = 1;
    const leaseOwner = 'test-lease';
    await seedGuards({ generation, leaseOwner, revision: REV, timezone: TZ, now });
    // 旧链目标由真实 planSnapshot 决定，不手填日期。
    const plan = planSnapshot({ now, siteTimezone: TZ, currentDate });
    assert.ok(plan.siteDates.length > 0, '真实 planSnapshot 必须给出旧链站点日');
    const day = plan.siteDates[0]!;
    await insertEvent({
      kind: 'page_view',
      browserHash: 'b1',
      path: '/en',
      occurredAt: new Date(`${day}T02:00:00Z`),
    });
    // 重算窗口之外的既有结果：整组回滚不得动它。
    const outside = '2026-01-01';
    await requireDb().$executeRaw`
      INSERT INTO "AnalyticsRollupDay" ("siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt")
      VALUES (${outside}, ${REV}, ${utc(now)}, ${7}, ${utc(now)})
    `;
    await requireDb().$executeRaw`
      INSERT INTO "AnalyticsDailyRollup" ("siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers")
      VALUES (${outside}, ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${''}, ${7}, ${3})
    `;

    const failure = new Error('caller_lease_settlement_failed');
    await assert.rejects(
      () => runAggregateOnce({
        db: requireDb(),
        now,
        siteTimezone: TZ,
        timezoneRevision: REV,
        generation,
        currentDate,
        daily: { leaseOwner, baseDates: [day] },
        commit: async (tx) => {
          // 先证明两条链在**同一事务**里已真实写入，再抛错；不是空断言。
          const daily = await tx.$queryRaw<{ count: number }[]>`
            SELECT COUNT(*)::int AS "count" FROM "AnalyticsDaily" WHERE "localDate" = ${day}
          `;
          const rollup = await tx.$queryRaw<{ count: number }[]>`
            SELECT COUNT(*)::int AS "count" FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${day}
          `;
          const watermark = await tx.$queryRaw<{ count: number }[]>`
            SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day}
          `;
          assert.ok(Number(daily[0]?.count ?? 0) > 0, '新链 AnalyticsDaily 必须已在本轮事务里写入');
          assert.ok(Number(rollup[0]?.count ?? 0) > 0, '旧链 AnalyticsDailyRollup 必须已在本轮事务里写入');
          assert.ok(Number(watermark[0]?.count ?? 0) > 0, '旧链水位 AnalyticsRollupDay 必须已在本轮事务里写入');
          throw failure;
        },
      }),
      (error: unknown) => {
        // 回调内失败＝确认回滚：原错误上抛，不包装成未知提交。
        assert.equal(error, failure);
        return true;
      },
    );

    // 两条链本次写的都必须随整组回滚，逐实际 plan 日期检查。
    for (const localDate of plan.siteDates) {
      assert.deepEqual(await dailyRows(localDate), [], `新链 ${localDate} 不得残留`);
      const rollup = await requireDb().$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS "count" FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${localDate}
      `;
      assert.equal(Number(rollup[0]?.count ?? 0), 0, `旧链 rollup ${localDate} 不得残留`);
      const watermark = await requireDb().$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${localDate}
      `;
      assert.equal(Number(watermark[0]?.count ?? 0), 0, `旧链水位 ${localDate} 不得残留`);
    }
    const state = await readDayState(requireDb(), { localDate: day, timezoneRevision: REV });
    assert.equal(state, null, '主 RR 本次创建的 DayState 必须跟随回滚');

    // 窗口外的既有结果必须原样保留。
    const keptRollup = await requireDb().$queryRaw<{ count: number }[]>`
      SELECT "count" FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${outside}
    `;
    assert.equal(Number(keptRollup[0]?.count ?? 0), 7, '既有旧链 rollup 不得被回滚波及');
    const keptWatermark = await requireDb().$queryRaw<{ eventCount: number }[]>`
      SELECT "eventCount" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${outside}
    `;
    assert.equal(Number(keptWatermark[0]?.eventCount ?? 0), 7, '既有旧链水位不得被回滚波及');
  });

  test('closure 独立覆盖：闭包日不可重算时整笔回滚，只留独立 CAS 的 coverage 元数据', async () => {
    await reset();
    await seedGuards({ generation: 1, leaseOwner: 'test-lease', revision: REV, timezone: TZ, now: new Date('2026-03-05T02:00:00.000Z') });
    // start 在 2026-02-01，终态在次日；闭包日早于本轮可重算下限，闭包才发现不可重算。
    await insertEvent({
      kind: 'model_view_start',
      browserHash: 'b1',
      viewId: 'v-closure',
      productSlug: 'cube',
      occurredAt: new Date('2026-02-01T02:00:00Z'),
    });
    await insertEvent({
      kind: 'model_load_failure',
      browserHash: 'b1',
      viewId: 'v-closure',
      productSlug: 'cube',
      durationMs: 500,
      occurredAt: new Date('2026-02-02T02:00:00Z'),
    });

    const run = await roundRun({ baseDates: ['2026-02-01'] });
    // 闭包日不可重算：主 RR 整笔回滚，用本次 plan 的原 expected 在独立 CAS 事务补 coverage。
    assert.equal(run.status, 'partial');
    assert.ok(run.committed !== null, '回滚也要如实给出确认提交列表');
    assert.deepEqual(run.committed, []);
    assert.deepEqual(await dailyRows('2026-02-01'), [], '主事务已回滚，指标行不得残留');
    assert.deepEqual(await dailyRows('2026-02-02'), []);
    // 独立 CAS 写的是 coverage 元数据，而不是指标。
    const closureState = await readDayState(requireDb(), { localDate: '2026-02-02', timezoneRevision: REV });
    assert.ok(closureState !== null, '闭包日的 coverage 元数据必须存在');
    assert.equal(closureState?.gapKind, null, '不是 gap：这是 coverage 覆盖说明');
    assert.ok(
      run.metadata.some((item) => item.localDate === '2026-02-02'),
      '本轮必须带出独立 CAS 写入的 coverage 结果',
    );
  });
});
// ---- 专属 DB 入口拒绝负控：spawn 真实入口文件，断言安全码、非 0 退出、不回显 DSN ----
// 子进程只拿白名单 env（父进程的 DATABASE_URL/M5T12_* 不继承），并带探针标记防止再 spawn。
const ENTRY_PROBE_ENV = 'M5T12_ENTRY_PROBE_CHILD';
const ENTRY_FILES = ['tests/analytics-daily.db.test.ts', 'tests/analytics-aggregate.db.test.ts'];
const CHILD_ENV_KEEP = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TERM',
];

const DUMMY_DSN = 'postgresql://postgres:password@localhost:5432/e2e';
const GOOD_SWITCHES = { CI: 'true', M5T12_CI_MODE: 'true', M5T12_REQUIRE_DATABASE: 'true' };
const MALFORMED_DSN = 'not-a-url-marker';

const ENTRY_CASES: Array<{ name: string; env: Record<string, string | undefined>; code: string }> = [
  { name: '缺专属 URL', env: { M5T12_REQUIRE_DATABASE: 'true' }, code: 'E_M5T12_URL_MISSING' },
  { name: '非 CI 给了 URL', env: { M5T12_TEST_DATABASE_URL: DUMMY_DSN }, code: 'E_M5T12_LOCAL_DB_NOT_PROVISIONED' },
  {
    name: '缺 M5T12_CI_MODE',
    env: { CI: 'true', M5T12_REQUIRE_DATABASE: 'true', M5T12_TEST_DATABASE_URL: DUMMY_DSN },
    code: 'E_M5T12_LOCAL_DB_NOT_PROVISIONED',
  },
  {
    name: '缺 REQUIRE 开关',
    env: { CI: 'true', M5T12_CI_MODE: 'true', M5T12_TEST_DATABASE_URL: DUMMY_DSN },
    code: 'E_M5T12_LOCAL_DB_NOT_PROVISIONED',
  },
  {
    name: '非回环 host',
    env: { ...GOOD_SWITCHES, M5T12_TEST_DATABASE_URL: 'postgresql://postgres:password@db.example.com:5432/e2e' },
    code: 'E_M5T12_HOST_NOT_LOOPBACK',
  },
  {
    name: '库名不是 e2e',
    env: { ...GOOD_SWITCHES, M5T12_TEST_DATABASE_URL: 'postgresql://postgres:password@localhost:5432/analytics' },
    code: 'E_M5T12_DB_NOT_E2E',
  },
  {
    name: '用户不是 postgres',
    env: { ...GOOD_SWITCHES, M5T12_TEST_DATABASE_URL: 'postgresql://someone:postgres@localhost:5432/e2e' },
    code: 'E_M5T12_USER_NOT_POSTGRES',
  },
  {
    name: 'URL 带 schema 参数',
    env: { ...GOOD_SWITCHES, M5T12_TEST_DATABASE_URL: `${DUMMY_DSN}?schema=public` },
    code: 'E_M5T12_URL_HAS_SCHEMA',
  },
  { name: '畸形 DSN', env: { ...GOOD_SWITCHES, M5T12_TEST_DATABASE_URL: MALFORMED_DSN }, code: 'E_M5T12_URL_UNPARSEABLE' },
  {
    name: '用户名字符非法',
    env: { ...GOOD_SWITCHES, M5T12_TEST_DATABASE_URL: 'postgresql://%E0%A4%A:x@localhost:5432/e2e' },
    code: 'E_M5T12_URL_UNPARSEABLE',
  },
];

type EntryRun = { code: number | null; signal: NodeJS.Signals | null; out: string; timedOut: boolean };

function entryChildEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const key of CHILD_ENV_KEEP) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env[ENTRY_PROBE_ENV] = '1';
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function spawnEntry(file: string, extra: Record<string, string | undefined>): Promise<EntryRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', file], {
      cwd: process.cwd(),
      env: entryChildEnv(extra),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 90_000);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, out, timedOut });
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { out += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { out += chunk; });
    child.on('close', finish);
    child.on('error', (error) => {
      out += String(error);
      finish(null, null);
    });
  });
}

/** 有界并发：每个用例一个子进程，最多 4 个同时跑。 */
async function runEntryCases(file: string): Promise<Map<string, EntryRun>> {
  const runs = new Map<string, EntryRun>();
  const queue = [...ENTRY_CASES];
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      runs.set(next.name, await spawnEntry(file, next.env));
    }
  });
  await Promise.all(workers);
  return runs;
}

for (const entryFile of ENTRY_FILES) {
  test(`专属 DB 入口拒绝：${entryFile}`, {
    skip: probeChild ? 'entry probe child' : false,
    timeout: 300_000,
  }, async () => {
    const runs = await runEntryCases(entryFile);
    for (const entryCase of ENTRY_CASES) {
      const run = runs.get(entryCase.name);
      assert.ok(run, `${entryCase.name}: 未执行`);
      assert.equal(run.timedOut, false, `${entryCase.name}: 子进程超时`);
      assert.notEqual(run.code, 0, `${entryCase.name}: 应拒绝并非 0 退出\n${run.out.slice(-1500)}`);
      assert.match(run.out, new RegExp(entryCase.code), `${entryCase.name}: 缺少安全码 ${entryCase.code}\n${run.out.slice(-1500)}`);
      // 拒绝必须发生在任何连接/迁移之前。
      assert.equal(run.out.includes('E_M5T12_DBPUSH_FAILED'), false, `${entryCase.name}: 进了 dbpush`);
      for (const marker of ['postgresql://', 'postgres:postgres', 'db.example.com', MALFORMED_DSN]) {
        assert.equal(run.out.includes(marker), false, `${entryCase.name}: 输出回显了 ${marker}`);
      }
    }
  });
}

test('专属 DB 入口：没有任何 M5T12 变量时整组 skip 且退出 0', {
  skip: probeChild ? 'entry probe child' : false,
  timeout: 180_000,
}, async () => {
  const run = await spawnEntry('tests/analytics-daily.db.test.ts', {});
  assert.equal(run.timedOut, false);
  assert.equal(run.code, 0, `应整组 skip 并退出 0\n${run.out.slice(-2000)}`);
  assert.match(run.out, /# fail 0/);
  assert.equal(run.out.includes('E_M5T12_'), false, '无库跳过时不应报入口错误码');
});
