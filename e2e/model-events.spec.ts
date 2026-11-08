import { PrismaClient, type AnalyticsEventKind } from '@prisma/client';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * M2-T7：真实 GLB 生命周期接入分析采集。
 *
 * 证据分级：
 * - 全部用例跑真实浏览器 + 真实 Next 构建服务；事件经真实 POST /api/analytics/events，
 *   落库用同一个测试数据库核对，不以请求日志代替持久化。
 * - 故障注入只限 E-103 的卡面负例（GLB 下载失败、WebGL 不支持、context lost 由既有 M2-T6 用例覆盖，
 *   这里补事件侧；超时用真实挂起请求），并在注释与报告里标明是注入。
 * - 未同意用例证明模型仍可用且 0 分析请求/0 分析身份；不把“没有请求”当成“模型没加载”。
 */

type EventRow = {
  kind: string;
  eventId: string;
  viewId: string | null;
  navigationId: string | null;
  productSlug: string | null;
  durationMs: number | null;
  failureReason: string | null;
  occurredAt: Date;
  path: string | null;
};

type PostedEvent = {
  kind: string;
  eventId: string;
  navigationId?: string;
  viewId?: string;
  productSlug?: string;
  durationMs?: number;
  failureReason?: string;
  occurredAt: string;
  path?: string;
};

let db: PrismaClient | undefined;

function database(): PrismaClient {
  if (!process.env.DATABASE_URL) throw new Error('expected the isolated test database');
  db ??= new PrismaClient();
  return db;
}

test.afterAll(async () => {
  await db?.$disconnect();
});

function track(page: Page): string[] {
  const bodies: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (!request.url().includes('/api/analytics/events')) return;
    bodies.push(request.postData() ?? '');
  });
  return bodies;
}

async function waitForGrant(page: Page): Promise<void> {
  let unavailable = false;
  const onResponse = (response: { url: () => string; status: () => number }) => {
    if (response.url().includes('/api/analytics/consent') && response.status() === 503) unavailable = true;
  };
  page.on('response', onResponse);
  try {
    await expect.poll(async () => {
      if (unavailable) throw new Error('analytics consent signing is unavailable');
      const cookies = await page.context().cookies();
      const cookie = cookies.find((item) => item.name === 'pj_analytics');
      const collecting = await page.locator('html').getAttribute('data-analytics-collecting');
      return Boolean(cookie && cookie.value.startsWith('v1.') && cookie.value.length > 20 && collecting === 'true');
    }, { timeout: 20_000 }).toBe(true);
  } finally {
    page.off('response', onResponse);
  }
}

async function acceptAnalytics(page: Page): Promise<void> {
  await page.goto('/en');
  const banner = page.getByRole('region', { name: 'Cookie consent' });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await banner.getByRole('button', { name: 'Accept all' }).click();
  await expect(page.locator('.consent-toast')).toBeVisible();
  await waitForGrant(page);
}

