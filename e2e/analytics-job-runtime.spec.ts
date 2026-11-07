// M5-T8 真实五分钟调度与业务链验收。
//
// 两类证据分开：
//   1) 真调度：测试本身不发 POST。真实 crond 每 5 分钟调 cron-tick → 作业入口；
//      e2e 只观察 JobState/watermark，重启应用后观察下一次真实触发，停调度后
//      观察状态不再前进（不把旧成功或 409 当新执行）。
//   2) E-44：真实浏览器同意 + 两次客户端导航，经真实事件入口入库，再跑同一
//      聚合作业，核 PV 增加、UV 仍 1、同 eventId 重试不增加。
//
// 环境（缺一即 skip 并写明原因，不冒充通过）：
//   真调度：M5T8_E2E_SCHEDULER=1、M5T8_TEST_DATABASE_URL、M5T8_E2E_BASE_URL、
//           M5T8_E2E_RESTART_CMD / M5T8_E2E_STOP_CRON_CMD / M5T8_E2E_START_CRON_CMD
//           （可选 M5T8_E2E_CRON_LOG 指向 cron 日志，用于核对触发时间与 HTTP 状态）
//   E-44：  DATABASE_URL（或 M5T8_TEST_DATABASE_URL）、CRON_SECRET；
//           应用地址默认 Playwright baseURL，可用 M5T8_E2E_BASE_URL 指向隔离实例。
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import type { APIRequestContext, Page } from '@playwright/test';
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
};

