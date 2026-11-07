// M5-T8 真实五分钟调度与业务链验收。
//
// 两类证据分开：
//   1) 真调度：测试本身不发 POST。真实 crond 每 5 分钟调 cron-tick → 作业入口；
//      e2e 只观察 JobState/watermark，重启应用后观察下一次真实触发，停调度后
//      观察状态不再前进（不把旧成功或 409 当新执行）。
//   2) E-44：真实浏览器点击站内可见链接两次（客户端导航，不整页刷新），每一跳都绑定
//      实际事件请求与回执；先跑一轮聚合作业把已入库事实纳入基线，再逐跳断言本浏览器
//      的增量（PV 增加、新增 1 个 UV 且不随重复写入增加、同 eventId 重发不改聚合）。
//      不清任何表；只在**没有并发调度**的专属实例上跑，409 不当作“本轮已覆盖”。
//
// 环境（缺一即 skip 并写明原因，不冒充通过）：
//   真调度：M5T8_E2E_SCHEDULER=1、M5T8_TEST_DATABASE_URL、M5T8_E2E_BASE_URL、
//           M5T8_E2E_CRON_LOG（必需，本轮触发必须由日志佐证）、
//           M5T8_E2E_RESTART_CMD / M5T8_E2E_STOP_CRON_CMD / M5T8_E2E_START_CRON_CMD
//   E-44：  DATABASE_URL（或 M5T8_TEST_DATABASE_URL）、CRON_SECRET；
//           应用地址默认 Playwright baseURL，可用 M5T8_E2E_BASE_URL 指向隔离实例；
//           M5T8_E2E_SCHEDULER 必须不是 1（同一实例先停 crond 才能绑定成功轮次）。
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import type { APIRequestContext, Locator, Page, Response as ApiResponse } from '@playwright/test';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { expect, test } from './fixtures';

const CRON = readFileSync('deploy/cron.nbshiyan', 'utf8');
const CRON_LINES = CRON.split(/\r?\n/);
const OPERATION_LINE = CRON_LINES.find((line) => line.includes('/api/admin/cron/operations'));

const APP_BASE = process.env.M5T8_E2E_BASE_URL;
const E2E_DB = process.env.M5T8_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

let db: PrismaClient | undefined;

function database(): PrismaClient {
  if (!E2E_DB) throw new Error('expected the isolated test database');
  db ??= new PrismaClient({ datasources: { db: { url: E2E_DB } } });
  return db;
}

test.afterAll(async () => {
  await db?.$disconnect();
});

function appUrl(path: string): string {
  return APP_BASE ? `${APP_BASE}${path}` : path;
}

test('cron 模板只注册 analytics-aggregate 并替换旧 rollup', () => {
  expect(OPERATION_LINE, 'cron 必须有一条 operations 调度').toBeTruthy();
  expect(OPERATION_LINE!).toMatch(/^\*\/5 \* \* \* \* /);
  expect(OPERATION_LINE!).toContain("jobKey:'analytics-aggregate'");
  expect(OPERATION_LINE!).toContain('AbortSignal.timeout(55000)');
  expect(CRON_LINES.some((line) => line.includes('/api/admin/cron/analytics-rollup'))).toBe(false);
});

type JobStateRow = {
  generation: number;
  lastStatus: string;
  lastStartedAt: Date | null;
  lastSucceededAt: Date | null;
  lockedUntil: Date | null;
};

async function jobState(): Promise<JobStateRow | null> {
  const rows = await database().$queryRaw<JobStateRow[]>`
    SELECT "generation", "lastStatus"::text AS "lastStatus", "lastStartedAt", "lastSucceededAt", "lockedUntil"
    FROM "JobState" WHERE "key" = 'analytics-aggregate'
  `;
  return rows[0] ?? null;
}