/** Produces the existing M5-T7 product_view for a product route without a full document load. */
async function clientNavigate(page: Page, href: string): Promise<PostedEvent[]> {
  const pending = page.waitForResponse((response) => (
    response.url().includes('/api/analytics/events')
    && response.request().method() === 'POST'
    && response.ok()
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
  return (response.request().postDataJSON() as { events: PostedEvent[] }).events;
}

async function rowsSince(since: Date, kind?: AnalyticsEventKind): Promise<EventRow[]> {
  return database().analyticsEvent.findMany({
    where: { occurredAt: { gte: since }, ...(kind ? { kind } : {}) },
    orderBy: { occurredAt: 'asc' },
    select: {
      kind: true,
      eventId: true,
      viewId: true,
      navigationId: true,
      productSlug: true,
      durationMs: true,
      failureReason: true,
      occurredAt: true,
      path: true,
    },
  });
}

function terminalsOf(rows: EventRow[], viewId: string): EventRow[] {
  return rows.filter((row) => row.viewId === viewId && (row.kind === 'model_load_success' || row.kind === 'model_load_failure'));
}

async function openCatalogAndArm(page: Page): Promise<void> {
  await page.goto('/en/products');
  // 真实的指针移动会打开 3D 懒加载（不额外要求激活点击）。
  await page.mouse.move(320, 260);
}

test('M2-T7 真实浏览器：产品访问、model start 与 success 分别落库并共享 viewId', async ({ page }) => {
  test.setTimeout(180_000);
  const since = new Date();
  const posted = track(page);
  await acceptAnalytics(page);

  // 既有的产品页生产者：产品访问（product_view）先照常落库。
  const pdpEvents = await clientNavigate(page, '/en/products/custom-greeting-cards');
  expect(pdpEvents.some((event) => event.kind === 'product_view' && event.productSlug === 'gift-cards')).toBe(true);

  await openCatalogAndArm(page);
  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await rowsSince(since, 'model_load_success')).length, { timeout: 60_000 }).toBeGreaterThan(0);

  const all = await rowsSince(since);
  const starts = all.filter((row) => row.kind === 'model_view_start');
  const successes = all.filter((row) => row.kind === 'model_load_success');
  const productViews = all.filter((row) => row.kind === 'product_view');
  const succeeded = successes[0];
  const started = succeeded ? starts.find((row) => row.viewId === succeeded.viewId) : undefined;
  if (!started || !succeeded) throw new Error('expected a success paired with its start');

  // product_view：一条来自产品页（gift-cards），一条来自本页真实 GLB 发起的卡片。
  expect(productViews.some((row) => row.productSlug === 'gift-cards' && row.path === '/en/products/custom-greeting-cards')).toBe(true);
  expect(productViews.some((row) => row.productSlug === started.productSlug && row.path === '/en/products')).toBe(true);

  // 同 viewId：一种终态、真实 durationMs、产品/导航与 start 一致。
  expect(terminalsOf(all, succeeded.viewId)).toHaveLength(1);
  expect(succeeded.kind).toBe('model_load_success');
  expect(succeeded.productSlug).toBe(started.productSlug);
  expect(succeeded.navigationId).toBe(started.navigationId);
  expect(Number.isInteger(succeeded.durationMs)).toBe(true);
  expect(succeeded.durationMs!).toBeGreaterThanOrEqual(0);
  expect(succeeded.durationMs!).toBeLessThanOrEqual(600_000);
  expect(succeeded.durationMs!).toBeLessThanOrEqual(succeeded.occurredAt.getTime() - started.occurredAt.getTime() + 1_000);

  // 请求层同样能读到这三类事件，不是只在数据库里补出来的。
  const bodies = posted.map((body) => JSON.parse(body) as { events: PostedEvent[] });
  const kinds = bodies.flatMap((body) => body.events.map((event) => event.kind));
  expect(kinds).toContain('page_view');
  expect(kinds).toContain('product_view');
  expect(kinds).toContain('model_view_start');
  expect(kinds).toContain('model_load_success');
});

test('M2-T7 未同意：真实模型仍可操作，0 分析请求、0 分析身份', async ({ page }) => {
  test.setTimeout(150_000);
  const posted = track(page);
  await page.goto('/en');
  const banner = page.getByRole('region', { name: 'Cookie consent' });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await banner.getByRole('button', { name: 'Reject all' }).click();
  await expect(banner).toBeHidden();

  await openCatalogAndArm(page);
  const card = page.locator('article.card').first();
  const stage = card.getByTestId('product-viewport');
  await expect(stage).toHaveAttribute('data-framed', '1', { timeout: 90_000 });
  await expect(page.locator('canvas')).toHaveCount(1);

  const before = await stage.getAttribute('data-azimuth');
  await card.getByTestId('model-rotate-right').click();
  await expect.poll(async () => stage.getAttribute('data-azimuth'), { timeout: 10_000 }).not.toBe(before);

  await page.waitForTimeout(1_500);
  expect(posted).toEqual([]);
  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => cookie.name === 'pj_analytics')).toBe(false);
  const storedKeys = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
  expect(storedKeys.some((key) => /pj-analytics|browserId|browserHash|analyticsId/i.test(key))).toBe(false);
});

test('M2-T7 WebGL 不支持：无真实 GLB 尝试，因此没有 start/terminal；海报与重试仍可用', async ({ page }) => {
  test.setTimeout(150_000);
  const since = new Date();
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (String(type).startsWith('webgl') || type === 'experimental-webgl') return null;
      return (original as unknown as (t: string, ...a: unknown[]) => unknown).call(this, type, ...args);
    } as typeof original;
  });
  await acceptAnalytics(page);
  await openCatalogAndArm(page);

  const card = page.locator('article.card').first();
  const fallback = card.getByTestId('model-fallback');
  await expect(fallback).toBeVisible({ timeout: 40_000 });
  await expect(fallback).toHaveAttribute('data-reason', 'WEBGL_UNAVAILABLE');
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(card.locator('img')).toHaveCSS('opacity', '1');

  await page.waitForTimeout(2_000);
  expect(await rowsSince(since, 'model_view_start')).toEqual([]);
  expect(await rowsSince(since, 'model_load_failure')).toEqual([]);
});

