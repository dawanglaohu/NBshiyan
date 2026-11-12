// M5-T12 无身份日聚合（AnalyticsDaily）在隔离 schema 的真实 PostgreSQL 验收。
//
// 门禁同 analytics-aggregate.db.test.ts：PG 回归步骤设 M5T12_REQUIRE_DATABASE=true 并注入
// DATABASE_URL；其它 job 无库时整组 skip。本地未连库的部分（迁移、13 月 GC、多实例）不在此伪装。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';
import { siteDayUtcBounds, siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { classifyDayCompleteness } from '../src/lib/analytics/daily-aggregate';
import { AggregateVersionConflict, DailyRoundHalt, runAggregateOnce, runDailyAggregateRound, writeDailyCoverageMetadata } from '../src/lib/server/analytics/aggregate';
import { isDateRecomputable, planSnapshot, shiftLocalDate } from '../src/lib/analytics/aggregate-plan';
import { AGGREGATE_JOB_KEY } from '../src/lib/server/analytics/aggregate-repo';
import { readDayState, readLiveMarkerVersions } from '../src/lib/server/analytics/aggregate-day-state';
import { runAnalyticsRetention } from '../src/lib/server/analytics/retention';
import { rollupExpiryCutoff } from '../src/lib/server/analytics/retention-plan';

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

  /**
   * `updatedAt` 必须是可解析的真实时间：行缺失、字段缺失、非法时间一律显式失败。
   * 不用可选链比较——两边都是 undefined 时会假相等。
   */
  function updatedAtMs(row: { updatedAt: Date | string } | null, label: string): number {
    assert.ok(row !== null, `${label}：必须读到这一行`);
    const raw = row.updatedAt;
    assert.ok(raw !== null && raw !== undefined, `${label}：updatedAt 必须存在`);
    // Prisma 把这一列反序列化成 Date；raw SQL 路径可能是字符串，两种都按瞬时比。
    const ms = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
    assert.ok(Number.isFinite(ms), `${label}：updatedAt 必须是有效时间`);
    return ms;
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

  /**
   * 真实入口的共用入口：守卫 fail-closed，所以按**本用例自己的**
   * now/TZ/revision/generation/owner 先写真实租约与时区设置行，再跑一轮。
   * 负控需要坏前提时直接调 runDailyAggregateRound，不要走这里。
   */
  async function roundRun(overrides: Partial<Parameters<typeof runDailyAggregateRound>[0]> = {}) {
    const args = {
      db: requireDb(),
      now: new Date('2026-03-05T02:00:00.000Z'),
      siteTimezone: TZ,
      timezoneRevision: REV,
      generation: 1,
      leaseOwner: 'test-lease',
      currentDate: TODAY,
      ...overrides,
    };
    await seedGuards({
      generation: args.generation,
      leaseOwner: args.leaseOwner,
      revision: args.timezoneRevision,
      timezone: args.siteTimezone,
      now: args.now,
    });
    return runDailyAggregateRound(args);
  }

  test('基本日聚合：站点/产品行、BigInt 总和、sourceThrough、13 月 expiresAt', async () => {
    await reset();
    await insertEvent({ kind: 'page_view', browserHash: 'b1', path: '/en', occurredAt: new Date('2026-03-02T02:00:00Z') });
    // 路径归属走真实 defaultProductSlugFromPath：段必须是 CATALOG_CATEGORY_KEYS 内已上架 key，
    // 所以这里用 'color-boxes'，而不是任意 slug（未上架 slug 归不到产品，属产品语义）。
    await insertEvent({
      kind: 'product_view',
      browserHash: 'b1',
      productSlug: 'color-boxes',
      occurredAt: new Date('2026-03-02T02:30:00Z'),
    });
    await insertEvent({
      kind: 'model_view_start',
      browserHash: 'b2',
      viewId: 'v1',
      productSlug: 'color-boxes',
      occurredAt: new Date('2026-03-02T03:00:00Z'),
    });
    await insertEvent({
      kind: 'model_load_success',
      browserHash: 'b2',
      viewId: 'v1',
      productSlug: 'color-boxes',
      durationMs: 1200,
      occurredAt: new Date('2026-03-02T03:00:05Z'),
    });
    await insertEvent({
      kind: 'page_view',
      browserHash: 'b3',
      path: '/en/products/color-boxes',
      occurredAt: new Date('2026-03-02T04:00:00Z'),
    });

    const run = await roundRun({ baseDates: ['2026-03-02'] });
    assert.equal(run.status, 'ok');
    assert.deepEqual(run.committed, ['2026-03-02']);
    assert.equal(run.gaps.length, 0);

    const rows = await dailyRows('2026-03-02');
    const site = rows.find((row) => row.dimension === 'site');
    const productRow = rows.find((row) => row.dimension === 'product:color-boxes');
    assert.ok(site);
    assert.ok(productRow);
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
    assert.equal(productRow.visitors, 3);
    assert.equal(productRow.pageViews, null);
    assert.equal(productRow.productViews, 1);
    assert.equal(productRow.modelStarts, 1);
    assert.equal(productRow.modelSuccesses, 1);
    assert.equal(productRow.durationMsSum, 1200n);
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
    // `createdAt`/`updatedAt` 没有数据库默认值（@updatedAt 在客户端侧），必须显式给。
    await requireDb().$executeRaw`
      INSERT INTO "AnalyticsRollupDay" (
        "siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt"
      ) VALUES (
        ${outside}, ${REV}, ${utc(now)}, ${7}, ${utc(now)}, ${utc(now)}, ${utc(now)}
      )
    `;
    await requireDb().$executeRaw`
      INSERT INTO "AnalyticsDailyRollup" (
        "siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers", "createdAt", "updatedAt"
      ) VALUES (
        ${outside}, ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${''}, ${7}, ${3}, ${utc(now)}, ${utc(now)}
      )
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
    // 可重算的终态日落 02-04；它的闭包是 start 所在的 02-03（该日首 02-02T16:00Z 早于
    // raw 下限 02-03T02:00Z，闭包时才发现不可整日重算）。start 必须**可见**：occurredAt
    // 落在 02-03 站点日，receivedAt 显式放在 rawCutoff(02-03T02:00Z) 之后，否则
    // findEarliestStart 过滤不到它，闭包为空、根本走不到 coverage halt。
    await insertEvent({
      kind: 'model_view_start',
      browserHash: 'b1',
      viewId: 'v-closure',
      productSlug: 'cube',
      occurredAt: new Date('2026-02-03T01:00:00Z'),
      receivedAt: new Date('2026-02-03T03:00:00Z'),
    });
    await insertEvent({
      kind: 'model_load_failure',
      browserHash: 'b1',
      viewId: 'v-closure',
      productSlug: 'cube',
      durationMs: 500,
      occurredAt: new Date('2026-02-04T02:00:00Z'),
    });

    const run = await roundRun({ baseDates: ['2026-02-04'] });
    // 闭包日不可重算：主 RR 整笔回滚，用本次 plan 的原 expected 在独立 CAS 事务补 coverage。
    assert.equal(run.status, 'partial');
    assert.ok(run.committed !== null, '回滚也要如实给出确认提交列表');
    assert.deepEqual(run.committed, []);
    assert.deepEqual(await dailyRows('2026-02-04'), [], '主事务已回滚，指标行不得残留');
    assert.deepEqual(run.gaps, [], 'coverage 不是 gap：不得写 gap 记录');
    // 独立 CAS 写的是 start 日的 coverage 元数据（gapKind=raw_partial），不是指标。
    const closureState = await readDayState(requireDb(), { localDate: '2026-02-03', timezoneRevision: REV });
    assert.ok(closureState !== null, 'start 日的 coverage 元数据必须存在');
    assert.equal(closureState?.gapKind, 'raw_partial', 'coverage 写的是 raw_partial，不是 null');
    assert.ok(
      run.metadata.some((item) => item.localDate === '2026-02-03' && item.action === 'coverage'),
      '本轮必须带出独立 CAS 写入的 coverage 结果（start 日）',
    );
  });

  test('closure 独立元数据 CAS：另一路已保存成功态 → 旧 expected 命中 0 行且不覆写', async () => {
    await reset();
    const now = new Date('2026-03-05T02:00:00.000Z');
    const generation = 1;
    const leaseOwner = 'test-lease';
    const day = '2026-03-02';
    await seedGuards({ generation, leaseOwner, revision: REV, timezone: TZ, now });
    await insertEvent({ kind: 'page_view', browserHash: 'b1', path: '/en', occurredAt: new Date('2026-03-02T02:00:00Z') });
    // 另一路用真实一轮写出成功态（gapKind=null、markers=当时的 live 版本）并提交。
    const round = await roundRun({ now, currentDate: '2026-03-05', baseDates: [day] });
    assert.equal(round.status, 'ok');
    const before = await readDayState(requireDb(), { localDate: day, timezoneRevision: REV });
    assert.ok(before !== null, '真实一轮必须留下 DayState');
    assert.equal(before?.gapKind, null);

    // A 侧仍拿**先前**的 expected（读时还没有这一行）：CAS 必然 0 行。
    const writes = await writeDailyCoverageMetadata(requireDb(), {
      entries: [{ date: day, expected: { markers: {}, updatedAt: null, deferUntil: null } }],
      timezone: TZ,
      revision: REV,
      now,
      cutoff: now,
      notAfter: now,
      generation,
      leaseOwner,
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.result, 'conflict_noop', '已保存成功态应归为 no-op，而不是覆盖或报错');
    const after = await readDayState(requireDb(), { localDate: day, timezoneRevision: REV });
    assert.equal(after?.gapKind, null, '已保存的结果不得被旧 expected 覆写成 raw_partial');
    assert.equal(updatedAtMs(after, 'after'), updatedAtMs(before, 'before'), '行未被写入，updatedAt 必须保持（按瞬时比，不比 Date 引用）');
  });

  test('closure 独立元数据 CAS：raw_partial 是终态 → 旧 expected 得 no-op、原行不覆写', async () => {
    await reset();
    const now = new Date('2026-03-05T02:00:00.000Z');
    const generation = 1;
    const leaseOwner = 'test-lease';
    const day = '2026-03-02';
    await seedGuards({ generation, leaseOwner, revision: REV, timezone: TZ, now });
    const stale = { markers: {}, updatedAt: null, deferUntil: null };
    // 第一次：插入 raw_partial（真实独立 CAS 写）。
    const first = await writeDailyCoverageMetadata(requireDb(), {
      entries: [{ date: day, expected: stale }],
      timezone: TZ, revision: REV, now, cutoff: now, notAfter: now, generation, leaseOwner,
    });
    assert.equal(first[0]?.result, 'inserted');
    const before = await readDayState(requireDb(), { localDate: day, timezoneRevision: REV });
    // raw_partial 属 TERMINAL_GAPS：现存这种行就是已保存态，旧 expected CAS 0 行后归 no-op。
    const second = await writeDailyCoverageMetadata(requireDb(), {
      entries: [{ date: day, expected: stale }],
      timezone: TZ, revision: REV, now, cutoff: now, notAfter: now, generation, leaseOwner,
    });
    assert.equal(second[0]?.result, 'conflict_noop', '终态缺口应归 no-op，不得报完成也不得覆写');
    const row = await readDayState(requireDb(), { localDate: day, timezoneRevision: REV });
    assert.equal(row?.gapKind, 'raw_partial', '原行必须保持，不被旧 expected 重写');
    assert.equal(updatedAtMs(row, 'row'), updatedAtMs(before, 'before'), 'no-op 不写行，updatedAt 不变（按瞬时比）');
  });

  test('closure 独立元数据 CAS：非终态 budget 缺口 → 版本冲突、不宣完成', async () => {
    await reset();
    const now = new Date('2026-03-05T02:00:00.000Z');
    const generation = 1;
    const leaseOwner = 'test-lease';
    await seedGuards({ generation, leaseOwner, revision: REV, timezone: TZ, now });
    // 真实路径造一条非终态缺口：两日候选但 maxDays=1 → budget halt，wrapper 写 budget gap。
    await insertEvent({ kind: 'page_view', browserHash: 'b1', path: '/en', occurredAt: new Date('2026-03-01T02:00:00Z') });
    await insertEvent({ kind: 'page_view', browserHash: 'b2', path: '/en', occurredAt: new Date('2026-03-02T02:00:00Z') });
    const halted = await roundRun({ baseDates: ['2026-03-01', '2026-03-02'], maxDays: 1 });
    assert.equal(halted.status, 'budget');
    const gapDate = halted.gaps[0]?.localDate;
    assert.ok(gapDate, 'budget halt 必须留下 gap 日期');
    const before = await readDayState(requireDb(), { localDate: gapDate, timezoneRevision: REV });
    assert.equal(before?.gapKind, 'budget', '前提：现存行是非终态 budget 缺口');

    // 旧 expected（读时无行）再发独立 CAS：0 行后按 saved 判定 → 非终态 → 版本冲突。
    await assert.rejects(
      () => writeDailyCoverageMetadata(requireDb(), {
        entries: [{ date: gapDate, expected: { markers: {}, updatedAt: null, deferUntil: null } }],
        timezone: TZ, revision: REV, now, cutoff: now, notAfter: now, generation, leaseOwner,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateVersionConflict, '非终态缺口不得被当成已保存完成');
        return true;
      },
    );
    const row = await readDayState(requireDb(), { localDate: gapDate, timezoneRevision: REV });
    assert.equal(row?.gapKind, 'budget', '原行必须保持');
    assert.equal(updatedAtMs(row, 'row'), updatedAtMs(before, 'before'), '冲突路径不写行（按瞬时比）');
  });

  test('union≤maxDays：旧链 plan 集合与新链目标按 distinct 并集计，超出 1 才命中 max_days_initial', async () => {
    await reset();
    const now = new Date('2026-03-05T02:00:00.000Z');
    const currentDate = '2026-03-05';
    const generation = 1;
    const leaseOwner = 'test-lease';
    await seedGuards({ generation, leaseOwner, revision: REV, timezone: TZ, now });
    const plan = planSnapshot({ now, siteTimezone: TZ, currentDate });
    const reserved = [...plan.siteDates];
    assert.ok(reserved.length >= 2, '需要至少两个旧链站点日才能做出有区分度的并集对照');
    const limit = reserved.length;
    for (const day of reserved) {
      await insertEvent({ kind: 'page_view', browserHash: `b-${day}`, path: '/en', occurredAt: new Date(`${day}T02:00:00Z`) });
    }
    // 重叠对照：新链只用旧链已占用的日，distinct 并集仍 = limit。
    const overlap = await runAggregateOnce({
      db: requireDb(), now, siteTimezone: TZ, timezoneRevision: REV, generation, currentDate,
      daily: { leaseOwner, baseDates: [reserved[0]!], maxDays: limit },
    });
    assert.notEqual(overlap.daily?.status, 'budget', '并集等于上限时不得触发 max_days_initial');

    // 超限对照：再加一个旧链计划外、但**真正可重算**的已结束日 → 并集 = limit + 1。
    // earliestRecomputableDate 是 ISO 瞬时，不是 YYYY-MM-DD：必须先映射成站点本地日再 +1；
    // 直接用该本地日也可能早于 raw 下限（归 coverage 不进 targets），所以再断言可重算。
    const earliestLocalDate = siteLocalDate(new Date(plan.earliestRecomputableDate), TZ);
    const outside = shiftLocalDate(earliestLocalDate, 1);
    assert.equal(isDateRecomputable(outside, TZ, plan.earliestRecomputableDate), true, '超限日必须真正可重算');
    assert.ok(!reserved.includes(outside), '超限日必须落在旧链计划之外');
    assert.ok(outside >= earliestLocalDate && outside < currentDate, '超限日必须在可重算域内且已结束');
    await insertEvent({ kind: 'page_view', browserHash: 'b-extra', path: '/en', occurredAt: new Date(`${outside}T02:00:00Z`) });
    // runAggregateOnce 这条路径上，超限是包装器内的 DailyRoundHalt → 被原样抛出，不返回 daily.budget。
    await assert.rejects(
      () => runAggregateOnce({
        db: requireDb(), now, siteTimezone: TZ, timezoneRevision: REV, generation, currentDate,
        daily: { leaseOwner, baseDates: [reserved[0]!, outside], maxDays: limit },
      }),
      (error: unknown) => {
        assert.ok(error instanceof DailyRoundHalt, '超限必须以 DailyRoundHalt 抛出');
        assert.equal(error.halt.kind, 'budget');
        assert.equal(error.halt.reason, 'max_days_initial');
        assert.equal(error.halt.queued, limit + 1, 'queued 必须是 distinct 并集大小');
        return true;
      },
    );
  });

  // ---- B2：真实 PostgreSQL 上的保留额度（四表 20k / Daily 1k / metadata 独立 500×2 / 扫描窗 2k） ----
  // 全部走生产 `runAnalyticsRetention` 的真实删除链：真租约、真 settings revision、真 DELETE。
  // 额度只看 report 与库内实际行数，不用纯函数预算或复制算法替代。

  /** 固定业务时钟：事件 30 天、汇总 13 个月、marker 13 个月+2 天都由它推出，夹具日期可复算。 */
  const B2_NOW = new Date('2026-03-15T04:00:00.000Z');
  const B2_ROLLUP_THROUGH = rollupExpiryCutoff(B2_NOW, TZ);

  /** 真实 settings 行：领取租约与写前时区守卫都读它；缺行/代次不符会 fail-closed。 */
  async function seedRetentionSettings(): Promise<void> {
    const conn = requireDb();
    await conn.$executeRaw`
      INSERT INTO "SiteSetting" ("key", "value")
      VALUES ('analytics.settings', ${JSON.stringify({
        version: 1,
        timezone: TZ,
        timezoneRevision: REV,
        changedAt: B2_NOW.toISOString(),
        updatedBy: null,
      })}::jsonb)
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"
    `;
  }

  /** 30 天规则下已到期的事件：一条有界 INSERT…SELECT，不逐行往返。 */
  async function insertExpiredEvents(count: number): Promise<void> {
    const conn = requireDb();
    const receivedAt = new Date('2024-01-01T02:00:00.000Z');
    await conn.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale", "occurredAt", "receivedAt"
      )
      SELECT
        'b2-ev-' || g::text,
        'b2-sk-' || g::text,
        ${'p'.repeat(64)},
        'b2-bh-' || g::text,
        'page_view'::"AnalyticsEventKind",
        'en',
        ${utc(receivedAt)},
        ${utc(receivedAt)}
      FROM generate_series(1, ${count}::int) AS g
    `);
  }

  /** 13 个月规则下已到期的旧链日汇总：190 天 × 100 个 product key，主键天然唯一。 */
  async function insertExpiredRollupDaily(count: number): Promise<void> {
    const conn = requireDb();
    await conn.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsDailyRollup" (
        "siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers", "updatedAt"
      )
      SELECT
        to_char(DATE '2024-01-01' + (g / 100)::int, 'YYYY-MM-DD'),
        'page_view'::"AnalyticsEventKind",
        'en',
        'p' || lpad((g % 100)::text, 3, '0'),
        1,
        1,
        ${utc(B2_NOW)}
      FROM generate_series(0, ${count - 1}::int) AS g
    `);
  }

  /** `expiresAt <= now` 的新链日指标行：dimension 唯一，删除只按到期时刻选。 */
  async function insertExpiredDailyRows(count: number): Promise<void> {
    const conn = requireDb();
    await conn.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsDaily" (
        "localDate", "timezoneRevision", "timezone", "dimension",
        "visitors", "pageViews", "productViews", "modelStarts", "modelSuccesses",
        "modelFailures", "chatStarts", "durationMsSum", "loadDurationSamples",
        "sourceThrough", "aggregatedAt", "expiresAt"
      )
      SELECT
        '2024-06-01', ${REV}, ${TZ},
        'b2-d-' || lpad(g::text, 5, '0'),
        1, 1, 0, 0, 0, 0, 0, 0::bigint, 0,
        NULL, ${utc(B2_NOW)}, ${utc(new Date('2025-06-01T00:00:00.000Z'))}
      FROM generate_series(0, ${count - 1}::int) AS g
    `);
  }

  /** 行内时区正推 13 个月后已到期的 day-state：localDate 全部 < 今日−13 月预筛下界。 */
  async function insertExpiredDayStates(count: number): Promise<void> {
    const conn = requireDb();
    await conn.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsAggregateDayState" (
        "localDate", "timezoneRevision", "timezone", "markerVersions",
        "deferUntil", "gapKind", "gapSince", "updatedAt"
      )
      SELECT
        to_char(DATE '2025-02-14' - g::int, 'YYYY-MM-DD'),
        ${REV}, ${TZ}, '{}'::jsonb, NULL, NULL, NULL, ${utc(B2_NOW)}
      FROM generate_series(0, ${count - 1}::int) AS g
    `);
  }

  /** UTC 日严格早于「今日−13 月−2 天」的 marker：2022–2023 的日期与上面 state 不重叠。 */
  async function insertExpiredDayChanges(count: number): Promise<void> {
    const conn = requireDb();
    await conn.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsDayChange" ("utcDate", "version", "updatedAt")
      SELECT to_char(DATE '2023-11-30' - g::int, 'YYYY-MM-DD'), 0::bigint, ${utc(B2_NOW)}
      FROM generate_series(0, ${count - 1}::int) AS g
    `);
  }

  type CountedTable =
    | 'AnalyticsEvent'
    | 'AnalyticsDaily'
    | 'AnalyticsAggregateDayState'
    | 'AnalyticsDayChange'
    | 'AnalyticsRollupDay'
    | 'AnalyticsDailyRollup';

  async function countRows(table: CountedTable): Promise<number> {
    const rows = await requireDb().$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*)::int AS "count" FROM "${table}"`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** 删后近期聚合会给当前窗口补写 0 事件水位；旧链额度只看本轮到期域内（siteDate <= 截止）。 */
  async function countExpiredRollupRows(table: 'AnalyticsRollupDay' | 'AnalyticsDailyRollup'): Promise<number> {
    const rows = await requireDb().$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*)::int AS "count" FROM "${table}" WHERE "siteDate" <= $1`,
      B2_ROLLUP_THROUGH,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** 生产默认 batchSize/额度直接跑：不注入替身，不缩小批量来绕过真实上限。 */
  function runRetention() {
    return runAnalyticsRetention({
      db: requireDb(),
      context: {
        now: B2_NOW,
        deadlineAt: new Date(Date.now() + 55_000),
        signal: new AbortController().signal,
        dryRun: false,
      },
      clock: () => B2_NOW,
      deleteAuthorized: true,
    });
  }

  test('B2 四表共用 20k：旧链 19,000 先删，Daily 只剩 1,000 额度', async () => {
    await reset();
    await seedRetentionSettings();
    await insertExpiredRollupDaily(19_000);
    await insertExpiredDailyRows(5_000);

    const run = await runRetention();
    if (run.kind !== 'completed') assert.fail(`保留清理必须写终态，实际 ${run.kind}`);
    const report = run.report;
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(report.mode, 'delete');
    assert.equal(report.deletedEvents, 0);
    assert.equal(report.deletedRollupDays, 0);
    assert.equal(report.candidates.rollupDailyRows, 19_000);
    assert.equal(report.candidates.daily, 5_000);
    assert.equal(report.deletedRollupDailyRows, 19_000);
    assert.equal(report.deletedDailyRows, 1_000);
    assert.equal(report.deletedRollupDailyRows + report.deletedDailyRows, 20_000);
    assert.equal(await countExpiredRollupRows('AnalyticsDailyRollup'), 0);
    assert.equal(await countRows('AnalyticsDaily'), 4_000, 'Daily 只再让 1,000 行到期删除');
  });

  test('B2 四表共用 20k：旧链 25,000 已占满，Daily 一行不删', async () => {
    await reset();
    await seedRetentionSettings();
    await insertExpiredRollupDaily(25_000);
    await insertExpiredDailyRows(5_000);

    const run = await runRetention();
    if (run.kind !== 'completed') assert.fail(`保留清理必须写终态，实际 ${run.kind}`);
    const report = run.report;
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(report.deletedRollupDailyRows, 20_000);
    assert.equal(report.deletedDailyRows, 0);
    assert.equal(report.candidates.daily, 5_000, '候选仍到期；额度满不等于没有候选');
    assert.equal(report.deletedRollupDailyRows + report.deletedDailyRows, 20_000);
    assert.equal(await countExpiredRollupRows('AnalyticsDailyRollup'), 5_000);
    assert.equal(await countRows('AnalyticsDaily'), 5_000);
  });

  test('B2 四表共用 20k：事件 5,000 先删，旧链只剩 15,000，Daily 0', async () => {
    await reset();
    await seedRetentionSettings();
    await insertExpiredEvents(5_000);
    await insertExpiredRollupDaily(15_000);
    await insertExpiredDailyRows(5_000);

    const run = await runRetention();
    if (run.kind !== 'completed') assert.fail(`保留清理必须写终态，实际 ${run.kind}`);
    const report = run.report;
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(report.candidates.events, 5_000);
    assert.equal(report.deletedEvents, 5_000);
    assert.equal(report.deletedRollupDailyRows, 15_000);
    assert.equal(report.deletedDailyRows, 0);
    assert.equal(report.deletedEvents + report.deletedRollupDailyRows + report.deletedDailyRows, 20_000);
    assert.equal(await countRows('AnalyticsEvent'), 0);
    assert.equal(await countExpiredRollupRows('AnalyticsDailyRollup'), 0);
    assert.equal(await countRows('AnalyticsDaily'), 5_000);
  });

  test('B2 metadata 独立额度：state/marker 各 500、合计 1,000，不动四表', async () => {
    await reset();
    await seedRetentionSettings();
    await insertExpiredDayStates(600);
    await insertExpiredDayChanges(600);

    const run = await runRetention();
    if (run.kind !== 'completed') assert.fail(`保留清理必须写终态，实际 ${run.kind}`);
    const report = run.report;
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(report.candidates.dayState, 600);
    assert.equal(report.candidates.dayChange, 600);
    assert.equal(report.deletedDayStates, 500);
    assert.equal(report.deletedDayChanges, 500);
    assert.equal(report.deletedEvents + report.deletedRollupDailyRows + report.deletedRollupDays + report.deletedDailyRows, 0);
    assert.equal(await countRows('AnalyticsAggregateDayState'), 100);
    assert.equal(await countRows('AnalyticsDayChange'), 100);
  });

  test('B2 metadata 单侧：只有 state 候选时 marker 额度不被借用', async () => {
    await reset();
    await seedRetentionSettings();
    await insertExpiredDayStates(600);

    const run = await runRetention();
    if (run.kind !== 'completed') assert.fail(`保留清理必须写终态，实际 ${run.kind}`);
    const report = run.report;
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(report.deletedDayStates, 500);
    assert.equal(report.deletedDayChanges, 0);
    assert.equal(await countRows('AnalyticsAggregateDayState'), 100);
    assert.equal(await countRows('AnalyticsDayChange'), 0);
  });

  test('B2 metadata 单侧：只有 marker 候选时 state 额度不被借用', async () => {
    await reset();
    await seedRetentionSettings();
    await insertExpiredDayChanges(600);

    const run = await runRetention();
    if (run.kind !== 'completed') assert.fail(`保留清理必须写终态，实际 ${run.kind}`);
    const report = run.report;
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(report.deletedDayStates, 0);
    assert.equal(report.deletedDayChanges, 500);
    assert.equal(await countRows('AnalyticsAggregateDayState'), 0);
    assert.equal(await countRows('AnalyticsDayChange'), 100);
  });

  test('B2 扫描窗 2,000：候选 2,000 只删 500，扫描上限不是删除额度', async () => {
    await reset();
    await seedRetentionSettings();
    await insertExpiredDayStates(2_000);

    const run = await runRetention();
    if (run.kind !== 'completed') assert.fail(`保留清理必须写终态，实际 ${run.kind}`);
    const report = run.report;
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(report.candidates.dayState, 2_000, '扫描窗读满 2,000 个到期候选');
    assert.equal(report.deletedDayStates, 500, '单轮 state 删除上限仍是 500');
    assert.equal(await countRows('AnalyticsAggregateDayState'), 1_500);
  });

  test('B2 四表与 metadata 独立：四表 20,000 同时 metadata 仍 500/500', async () => {
    await reset();
    await seedRetentionSettings();
    await insertExpiredRollupDaily(19_000);
    await insertExpiredDailyRows(5_000);
    await insertExpiredDayStates(600);
    await insertExpiredDayChanges(600);

    const run = await runRetention();
    if (run.kind !== 'completed') assert.fail(`保留清理必须写终态，实际 ${run.kind}`);
    const report = run.report;
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(report.deletedRollupDailyRows, 19_000);
    assert.equal(report.deletedDailyRows, 1_000);
    assert.equal(report.deletedRollupDailyRows + report.deletedDailyRows, 20_000);
    assert.equal(report.deletedDayStates, 500);
    assert.equal(report.deletedDayChanges, 500);
    assert.equal(await countExpiredRollupRows('AnalyticsDailyRollup'), 0);
    assert.equal(await countRows('AnalyticsDaily'), 4_000);
    assert.equal(await countRows('AnalyticsAggregateDayState'), 100);
    assert.equal(await countRows('AnalyticsDayChange'), 100);
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