async function jobState(): Promise<JobStateRow | null> {
  const rows = await database().$queryRaw<JobStateRow[]>`
    SELECT "generation", "lastStatus"::text AS "lastStatus", "lastStartedAt", "lastSucceededAt"
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

function cronTail(): string {
  const path = process.env.M5T8_E2E_CRON_LOG;
  if (!path || !existsSync(path)) return '';
  return readFileSync(path, 'utf8').split(/\r?\n/).slice(-20).join('\n');
}

test('真实五分钟调度：重启后仍由 crond 触发，停调度不再前进', async ({}, testInfo) => {
  test.skip(process.env.M5T8_E2E_SCHEDULER !== '1', '需要真实 crond 设施（M5T8_E2E_SCHEDULER=1）');
  test.skip(!E2E_DB, '需要设施库 M5T8_TEST_DATABASE_URL');
  test.skip(!APP_BASE, '需要设施应用地址 M5T8_E2E_BASE_URL');
  const restart = process.env.M5T8_E2E_RESTART_CMD;
  const stopCron = process.env.M5T8_E2E_STOP_CRON_CMD;
  const startCron = process.env.M5T8_E2E_START_CRON_CMD;
  test.skip(!restart || !stopCron || !startCron, '需要设施提供的重启/停启调度命令');
  // 三次真实 */5 触发 + 一个完整停调度周期的上界；每个 waitFor 另有自身超时。
  testInfo.setTimeout(30 * 60_000);

  const conn = database();
  const startedAt = Date.now();
  // 等上一轮租约释放再清状态，避免删到别的触发正在写的那一行。
  await waitFor(async () => (await jobState())?.lastStatus !== 'RUNNING', '上一轮租约释放', 120_000);
  // 只清 JobState 与水位：观测从空状态开始的真实触发，不伪造业务事实。
  await conn.$executeRawUnsafe('DELETE FROM "AnalyticsRollupDay"');
  await conn.$executeRawUnsafe('DELETE FROM "AnalyticsDailyRollup"');
  await conn.$executeRawUnsafe('DELETE FROM "JobState"');

  // 第一次真实触发：cron 自己调入口，本测试不发任何 POST。
  await waitFor(async () => (await jobState())?.lastStatus === 'SUCCEEDED', '第一次 cron 触发');
  const first = (await jobState())!;
  expect(first.generation).toBeGreaterThanOrEqual(1);
  expect(first.lastSucceededAt).not.toBeNull();
  expect(first.lastSucceededAt!.getTime()).toBeGreaterThanOrEqual(startedAt - 6 * 60_000);
  expect(await watermarkCount()).toBeGreaterThan(0);
  const firstWatermark = await latestWatermark();
  expect(cronTail()).toMatch(/analytics-aggregate 200/);

  // 重启应用：下一次触发必须仍来自 cron，且代次/成功时间继续前进。
  execSync(restart, { stdio: 'pipe', timeout: 120_000 });
  await waitFor(async () => {
    const res = await fetch(appUrl('/api/health'));
    return res.ok;
  }, '重启后的应用健康检查', 120_000);
  const afterRestartAt = Date.now();
  await waitFor(async () => {
    const state = await jobState();
    return Boolean(state
      && state.generation > first.generation
      && (state.lastSucceededAt?.getTime() ?? 0) > (first.lastSucceededAt?.getTime() ?? 0));
  }, '重启后的下一次 cron 触发');
  const second = (await jobState())!;
  expect(second.generation).toBeGreaterThan(first.generation);
  expect(second.lastStartedAt!.getTime()).toBeGreaterThanOrEqual(afterRestartAt - 6 * 60_000);
  expect(second.lastSucceededAt!.getTime()).toBeGreaterThan(first.lastSucceededAt!.getTime());
  expect(await watermarkCount()).toBeGreaterThan(0);
  const secondWatermark = (await latestWatermark())!;
  expect(secondWatermark.updatedAt.getTime()).toBeGreaterThanOrEqual(firstWatermark!.updatedAt.getTime());

  // 停止调度：过一个完整 5 分钟周期 + 作业时限后，状态不得再前进。
  execSync(stopCron, { stdio: 'pipe', timeout: 60_000 });
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

  // 恢复调度：再次由 cron 触发并前进，证明上面的静止不是应用坏了。
  execSync(startCron, { stdio: 'pipe', timeout: 60_000 });
  await waitFor(async () => {
    const state = await jobState();
    return Boolean(state && state.generation > stillStopped.generation);
  }, '恢复调度后的下一次触发');
  expect((await jobState())!.lastStatus).toBe('SUCCEEDED');
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
  const res = await request.post(appUrl('/api/admin/cron/operations'), {
    headers: { authorization: `Bearer ${secret}` },
    data: { jobKey: 'analytics-aggregate' },
    timeout: 60_000,
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json() as { status: string };
  expect(body.status).toBe('SUCCEEDED');
}

async function pageViewRollup(): Promise<{ siteDate: string; count: number; uniqueBrowsers: number } | null> {
  const rows = await database().$queryRaw<{ siteDate: string; count: number; uniqueBrowsers: number }[]>`
    SELECT "siteDate", "count", "uniqueBrowsers" FROM "AnalyticsDailyRollup"
    WHERE "kind" = 'page_view'::"AnalyticsEventKind" AND "locale" = 'en' AND "productSlug" = ''
    ORDER BY "siteDate" DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

test('E-44：同浏览器两次新访问 PV 增加、UV 仍 1，同 eventId 重试不增加', async ({ page, request }, testInfo) => {
  test.skip(!E2E_DB, '需要数据库 DATABASE_URL/M5T8_TEST_DATABASE_URL');
  test.skip(!process.env.CRON_SECRET, '需要 CRON_SECRET');
  // 本机 next dev 首次 hydration 可能超过默认 30s；CI 构建产物下远小于此。
  testInfo.setTimeout(180_000);
  const conn = database();
  // 隔离本用例的统计事实：事件仍全部经真实入口写入，作业也只跑产品实现。
  for (const table of ['AnalyticsEvent', 'AnalyticsDailyRollup', 'AnalyticsRollupDay', 'JobState']) {
    await conn.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }

  await page.goto(appUrl('/en'));
  await page.getByRole('button', { name: 'Accept all' }).click();
  await waitForGrant(page);
  await expect.poll(() => queueLength(page)).toBe(0);

  // 同意后、任何新访问之前：当日还没有 page_view 事实。
  await runAggregateJob(request);
  const baseline = await pageViewRollup();
  const baselineCount = baseline?.count ?? 0;
  expect(baselineCount).toBe(0);

  // 第一次真实新访问：PV 增加该次导航产生的事件数，UV 仍 1。
  const firstPayload = await clientNavigate(page, '/en/products');
  const firstViews = firstPayload.events.filter((event) => event.kind === 'page_view');
  expect(firstViews.length).toBeGreaterThan(0);
  await runAggregateJob(request);
  const firstVisit = (await pageViewRollup())!;
  expect(firstVisit.count).toBe(baselineCount + firstViews.length);
  expect(firstVisit.uniqueBrowsers).toBe(1);

  // 第二次真实新访问：PV 再增加。
  const secondPayload = await clientNavigate(page, '/en/contact');
  const secondViews = secondPayload.events.filter((event) => event.kind === 'page_view');
  expect(secondViews.length).toBeGreaterThan(0);
  await runAggregateJob(request);
  const secondVisit = (await pageViewRollup())!;
  expect(secondVisit.count).toBe(firstVisit.count + secondViews.length);
  expect(secondVisit.uniqueBrowsers).toBe(1);

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
  const afterReplay = (await pageViewRollup())!;
  expect(afterReplay.count).toBe(secondVisit.count);
  expect(afterReplay.uniqueBrowsers).toBe(1);
});