test('M2-T7 GLB 下载失败：failure 终态落库；手动重试使用新 viewId 并成功', async ({ page }) => {
  test.setTimeout(180_000);
  const since = new Date();
  let requests = 0;
  let allow = false;
  await page.route(/\/models\/.*\.glb(\?.*)?$/, async (route) => {
    requests += 1;
    if (!allow) return route.abort('failed');
    return route.continue();
  });
  await acceptAnalytics(page);
  await openCatalogAndArm(page);

  const card = page.locator('article.card').first();
  const stage = card.getByTestId('product-viewport');
  const fallback = stage.getByTestId('model-fallback');
  await expect(fallback).toBeVisible({ timeout: 60_000 });
  await expect(fallback).toHaveAttribute('data-reason', 'LOAD_ERROR');
  expect(requests).toBeGreaterThan(0);

  // 视口内可能同时有两张卡尝试加载；每一张都应按自己的 viewId 各记一次 failure。
  await expect.poll(async () => (await rowsSince(since, 'model_load_failure')).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const failures = await rowsSince(since, 'model_load_failure');
  for (const row of failures) {
    expect(row.failureReason).toBe('LOAD_ERROR');
    expect(Number.isInteger(row.durationMs)).toBe(true);
    expect(row.durationMs!).toBeGreaterThanOrEqual(0);
    expect(terminalsOf(await rowsSince(since), row.viewId!)).toHaveLength(1);
  }
  const failed = failures[0];
  const failedCard = page.locator(`article#${failed.productSlug}`);

  // 产品访问仍只有一条（重试不再补 product_view）。
  const productViews = (await rowsSince(since, 'product_view')).filter((row) => row.productSlug === failed.productSlug);
  expect(productViews).toHaveLength(1);

  allow = true;
  await failedCard.getByTestId('product-viewport').getByTestId('model-retry').click();
  await expect.poll(async () => (await rowsSince(since, 'model_load_success')).length, { timeout: 90_000 }).toBeGreaterThan(0);
  const success = (await rowsSince(since, 'model_load_success')).find((row) => row.productSlug === failed.productSlug);
  if (!success) throw new Error('expected the retried card to succeed');
  expect(success.viewId).not.toBe(failed.viewId);
  expect(terminalsOf(await rowsSince(since), success.viewId!)).toHaveLength(1);
  expect(terminalsOf(await rowsSince(since), failed.viewId!)).toHaveLength(1);

  const starts = await rowsSince(since, 'model_view_start');
  const startedViews = starts.map((row) => row.viewId);
  expect(startedViews).toContain(failed.viewId);
  expect(startedViews).toContain(success.viewId);

  // 询盘入口仍可用（真实点击，不是只断言可见）。
  await failedCard.getByRole('button', { name: 'Add to quote' }).click();
  await expect(failedCard.getByRole('button', { name: /In quote/ })).toHaveAttribute('aria-pressed', 'true');
});

test('M2-T7 超时：30s 未完成记 TIMEOUT failure，同 viewId 只留一种终态', async ({ page }) => {
  test.setTimeout(150_000);
  const since = new Date();
  await page.route(/\/models\/.*\.glb(\?.*)?$/, async () => {
    await new Promise(() => { /* 保持请求挂起，直到页面关闭 */ });
  });
  await acceptAnalytics(page);
  await openCatalogAndArm(page);

  const fallback = page.locator('article.card').first().getByTestId('model-fallback');
  await expect.poll(async () => (await rowsSince(since, 'model_load_failure')).length, { timeout: 60_000 }).toBeGreaterThan(0);
  const failures = await rowsSince(since, 'model_load_failure');
  for (const failed of failures) {
    expect(failed.failureReason).toBe('TIMEOUT');
    expect(Number.isInteger(failed.durationMs)).toBe(true);
    expect(failed.durationMs!).toBeGreaterThanOrEqual(29_000);
    expect(failed.durationMs!).toBeLessThanOrEqual(45_000);
    expect(terminalsOf(await rowsSince(since), failed.viewId!)).toHaveLength(1);
  }
  expect(await rowsSince(since, 'model_load_success')).toEqual([]);
  await expect(fallback).toHaveAttribute('data-reason', 'TIMEOUT', { timeout: 30_000 });
});

test('M2-T7 切走产品页：未决尝试被取消，不补写终态', async ({ page }) => {
  test.setTimeout(150_000);
  const since = new Date();
  await page.route(/\/models\/.*\.glb(\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    await route.continue().catch(() => { /* 页面已离开时请求已被取消 */ });
  });
  await acceptAnalytics(page);
  await openCatalogAndArm(page);

  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 45_000 }).toBeGreaterThan(0);
  const starts = await rowsSince(since, 'model_view_start');

  await page.getByTestId('home-link').click();
  await expect(page).toHaveURL(/\/en$/);
  await page.waitForTimeout(2_000);

  const after = await rowsSince(since);
  for (const start of starts) {
    expect(terminalsOf(after, start.viewId!)).toHaveLength(0);
  }
});