async function watermarkCount(): Promise<number> {
  const rows = await database().$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay"
  `;
  return Number(rows[0]!.c);
}

async function latestWatermark(): Promise<{ siteDate: string; updatedAt: Date } | null> {
  const rows = await database().$queryRaw<{ siteDate: string; updatedAt: Date }[]>`
    SELECT "siteDate", "updatedAt" FROM "AnalyticsRollupDay" ORDER BY "siteDate" DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 6 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ''}`);
}

type CronLine = { at: number; status: number };

function cronLines(): CronLine[] {
  const path = process.env.M5T8_E2E_CRON_LOG;
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((line) => {
    const match = /^(\S+)\s+analytics-aggregate\s+(\d+)/.exec(line.trim());
    if (!match) return [];
    const at = Date.parse(match[1]);
    return Number.isFinite(at) ? [{ at, status: Number(match[2]) }] : [];
  });
}

function cronSuccessSince(since: number): boolean {
  return cronLines().some((line) => line.at >= since && line.status === 200);
}

/**
 * 预检：查询连接必须是本机隔离库（CI 的 e2e 或设施库 M5T8_E2E_EXPECT_DB）。
 * B4/E-44 都不再执行 DELETE；这道检查用于尽早发现指错库，避免把共享/生产库
 * 当成测试目标。WSL 直连地址（172.16/12 私有段）也算本机虚拟网络。
 */
function assertDedicatedDatabase(): void {
  if (!E2E_DB) throw new Error('需要隔离库 DATABASE_URL / M5T8_TEST_DATABASE_URL');
  const url = new URL(E2E_DB);
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  const privateNet = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  if (!loopback && !privateNet) {
    throw new Error(`只允许本机/私有网络隔离库，实际主机 ${url.hostname}`);
  }
  const name = url.pathname.replace(/^\//, '');
  const expected = process.env.M5T8_E2E_EXPECT_DB;
  if (expected ? name !== expected : !/e2e|m5t8/i.test(name)) {
    throw new Error(`需要任务专属隔离库（期望 ${expected ?? 'e2e/m5t8 命名'}），实际 ${name}`);
  }
}

test('真实五分钟调度：重启后仍由 crond 触发，停调度不再前进', async ({}, testInfo) => {
  // 本用例会停/启设施调度并等真实 */5 触发，必须独立作业运行；共享 e2e job 只跑默认 skip。
  test.skip(process.env.CI === 'true', '真实设施调度用例需独立作业，不在共享 e2e job 内运行');
  test.skip(process.env.M5T8_E2E_SCHEDULER !== '1', '需要真实 crond 设施（M5T8_E2E_SCHEDULER=1）');
  test.skip(!E2E_DB, '需要设施库 M5T8_TEST_DATABASE_URL');
  test.skip(!APP_BASE, '需要设施应用地址 M5T8_E2E_BASE_URL');
  test.skip(!process.env.M5T8_E2E_CRON_LOG, '需要 cron 日志路径 M5T8_E2E_CRON_LOG（本轮触发必须可由日志佐证）');
  const restart = process.env.M5T8_E2E_RESTART_CMD;
  const stopCron = process.env.M5T8_E2E_STOP_CRON_CMD;
  const startCron = process.env.M5T8_E2E_START_CRON_CMD;
  test.skip(!restart || !stopCron || !startCron, '需要设施提供的重启/停启调度命令');
  // 三次真实 */5 触发 + 一个完整停调度周期的上界；每个 waitFor 另有自身超时。
  testInfo.setTimeout(30 * 60_000);
  assertDedicatedDatabase();
  const base = new URL(APP_BASE!);
  if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error(`被测应用必须是本机设施，实际 ${base.hostname}`);

  // 不清空 JobState/水位：只观察基线之后由 cron 产生的**新成功**。
  const monitorStartedAt = Date.now();
  const baseline = await jobState();
  const baselineSucceeded = baseline?.lastSucceededAt?.getTime() ?? 0;
  let cronStopped = false;
  let failure: unknown;
  try {
    // 第一次真实触发：cron 自己调入口，本测试不发任何 POST。
    await waitFor(async () => {
      const state = await jobState();
      return Boolean(state
        && state.lastStatus === 'SUCCEEDED'
        && (state.lastStartedAt?.getTime() ?? 0) >= monitorStartedAt - 5_000
        && (state.lastSucceededAt?.getTime() ?? 0) > baselineSucceeded);
    }, '第一次真实 cron 触发（新成功）', 7 * 60_000);
    const first = (await jobState())!;
    expect(first.generation).toBeGreaterThan(baseline?.generation ?? 0);
    expect(first.lastSucceededAt!.getTime()).toBeGreaterThan(baselineSucceeded);
    expect(await watermarkCount()).toBeGreaterThan(0);
    expect(cronSuccessSince(monitorStartedAt - 1_000), 'cron 日志必须对应本轮触发').toBe(true);
    const firstWatermark = await latestWatermark();

    // 重启应用：下一次触发必须仍来自 cron，且是重启之后开始的新成功。
    execSync(restart, { stdio: 'pipe', timeout: 120_000 });
    await waitFor(async () => {
      const res = await fetch(appUrl('/api/health'));
      return res.ok;
    }, '重启后的应用健康检查', 120_000);
    const afterRestartAt = Date.now();
    await waitFor(async () => {
      const state = await jobState();
      return Boolean(state
        && state.lastStatus === 'SUCCEEDED'
        && state.generation > first.generation
        && (state.lastStartedAt?.getTime() ?? 0) >= afterRestartAt - 5_000
        && (state.lastSucceededAt?.getTime() ?? 0) > first.lastSucceededAt!.getTime());
    }, '重启后的下一次真实触发（新成功）', 7 * 60_000);
    const second = (await jobState())!;
    expect(second.lastStartedAt!.getTime()).toBeGreaterThanOrEqual(afterRestartAt - 5_000);
    expect(second.lastSucceededAt!.getTime()).toBeGreaterThan(first.lastSucceededAt!.getTime());
    expect(await watermarkCount()).toBeGreaterThan(0);
    expect(cronSuccessSince(afterRestartAt - 1_000), '重启后的成功必须来自 cron 日志').toBe(true);
    const secondWatermark = (await latestWatermark())!;
    expect(secondWatermark.updatedAt.getTime()).toBeGreaterThanOrEqual(firstWatermark!.updatedAt.getTime());

    // 停止调度：过一个完整 5 分钟周期 + 作业时限后，状态与 cron 日志都不得再前进。
    execSync(stopCron, { stdio: 'pipe', timeout: 60_000 });
    cronStopped = true;
    const stopAt = Date.now();
    // 停调度时可能有在途运行：先等它结束且租约释放，再取稳定快照，否则在途成功会误红。
    await waitFor(async () => {
      const state = await jobState();
      return !state || (state.lastStatus !== 'RUNNING' && state.lockedUntil === null);
    }, '停调度后在途运行结束且租约释放', 120_000);
    const stopped = (await jobState())!;
    const nextBoundary = new Date();
    nextBoundary.setSeconds(0, 0);
    nextBoundary.setMinutes(nextBoundary.getMinutes() + (5 - (nextBoundary.getMinutes() % 5)));
    const waitUntil = nextBoundary.getTime() + 75_000;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitUntil - Date.now())));
    const stillStopped = (await jobState())!;
    expect(stillStopped.generation).toBe(stopped.generation);
    expect(stillStopped.lastStartedAt!.getTime()).toBe(stopped.lastStartedAt!.getTime());
    expect(stillStopped.lastSucceededAt!.getTime()).toBe(stopped.lastSucceededAt!.getTime());
    const afterStopWatermark = (await latestWatermark())!;
    expect(afterStopWatermark.updatedAt.getTime()).toBe(secondWatermark.updatedAt.getTime());
    expect(cronLines().some((line) => line.at > stopAt + 70_000 && line.status === 200), '停调度后 cron 不得再触发').toBe(false);

    // 恢复调度：再次由 cron 触发并前进，证明上面的静止不是应用坏了。
    execSync(startCron, { stdio: 'pipe', timeout: 60_000 });
    cronStopped = false;
    const resumeAt = Date.now();
    await waitFor(async () => {
      const state = await jobState();
      return Boolean(state
        && state.lastStatus === 'SUCCEEDED'
        && state.generation > stillStopped.generation
        && (state.lastStartedAt?.getTime() ?? 0) >= resumeAt - 5_000
        && (state.lastSucceededAt?.getTime() ?? 0) > stillStopped.lastSucceededAt!.getTime());
    }, '恢复调度后的新成功');
    expect(cronSuccessSince(resumeAt - 1_000), '恢复后的成功必须来自 cron 日志').toBe(true);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // 只恢复本测试接管前的状态（测试启动时调度是运行的，否则首轮触发不可能成立）。
    // 恢复失败不能吞：测试体已失败时记录，测试体通过时直接让本用例失败。
    if (cronStopped) {
      try {
        execSync(startCron, { stdio: 'pipe', timeout: 60_000 });
      } catch (error) {
        console.error('[B4] 恢复调度失败，需设施检查', error);
        await testInfo.attach('schedule-restore-failure', {
          body: error instanceof Error ? error.stack ?? error.message : String(error),
          contentType: 'text/plain',
        }).catch(() => undefined);
        if (!failure) throw error;
      }
    }
  }
});

type PostedEvent = { kind: string; eventId: string; navigationId: string; path?: string };
type PostedPayload = { events: PostedEvent[] };

async function queueLength(page: Page): Promise<number> {
  const raw = await page.locator('html').getAttribute('data-analytics-queue');
  return Number(raw ?? '0');
}

async function waitForGrant(page: Page): Promise<void> {
  await expect.poll(async () => {
    const cookies = await page.context().cookies();
    const cookie = cookies.find((item) => item.name === 'pj_analytics');
    const collecting = await page.locator('html').getAttribute('data-analytics-collecting');
    return Boolean(cookie && cookie.value.startsWith('v1.') && collecting === 'true');
  }).toBe(true);
}

function isEventsPost(response: ApiResponse): boolean {
  return response.url().includes('/api/analytics/events')
    && response.request().method() === 'POST'
    && response.ok();
}

type CapturedBatch = { payload: PostedPayload; status: number };

/**
 * 点击页面上真实可见的站内链接，返回这一跳实际发出的事件载荷与响应状态。
 * 点击前在窗口对象上打标记、跳转后仍读得到，才说明这是客户端导航：
 * 事件属于这一次点击，而不是整页加载后新文档里的另一种来源。
 *
 * 只取请求载荷与响应状态，不读响应正文：客户端导航之后 Playwright 不再提供
 * 旧文档的响应体；回执内容只在重放一步由页面自己读（见用例末尾）。
 */
async function clickVisibleLink(
  page: Page,
  link: Locator,
  expectedPath: string,
): Promise<CapturedBatch> {
  const marker = `e44-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((value) => {
    (window as unknown as { __analyticsNavMarker?: string }).__analyticsNavMarker = value;
  }, marker);
  const pending = page.waitForResponse(isEventsPost);
  await link.click();
  const response = await pending;
  const payload = response.request().postDataJSON() as PostedPayload;
  const status = response.status();
  expect(new URL(page.url()).pathname, '点击后必须停在该链接的目标页').toBe(expectedPath);
  const kept = await page.evaluate(() => (
    (window as unknown as { __analyticsNavMarker?: string }).__analyticsNavMarker ?? null
  ));
  expect(kept, 'E-44 需要客户端导航；整页刷新会清掉标记').toBe(marker);
  return { payload, status };
}

