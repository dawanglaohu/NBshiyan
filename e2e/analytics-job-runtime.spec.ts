// M5-T8 真实五分钟调度与业务链验收。
//
// 两类证据分开：
//   1) 真调度：测试本身不发 POST。真实 crond 每 5 分钟调 cron-tick → 作业入口；
//      e2e 只观察 JobState/watermark，重启应用后观察下一次真实触发，停调度后
//      观察状态不再前进（不把旧成功或 409 当新执行）。
//   2) E-44：真实浏览器同意 + 两次客户端导航，经真实事件入口入库，再跑同一
//      聚合作业；以本用例开始前的当日聚合为基线，只断言本浏览器的增量
//      （PV 增加、新增 1 个 UV 且不随刷新增加、同 eventId 重试不增加）。不清任何表。
//
// 环境（缺一即 skip 并写明原因，不冒充通过）：
//   真调度：M5T8_E2E_SCHEDULER=1、M5T8_TEST_DATABASE_URL、M5T8_E2E_BASE_URL、
//           M5T8_E2E_CRON_LOG（必需，本轮触发必须由日志佐证）、
//           M5T8_E2E_RESTART_CMD / M5T8_E2E_STOP_CRON_CMD / M5T8_E2E_START_CRON_CMD
//   E-44：  DATABASE_URL（或 M5T8_TEST_DATABASE_URL）、CRON_SECRET；
//           应用地址默认 Playwright baseURL，可用 M5T8_E2E_BASE_URL 指向隔离实例。
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import type { APIRequestContext, Page } from '@playwright/test';
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

type PostedEvent = { kind: string; eventId: string; navigationId: string };
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

/** 客户端导航（不整页刷新）并返回本次导航的真实事件载荷，复用 T7 同意/访问步骤。 */
async function clientNavigate(page: Page, href: string): Promise<PostedPayload> {
  const pending = page.waitForResponse((response) => (
    response.url().includes('/api/analytics/events') && response.request().method() === 'POST' && response.ok()
  ));
  const stayed = page.evaluate(async (target) => {
    const marker = { stay: true };
    Object.defineProperty(window, '__analyticsStay', { configurable: true, value: marker });
    history.pushState(null, '', target);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    return (window as unknown as { __analyticsStay?: object }).__analyticsStay === marker;
  }, href);
  const response = await pending;
  if (!(await stayed)) throw new Error('expected a client navigation');
  return response.request().postDataJSON() as PostedPayload;
}

async function runAggregateJob(request: APIRequestContext): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('expected CRON_SECRET');
  const requestedAt = Date.now();
  const res = await request.post(appUrl('/api/admin/cron/operations'), {
    headers: { authorization: `Bearer ${secret}` },
    data: { jobKey: 'analytics-aggregate' },
    timeout: 60_000,
  });
  if (res.status() === 409) {
    // 设施调度持有同一把租约：事件已在其读取前入库，等它这一轮成功即可。
    await waitFor(async () => {
      const state = await jobState();
      return Boolean(state
        && state.lastStatus === 'SUCCEEDED'
        && (state.lastSucceededAt?.getTime() ?? 0) >= requestedAt - 1_000);
    }, '调度正在运行，等待本轮成功', 90_000);
    return;
  }
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json() as { status: string };
  expect(body.status).toBe('SUCCEEDED');
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

test('E-44：同浏览器两次新访问 PV 增加、UV 仍 1，同 eventId 重试不增加', async ({ page, request }, testInfo) => {
  test.skip(!E2E_DB, '需要数据库 DATABASE_URL/M5T8_TEST_DATABASE_URL');
  test.skip(!process.env.CRON_SECRET, '需要 CRON_SECRET');
  // 本机 next dev 首次 hydration 可能超过默认 30s；CI 构建产物下远小于此。
  testInfo.setTimeout(180_000);
  assertDedicatedDatabase();
  // 不删除任何行：以本用例开始前的当日 page_view/en 聚合为基线，只断言本浏览器的增量。
  // 共享 e2e 库里已有的事件只会抬高基线，不影响增量断言。
  const siteDay = await currentSiteDay();
  const before = await pageViewRollup(siteDay);
  const beforeCount = before?.count ?? 0;
  const beforeUv = before?.uniqueBrowsers ?? 0;

  await page.goto(appUrl('/en'));
  await page.getByRole('button', { name: 'Accept all' }).click();
  await waitForGrant(page);
  await expect.poll(() => queueLength(page)).toBe(0);

  // 第一次真实新访问：PV 增加该次导航产生的事件数；本浏览器是当日新增访客，UV +1。
  const firstPayload = await clientNavigate(page, '/en/products');
  const firstViews = firstPayload.events.filter((event) => event.kind === 'page_view');
  expect(firstViews.length).toBeGreaterThan(0);
  // 同一库证明：被测应用刚写的原始行必须能在本测试查询连接里读到。
  const written = await database().$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::bigint AS c FROM "AnalyticsEvent"
    WHERE "navigationId" = ${firstViews[0]!.navigationId}
      AND "kind" = 'page_view'::"AnalyticsEventKind"
  `;
  expect(Number(written[0]!.c)).toBeGreaterThan(0);
  await runAggregateJob(request);
  const firstVisit = (await pageViewRollup(siteDay))!;
  expect(firstVisit.count).toBe(beforeCount + firstViews.length);
  expect(firstVisit.uniqueBrowsers).toBe(beforeUv + 1);

  // 第二次真实新访问：PV 再增加；同一浏览器不再增加 UV。
  const secondPayload = await clientNavigate(page, '/en/contact');
  const secondViews = secondPayload.events.filter((event) => event.kind === 'page_view');
  expect(secondViews.length).toBeGreaterThan(0);
  await runAggregateJob(request);
  const secondVisit = (await pageViewRollup(siteDay))!;
  expect(secondVisit.count).toBe(firstVisit.count + secondViews.length);
  expect(secondVisit.uniqueBrowsers).toBe(beforeUv + 1);

  // 刷新/重试同一 eventId：重发同一份载荷，真实入口接受但不增加 PV/UV。
  const replayEvent = firstViews[0]!;
  const replay = await page.evaluate(async (event) => {
    const response = await fetch('/api/analytics/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [event] }),
      credentials: 'same-origin',
    });
    return { status: response.status };
  }, replayEvent);
  expect(replay.status).toBe(200);
  await runAggregateJob(request);
  const afterReplay = (await pageViewRollup(siteDay))!;
  expect(afterReplay.count).toBe(secondVisit.count);
  expect(afterReplay.uniqueBrowsers).toBe(beforeUv + 1);
});