type RawPageViews = { count: number; maxReceivedAt: number };

/** 这一次导航真实落库的原始事实：行数与最晚 receivedAt（用来证明聚合轮次在其后开始）。 */
async function rawPageViews(navigationId: string): Promise<RawPageViews> {
  const rows = await database().$queryRaw<{ c: bigint; m: Date | null }[]>`
    SELECT COUNT(*)::bigint AS c, MAX("receivedAt") AS m FROM "AnalyticsEvent"
    WHERE "navigationId" = ${navigationId}
      AND "kind" = 'page_view'::"AnalyticsEventKind"
  `;
  const row = rows[0]!;
  return { count: Number(row.c), maxReceivedAt: row.m ? row.m.getTime() : 0 };
}

type JobRound = { startedAt: number; succeededAt: number };

/**
 * 同步跑一轮聚合作业，并证明这一轮覆盖了 `eventsReceivedThrough` 之前落库的事实：
 * 请求本身成功、租约已释放，且 lastStartedAt 晚于最后一条事件入库时间。
 *
 * 409 表示租约被另一轮占用，只能说明有并发调度在跑，不能当作“本轮已覆盖本次事件”，
 * 所以直接失败：E-44 必须在没有调度器的专属实例上执行。
 */
async function runAggregateJob(request: APIRequestContext, eventsReceivedThrough: number): Promise<JobRound> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('expected CRON_SECRET');
  const requestedAt = Date.now();
  const res = await request.post(appUrl('/api/admin/cron/operations'), {
    headers: { authorization: `Bearer ${secret}` },
    data: { jobKey: 'analytics-aggregate' },
    timeout: 60_000,
  });
  if (res.status() === 409) {
    throw new Error('聚合租约被并发运行占用：E-44 必须在停掉调度器的专属实例上跑，409 不能证明本轮覆盖了本次事件');
  }
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json() as { status: string };
  expect(body.status).toBe('SUCCEEDED');

  const state = await jobState();
  expect(state, '聚合作业状态必须可读').not.toBeNull();
  expect(state!.lastStatus).toBe('SUCCEEDED');
  expect(state!.lockedUntil, '成功轮次必须已释放租约').toBeNull();
  const startedAt = state!.lastStartedAt?.getTime() ?? 0;
  const succeededAt = state!.lastSucceededAt?.getTime() ?? 0;
  expect(startedAt).toBeGreaterThanOrEqual(requestedAt - 1_000);
  expect(succeededAt).toBeGreaterThanOrEqual(startedAt);
  expect(startedAt, '本轮必须在本用例事件入库之后才开始读事实').toBeGreaterThan(eventsReceivedThrough);
  return { startedAt, succeededAt };
}

/** 当前站点自然日：读与应用同一份 SiteSetting（缺省 UTC），保证查询与应用落库同一天。 */
async function currentSiteDay(): Promise<string> {
  const rows = await database().$queryRaw<{ value: unknown }[]>`
    SELECT "value" FROM "SiteSetting" WHERE "key" = 'analytics.settings'
  `;
  const raw = rows[0]?.value;
  const timezone = raw && typeof raw === 'object' && typeof (raw as { timezone?: unknown }).timezone === 'string'
    ? (raw as { timezone: string }).timezone
    : 'UTC';
  return siteLocalDate(new Date(), timezone);
}

async function pageViewRollup(siteDay: string): Promise<{ count: number; uniqueBrowsers: number } | null> {
  const rows = await database().$queryRaw<{ count: number; uniqueBrowsers: number }[]>`
    SELECT "count", "uniqueBrowsers" FROM "AnalyticsDailyRollup"
    WHERE "siteDate" = ${siteDay}
      AND "kind" = 'page_view'::"AnalyticsEventKind" AND "locale" = 'en' AND "productSlug" = ''
  `;
  return rows[0] ?? null;
}

test('E-44：真实链接两次访问 PV 增加、UV 仍 1，同 eventId 重发不增加', async ({ page, request }, testInfo) => {
  test.skip(!E2E_DB, '需要数据库 DATABASE_URL/M5T8_TEST_DATABASE_URL');
  test.skip(!process.env.CRON_SECRET, '需要 CRON_SECRET');
  // 并发调度时无法把某个成功轮次绑定到本用例刚写入的事件，E-44 只在停了 crond 的实例上跑。
  test.skip(process.env.M5T8_E2E_SCHEDULER === '1', 'E-44 需要没有并发调度的专属实例（先停 crond）');
  // 本机 next dev 首次 hydration 可能超过默认 30s；CI 构建产物下远小于此。
  testInfo.setTimeout(180_000);
  assertDedicatedDatabase();
  // 不清任何行：同意产生的初始事件先全部确认并聚合成基线，之后只断言本浏览器的增量。
  const siteDay = await currentSiteDay();

  await page.goto(appUrl('/en'));
  // 同意后若客户端补发首屏 page_view，它必须先落库并计入基线，不能留到后面抬高增量。
  const grantPending = page.waitForResponse(isEventsPost, { timeout: 5_000 }).catch(() => null);
  await page.getByRole('button', { name: 'Accept all' }).click();
  await waitForGrant(page);
  await expect.poll(() => queueLength(page)).toBe(0);
  let receivedThrough = 0;
  // 首屏事件若已落库，本浏览器就已计入当日 UV，基线之后的增量里 UV 不再 +1。
  let browserCounted = false;
  const granted = await grantPending;
  if (granted) {
    expect(granted.status(), '首屏事件必须被真实入口接受').toBe(200);
    const payload = granted.request().postDataJSON() as PostedPayload;
    const views = payload.events.filter((event) => event.kind === 'page_view');
    expect(views.length).toBeGreaterThan(0);
    const raw = await rawPageViews(views[0]!.navigationId);
    expect(raw.count, '同一库证明：应用写的行必须能在本测试的查询连接里读到').toBeGreaterThan(0);
    receivedThrough = raw.maxReceivedAt;
    browserCounted = true;
  }

  // 基线：先跑一轮聚合作业，让基线聚合覆盖上面已确认的全部事实，再读当日 page_view/en。
  await runAggregateJob(request, receivedThrough);
  const baseline = (await pageViewRollup(siteDay)) ?? { count: 0, uniqueBrowsers: 0 };
  const expectedUv = baseline.uniqueBrowsers + (browserCounted ? 0 : 1);

  // 第一次真实新访问：点站内可见链接（客户端导航），绑定这一跳的实际请求与原始行。
  const first = await clickVisibleLink(page, page.getByTestId('products-link'), '/en/products');
  expect(first.status, '这一跳的事件批次必须被真实入口接受').toBe(200);
  const firstViews = first.payload.events.filter((event) => event.kind === 'page_view');
  expect(firstViews.length).toBeGreaterThan(0);
  expect(firstViews[0]!.path).toBe('/en/products');
  const firstRaw = await rawPageViews(firstViews[0]!.navigationId);
  expect(firstRaw.count, '同一库证明：应用写的行必须能在本测试的查询连接里读到').toBe(firstViews.length);
  receivedThrough = Math.max(receivedThrough, firstRaw.maxReceivedAt);
  await runAggregateJob(request, receivedThrough);
  const firstVisit = (await pageViewRollup(siteDay))!;
  expect(firstVisit.count).toBe(baseline.count + firstViews.length);
  expect(firstVisit.uniqueBrowsers).toBe(expectedUv);

  // 第二次真实新访问：换一个可见链接再点一次；同一浏览器不再增加 UV。
  const second = await clickVisibleLink(page, page.getByTestId('contact-link'), '/en/contact');
  expect(second.status, '这一跳的事件批次必须被真实入口接受').toBe(200);
  const secondViews = second.payload.events.filter((event) => event.kind === 'page_view');
  expect(secondViews.length).toBeGreaterThan(0);
  expect(secondViews[0]!.path).toBe('/en/contact');
  const secondRaw = await rawPageViews(secondViews[0]!.navigationId);
  expect(secondRaw.count).toBe(secondViews.length);
  receivedThrough = Math.max(receivedThrough, secondRaw.maxReceivedAt);
  await runAggregateJob(request, receivedThrough);
  const secondVisit = (await pageViewRollup(siteDay))!;
  expect(secondVisit.count).toBe(firstVisit.count + secondViews.length);
  expect(secondVisit.uniqueBrowsers).toBe(expectedUv);

  // 同 eventId 重发（刷新/重试路径）：真实入口认得是重复事件，不新增原始行、不改聚合。
  // 回执正文由页面自己的 fetch 读出，不依赖 Playwright 的响应体缓存。
  const replayEvent = firstViews[0]!;
  const replay = await page.evaluate(async (event) => {
    const response = await fetch('/api/analytics/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [event] }),
      credentials: 'same-origin',
    });
    return {
      status: response.status,
      receipt: await response.json() as { acceptedIds: string[]; duplicateIds: string[] },
    };
  }, replayEvent);
  expect(replay.status).toBe(200);
  expect(replay.receipt.duplicateIds).toContain(replayEvent.eventId);
  expect(replay.receipt.acceptedIds).not.toContain(replayEvent.eventId);
  const replayRaw = await rawPageViews(replayEvent.navigationId);
  expect(replayRaw.count).toBe(firstRaw.count);
  await runAggregateJob(request, receivedThrough);
  const afterReplay = (await pageViewRollup(siteDay))!;
  expect(afterReplay.count).toBe(secondVisit.count);
  expect(afterReplay.uniqueBrowsers).toBe(expectedUv);
});
