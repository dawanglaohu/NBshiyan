import { PrismaClient, type AnalyticsEventKind } from '@prisma/client';
import type { Page, Response } from '@playwright/test';
import { expect, test } from './fixtures';
import { BASE } from './base-url';

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

type ConsentResponse = { status: number; retryAfter: string | null };

type ConsentWatch = {
  responses: ConsentResponse[];
  dispose: () => void;
};

const CONSENT_PATH = '/api/analytics/consent';
const CONSENT_ORIGIN = new URL(BASE).origin;

/**
 * 只认本次测试服务上精确的 `POST /api/analytics/consent`：
 * 其它 origin、同名后缀（如 consent-other）和 GET 响应都不算一次同意写。
 */
function isConsentWrite(response: Response): boolean {
  try {
    const url = new URL(response.url());
    return response.request().method() === 'POST'
      && url.origin === CONSENT_ORIGIN
      && url.pathname === CONSENT_PATH;
  } catch {
    return false;
  }
}

/**
 * 同意写响应记录器：必须在触发点击之前装好，否则快速响应会被漏掉。
 * 监听只收集状态与 Retry-After，不抛错（事件回调里抛错会变成未处理异常）；
 * 判定放回断言线程，由 expectGranted / expectNoConsentFailure 做。
 */
function watchConsent(page: Page): ConsentWatch {
  const responses: ConsentResponse[] = [];
  const onResponse = (response: Response) => {
    try {
      if (!isConsentWrite(response)) return;
      responses.push({ status: response.status(), retryAfter: response.headers()['retry-after'] ?? null });
    } catch {
      // 响应对象已被释放时不打断用例；缺失会由断言超时暴露。
    }
  };
  page.on('response', onResponse);
  return { responses, dispose: () => page.off('response', onResponse) };
}

function describeConsent(responses: ConsentResponse[]): string {
  if (!responses.length) return 'no consent response observed';
  return responses
    .map((item) => `status=${item.status}${item.retryAfter ? ` retry-after=${item.retryAfter}` : ''}`)
    .join(', ');
}

function firstConsentFailure(responses: ConsentResponse[]): ConsentResponse | undefined {
  return responses.find((item) => item.status < 200 || item.status >= 300);
}

/** cookie 与采集标记分开报，避免把两者混成一个“没就绪”。 */
async function consentState(page: Page): Promise<string> {
  const cookies = await page.context().cookies().catch(() => []);
  const cookie = cookies.find((item) => item.name === 'pj_analytics');
  const collecting = await page.locator('html').getAttribute('data-analytics-collecting').catch(() => null);
  const granted = Boolean(cookie && cookie.value.startsWith('v1.') && cookie.value.length > 20);
  return `cookie=${cookie ? (granted ? 'granted' : 'unexpected') : 'absent'} collecting=${collecting ?? 'missing'}`;
}

/** 等同意生效：响应失败（状态/Retry-After）与 cookie、采集标记分别报告。 */
async function expectGranted(page: Page, watch: ConsentWatch): Promise<void> {
  try {
    await expect.poll(async () => {
      const failure = firstConsentFailure(watch.responses);
      if (failure) throw new Error(`consent write rejected: ${describeConsent([failure])}`);
      const cookies = await page.context().cookies();
      const cookie = cookies.find((item) => item.name === 'pj_analytics');
      const collecting = await page.locator('html').getAttribute('data-analytics-collecting');
      return Boolean(cookie && cookie.value.startsWith('v1.') && cookie.value.length > 20 && collecting === 'true');
    }, { timeout: 20_000 }).toBe(true);
  } catch (error) {
    const head = String((error as Error).message).split('\n')[0];
    throw new Error(`${head} | consent responses: ${describeConsent(watch.responses)} | ${await consentState(page)}`);
  }
}

/**
 * 拒绝路径：本次动作必须产生一条真实、匹配的同意写响应且为 2xx。
 * 无响应、无关响应、延迟失败都算失败；不把“客户端把重复选择合并成不发请求”当无条件成功——
 * 若某用例确实预期不新发写请求，须显式断言“没有新响应”，不能拿空数组当 2xx 通过。
 */
async function expectNoConsentFailure(page: Page, watch: ConsentWatch, action: string): Promise<void> {
  try {
    await expect.poll(() => watch.responses.length, { timeout: 20_000 }).toBeGreaterThan(0);
  } catch {
    throw new Error(`${action} consent write failed: no POST ${CONSENT_PATH} response observed | ${await consentState(page)}`);
  }
  const failure = firstConsentFailure(watch.responses);
  if (failure) throw new Error(`${action} consent write failed: ${describeConsent([failure])}`);
}

/** 单次同意/拒绝写：点击前装监听，点击后按 grant 判定，最后一定摘掉监听。 */
async function writeConsent(
  page: Page,
  action: string,
  click: () => Promise<void>,
  options: { grant: boolean },
): Promise<void> {
  const watch = watchConsent(page);
  try {
    await click();
    if (options.grant) await expectGranted(page, watch);
    else await expectNoConsentFailure(page, watch, action);
  } finally {
    watch.dispose();
  }
}

async function acceptAnalytics(page: Page): Promise<void> {
  const watch = watchConsent(page);
  try {
    await page.goto('/en');
    const banner = page.getByRole('region', { name: 'Cookie consent' });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await banner.getByRole('button', { name: 'Accept all' }).click();
    await expect(page.locator('.consent-toast')).toBeVisible();
    await expectGranted(page, watch);
  } finally {
    watch.dispose();
  }
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

/** Grant analytics on the page that is already open, without navigating or reloading. */
async function acceptOnCurrentPage(page: Page): Promise<void> {
  const watch = watchConsent(page);
  try {
    const banner = page.getByRole('region', { name: 'Cookie consent' });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await banner.getByRole('button', { name: 'Accept all' }).click();
    await expectGranted(page, watch);
  } finally {
    watch.dispose();
  }
}

async function rejectOnCurrentPage(page: Page): Promise<void> {
  const watch = watchConsent(page);
  try {
    const banner = page.getByRole('region', { name: 'Cookie consent' });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await banner.getByRole('button', { name: 'Reject all' }).click();
    await expect(banner).toBeHidden();
    await expectNoConsentFailure(page, watch, 'reject');
  } finally {
    watch.dispose();
  }
}

async function openCookieSettings(page: Page): Promise<void> {
  await page.locator('#cookie-settings-link').click();
  await expect(page.getByRole('dialog', { name: 'Cookie settings' })).toBeVisible({ timeout: 10_000 });
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
  // viewId 是终态与 start 的唯一关联键；为空说明事件本身不完整，直接失败，不用断言或类型强转兜。
  if (!succeeded.viewId) throw new Error('expected a viewId on the success event');

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
  await writeConsent(page, 'reject', () => banner.getByRole('button', { name: 'Reject all' }).click(), { grant: false });
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

test('M2-T7 F1 同页接受：不重载页面，后续真实 GLB 发起即落 product_view/start/success', async ({ page }) => {
  test.setTimeout(180_000);
  const since = new Date();
  const posted = track(page);
  await page.goto('/en/products');
  await acceptOnCurrentPage(page);

  // 不导航、不重载：同一页上直接真实发起 3D 懒加载。
  await page.mouse.move(320, 260);
  // 首屏卡片可能已因同意前的指针事件开始过；滚到尚未加载的卡片，保证同意后确有新的真实尝试。
  await page.locator('article.card').last().scrollIntoViewIfNeeded();
  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 90_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await rowsSince(since, 'model_load_success')).length, { timeout: 90_000 }).toBeGreaterThan(0);

  const rows = await rowsSince(since);
  // 同意前的这次停留不补发 page_view；产品访问只随真实 start 落一条同导航的记录。
  expect(rows.filter((row) => row.kind === 'page_view')).toEqual([]);
  const starts = rows.filter((row) => row.kind === 'model_view_start');
  const successes = rows.filter((row) => row.kind === 'model_load_success');
  const productViews = rows.filter((row) => row.kind === 'product_view');
  const started = starts[0];
  expect(started.path).toBe('/en/products');
  expect(productViews.some((row) => row.navigationId === started.navigationId && row.productSlug === started.productSlug)).toBe(true);
  expect(terminalsOf(rows, successes[0].viewId!)).toHaveLength(1);

  // 撤回后同一文档内再导航：不补发访问，也不再发事件批。
  await expect(page.locator('html')).toHaveAttribute('data-analytics-queue', '0', { timeout: 15_000 });
  await openCookieSettings(page);
  await writeConsent(
    page,
    'reject',
    () => page.getByRole('dialog', { name: 'Cookie settings' }).getByRole('button', { name: 'Reject all' }).click(),
    { grant: false },
  );
  await expect(page.locator('html')).toHaveAttribute('data-analytics-collecting', 'false', { timeout: 15_000 });
  const revokedRows = (await rowsSince(since)).length;
  const revokedPosts = posted.length;
  await page.evaluate(() => history.pushState(null, '', '/en'));
  await page.waitForTimeout(1_500);
  expect((await rowsSince(since)).length).toBe(revokedRows);
  expect(posted.length).toBe(revokedPosts);
});

test('M2-T7 F1 拒绝后再次接受：同页恢复采集，真实加载落库', async ({ page }) => {
  test.setTimeout(180_000);
  const since = new Date();
  const slug = 'christmas-merchandise';
  const initialUrl = new URL('/models/christmas-tube.621c7715.glb', BASE);
  const retryUrl = new URL('?retry=1', initialUrl).href;
  const injected = new Set<import('@playwright/test').Request>();
  let allow = false;
  let retryRequested = false;
  await page.route((url) => url.origin === initialUrl.origin && /^\/models\/.+\.glb$/.test(url.pathname), async (route) => {
    const request = route.request();
    const url = request.method() === 'GET' && request.frame() === page.mainFrame() ? request.url() : null;
    if (!allow) {
      await route.abort('failed');
      if (url === initialUrl.href) injected.add(request);
      return;
    }
    await route.continue();
    if (url === retryUrl) retryRequested = true;
  });

  const width = 900;
  await page.setViewportSize({ width, height: 1_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/en/products');
  await rejectOnCurrentPage(page);
  await expect(page.locator('main')).toBeFocused();
  const card = page.locator(`article.card#${slug}`);
  const stage = card.getByTestId('product-viewport');
  const fallback = stage.locator(`[data-testid="model-fallback"][data-slug="${slug}"][data-reason="LOAD_ERROR"]`);
  const retry = fallback.getByTestId('model-retry');
  const settings = page.locator('#cookie-settings-link');

  // 从页脚进入设置，保存返回同一个按钮。单列视口按实测页尾距离露出末卡模型下沿及重试区。
  const height = await stage.evaluate(async (el) => {
    await document.fonts.ready;
    const remaining = document.documentElement.scrollHeight - (window.scrollY + el.getBoundingClientRect().bottom);
    return Math.max(680, Math.ceil(remaining + 280));
  });
  await page.setViewportSize({ width, height });
  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => {
    const root = document.documentElement;
    return Math.abs(root.scrollHeight - root.clientHeight - window.scrollY);
  }), { message: 'page reached the catalogue footer' }).toBeLessThanOrEqual(1);
  await expect(settings).toBeInViewport({ ratio: 1 });
  await page.mouse.move(320, 260);

  // 跟踪真实画廊的 200 px 预热区，覆盖弹窗期间及焦点恢复时经过的卡片。
  const windowProbe = await page.evaluateHandle(() => {
    const selector = '.product-grid [data-testid="product-viewport"][data-slug]';
    const tracks = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const margin = 200;
    const warmed = new Set<string | null>();
    const record = (entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) {
        if (entry.isIntersecting) warmed.add(entry.target.getAttribute('data-slug'));
      }
    };
    const observer = new IntersectionObserver(record, { rootMargin: `${margin}px` });
    tracks.forEach((track) => observer.observe(track));
    return {
      snapshot() {
        record(observer.takeRecords());
        const root = document.documentElement;
        const current = Array.from(document.querySelectorAll<HTMLElement>(selector));
        const inRange = current.filter((track) => {
          const rect = track.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.right >= -margin && rect.left <= root.clientWidth + margin
            && rect.bottom >= -margin && rect.top <= root.clientHeight + margin;
        });
        return {
          atEnd: Math.abs(root.scrollHeight - root.clientHeight - window.scrollY) <= 1,
          sameTracks: current.length === tracks.length && current.every((track, i) => track === tracks[i]),
          inRange: inRange.map((track) => track.getAttribute('data-slug')),
          warmed: [...warmed],
        };
      },
      disconnect: () => observer.disconnect(),
    };
  });
  const readWindow = () => windowProbe.evaluate((probe) => probe.snapshot());
  const expectedWindow = { atEnd: true, sameTracks: true, inRange: [slug], warmed: [slug] };
  const eventsPath = '/api/analytics/events';
  const eventPosts: (string | null)[] = [];
  const onEventPost = (request: import('@playwright/test').Request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.origin === initialUrl.origin && url.pathname === eventsPath) {
      eventPosts.push(request.postData());
    }
  };
  let closeRetryWindow: (() => Promise<void>) | undefined;
  try {
    await expect.poll(readWindow, { message: 'only the retry card enters the footer warm-up window' }).toEqual(expectedWindow);
    const dialog = page.getByRole('dialog', { name: 'Cookie settings' });
    await settings.click();
    await expect(dialog).toBeVisible();
    await expect.poll(async () => ({
      networkFailed: [...injected].some((request) => request.failure()?.errorText === 'net::ERR_FAILED'),
      fallbackVisible: await fallback.isVisible(),
    }), { timeout: 60_000 }).toEqual({ networkFailed: true, fallbackVisible: true });
    await expect(page.locator('html')).toHaveAttribute('data-analytics-collecting', 'false');
    expect(await readWindow()).toEqual(expectedWindow);
    page.on('request', onEventPost);
    const retryWindow = await retry.evaluateHandle((button, path) => {
      const root = document.documentElement;
      const attribute = 'data-analytics-queue';
      let queuedBeforeClick = root.getAttribute(attribute) !== '0';
      let clicked = false;
      let postsBeforeClick = 0;
      const postsAfterClick: (string | null)[] = [];
      const recordQueue = (records: MutationRecord[]) => {
        if (records.some(({ oldValue }) => oldValue !== '0') || root.getAttribute(attribute) !== '0') {
          queuedBeforeClick = true;
        }
      };
      const queueObserver = new MutationObserver(recordQueue);
      queueObserver.observe(root, { attributes: true, attributeFilter: [attribute], attributeOldValue: true });
      const onClick = (event: MouseEvent) => {
        if (!clicked && event.isTrusted && event.button === 0 && event.composedPath().includes(button)) {
          recordQueue(queueObserver.takeRecords());
          queueObserver.disconnect();
          clicked = true;
        }
      };
      document.addEventListener('click', onClick, true);

      // 在浏览器线程以可信点击为界给 fetch 分阶段，随后核对实际网络请求。
      const fetchOriginal = window.fetch;
      const fetchObserved: typeof fetch = function (this: Window, ...args) {
        const result = Reflect.apply(fetchOriginal, this, args) as ReturnType<typeof fetch>;
        const [input, init] = args;
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (method.toUpperCase() !== 'POST') return result;
        let url: URL;
        try {
          url = new URL(input instanceof Request ? input.url : input, document.baseURI);
        } catch {
          return result;
        }
        if (url.origin === location.origin && url.pathname === path) {
          if (clicked) postsAfterClick.push(typeof init?.body === 'string' ? init.body : null);
          else postsBeforeClick += 1;
        }
        return result;
      };
      window.fetch = fetchObserved;

      return {
        snapshot() {
          if (!clicked) recordQueue(queueObserver.takeRecords());
          return { clicked, queuedBeforeClick, postsBeforeClick };
        },
        postClickBodies: () => [...postsAfterClick],
        dispose() {
          queueObserver.disconnect();
          document.removeEventListener('click', onClick, true);
          if (window.fetch === fetchObserved) window.fetch = fetchOriginal;
        },
      };
    }, eventsPath);
    closeRetryWindow = async () => {
      try {
        await retryWindow.evaluate((probe) => probe.dispose());
      } finally {
        await retryWindow.dispose();
      }
    };
    await writeConsent(page, 'accept', () => dialog.getByRole('button', { name: 'Accept all' }).click(), { grant: true });
    await expect(dialog).toBeHidden();
    await expect(settings).toBeFocused();
    await expect(fallback).toBeVisible();
    await expect(retry).toBeEnabled();
    await expect(retry).toBeInViewport({ ratio: 1 });
    expect(await readWindow()).toEqual(expectedWindow);
    expect(await rowsSince(since)).toEqual([]);
    expect(await readWindow()).toEqual(expectedWindow);

    // 点击可命中的按钮中心，避免定位器自动滚动改变预热集合。
    const retryPoint = await retry.evaluate((button) => {
      const { left, top, width, height } = button.getBoundingClientRect();
      const point = { x: left + width / 2, y: top + height / 2 };
      return button.contains(document.elementFromPoint(point.x, point.y)) ? point : null;
    });
    if (!retryPoint) throw new Error('Retry button center is covered');
    const noBeforeRetry = { queuedBeforeClick: false, postsBeforeClick: 0 };
    const readRetry = () => retryWindow.evaluate((probe) => probe.snapshot());
    expect(await readRetry()).toMatchObject({ clicked: false, ...noBeforeRetry });
    expect(eventPosts, 'analytics POSTs delivered before retry input').toHaveLength(0);
    allow = true;
    await page.mouse.click(retryPoint.x, retryPoint.y);
    expect(await readRetry(), 'analytics before the trusted retry click').toMatchObject({ clicked: true, ...noBeforeRetry });
    await expect.poll(async () => {
      if (!retryRequested) return false;
      const starts = await rowsSince(since, 'model_view_start');
      return starts.some((row) => row.productSlug === slug && row.viewId !== null);
    }, { timeout: 90_000 }).toBe(true);
    const [start] = await rowsSince(since, 'model_view_start');
    expect(start).toMatchObject({ productSlug: slug, viewId: expect.any(String), navigationId: expect.any(String) });
    await expect.poll(async () => {
      const successes = await rowsSince(since, 'model_load_success');
      return successes.some((row) => row.viewId === start.viewId && row.productSlug === slug && row.navigationId === start.navigationId);
    }, { timeout: 90_000 }).toBe(true);
    expect(await readWindow()).toEqual(expectedWindow);
    const rows = await rowsSince(since);
    expect(rows.filter((row) => row.kind === 'model_view_start')).toEqual([start]);
    expect(rows.filter((row) => row.kind === 'page_view')).toEqual([]);
    expect(start.path).toBe('/en/products');
    const postClickBodies = await retryWindow.evaluate((probe) => probe.postClickBodies());
    expect(eventPosts).toHaveLength(postClickBodies.length);
    const postedIds = new Set<string>();
    for (const [index, body] of eventPosts.entries()) {
      if (body === null || body !== postClickBodies[index]) throw new Error('Analytics POST did not match a fetch after the trusted click');
      const { events } = JSON.parse(body) as { events: PostedEvent[] };
      events.forEach(({ eventId }) => postedIds.add(eventId));
    }
    expect(postedIds.has(start.eventId)).toBe(true);
    expect(rows.some((row) => row.kind === 'product_view' && row.navigationId === start.navigationId && row.productSlug === start.productSlug && postedIds.has(row.eventId))).toBe(true);
  } finally {
    page.off('request', onEventPost);
    await closeRetryWindow?.().catch(() => {});
    await windowProbe.evaluate((probe) => probe.disconnect()).catch(() => {});
    await windowProbe.dispose().catch(() => {});
  }
});

test('M2-T7 F1 同意请求在途导航：授权确认后按当前页建立上下文', async ({ page }) => {
  test.setTimeout(180_000);
  const since = new Date();
  await page.route('**/api/analytics/consent', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue().catch(() => { /* 页面已离开时请求可能已被取消 */ });
  });
  await page.goto('/en');
  const banner = page.getByRole('region', { name: 'Cookie consent' });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  const consent = watchConsent(page);
  try {
    await banner.getByRole('button', { name: 'Accept all' }).click();

    // 服务端确认还在途时用真实站内链接离开首页；授权确认后应按产品页建立上下文。
    await page.getByTestId('products-link').click();
    await expect(page).toHaveURL(/\/en\/products$/);
    await expect(page.locator('article.card').first()).toBeVisible({ timeout: 20_000 });
    await expectGranted(page, consent);
  } finally {
    consent.dispose();
  }

  await page.mouse.move(320, 260);
  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 90_000 }).toBeGreaterThan(0);
  const rows = await rowsSince(since);
  expect(rows.filter((row) => row.kind === 'page_view')).toEqual([]);
  const start = rows.find((row) => row.kind === 'model_view_start')!;
  expect(start.path).toBe('/en/products');
  expect(rows.some((row) => row.kind === 'product_view' && row.navigationId === start.navigationId && row.productSlug === start.productSlug)).toBe(true);
});

test('M2-T7 F1 不补发同意前的真实尝试：同意前已发起的模型不产生 start/终态', async ({ page }) => {
  test.setTimeout(180_000);
  const since = new Date();
  await page.goto('/en/products');
  await page.mouse.move(320, 260);
  await expect.poll(async () => page.locator('[data-testid="product-viewport"][data-framed="1"]').count(), { timeout: 90_000 }).toBeGreaterThan(0);
  const framed = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="product-viewport"][data-framed="1"]')].map((el) => el.dataset.slug ?? ''));
  expect(framed.length).toBeGreaterThan(0);
  expect(await rowsSince(since)).toEqual([]);

  await acceptOnCurrentPage(page);
  // 滚到同意前未加载的卡片，让新的真实 GLB 发起；同意前已发起的尝试不得补 start。
  await page.locator('article.card').last().scrollIntoViewIfNeeded();
  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 90_000 }).toBeGreaterThan(0);
  const starts = await rowsSince(since, 'model_view_start');
  for (const start of starts) expect(framed).not.toContain(start.productSlug);
  expect(await rowsSince(since, 'page_view')).toEqual([]);
});

test('M2-T7 context lost：未决尝试立即记 WEBGL_UNAVAILABLE，不再补 TIMEOUT', async ({ page }) => {
  test.setTimeout(180_000);
  const since = new Date();
  await page.route(/\/models\/.*\.glb(\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    await route.continue().catch(() => { /* context lost 后请求可能已取消 */ });
  });
  await acceptAnalytics(page);
  await openCatalogAndArm(page);

  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 45_000 }).toBeGreaterThan(0);
  expect(await rowsSince(since, 'model_load_failure')).toEqual([]);

  const lost = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    ext.loseContext();
    return true;
  });
  expect(lost, '浏览器必须支持 WEBGL_lose_context 才能注入 context lost').toBe(true);

  await expect.poll(async () => (await rowsSince(since, 'model_load_failure')).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const failures = await rowsSince(since, 'model_load_failure');
  for (const failure of failures) {
    expect(failure.failureReason).toBe('WEBGL_UNAVAILABLE');
    expect(failure.durationMs!).toBeLessThan(30_000);
    expect(terminalsOf(await rowsSince(since), failure.viewId!)).toHaveLength(1);
  }

  // 越过 30s 计时器：不再出现 TIMEOUT，可见失败原因也不被改写。
  await page.waitForTimeout(32_000);
  const after = await rowsSince(since);
  expect(after.filter((row) => row.kind === 'model_load_failure' && row.failureReason === 'TIMEOUT')).toEqual([]);
  await expect(page.locator(`article#${failures[0].productSlug}`).getByTestId('model-fallback')).toHaveAttribute('data-reason', 'WEBGL_UNAVAILABLE');
});

test('M2-T7 R2 同文档离开返回：新访问的 attempt 0 真实加载正常计入', async ({ page }) => {
  test.setTimeout(180_000);
  const since = new Date();
  await acceptAnalytics(page);
  await openCatalogAndArm(page);
  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 90_000 }).toBeGreaterThan(0);
  const firstStarts = await rowsSince(since, 'model_view_start');
  const firstNav = firstStarts[0].navigationId!;
  const firstSlug = firstStarts[0].productSlug!;

  // 同一文档内离开再返回：ProductGallery 重新挂载，attempt 从 0 开始。
  await page.getByTestId('home-link').click();
  await expect(page).toHaveURL(/\/en$/);
  await page.getByTestId('products-link').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  await page.mouse.move(320, 260);

  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 90_000 }).toBeGreaterThan(firstStarts.length);
  const starts = await rowsSince(since, 'model_view_start');
  const returned = starts.find((row) => row.navigationId !== firstNav);
  if (!returned) throw new Error('expected a start under the returned visit navigation');
  const views = await rowsSince(since, 'product_view');
  expect(views.some((row) => row.navigationId === returned.navigationId && row.productSlug === returned.productSlug)).toBe(true);
  expect(views.filter((row) => row.navigationId === firstNav && row.productSlug === firstSlug)).toHaveLength(1);
});

test('M2-T7 R2 撤回再授权后返回：新访问的真实加载计入', async ({ page }) => {
  test.setTimeout(180_000);
  const since = new Date();
  await acceptAnalytics(page);
  await openCatalogAndArm(page);
  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 90_000 }).toBeGreaterThan(0);

  await openCookieSettings(page);
  await writeConsent(
    page,
    'reject',
    () => page.getByRole('dialog', { name: 'Cookie settings' }).getByRole('button', { name: 'Reject all' }).click(),
    { grant: false },
  );
  await expect(page.locator('html')).toHaveAttribute('data-analytics-collecting', 'false', { timeout: 15_000 });

  await openCookieSettings(page);
  await writeConsent(
    page,
    'accept',
    () => page.getByRole('dialog', { name: 'Cookie settings' }).getByRole('button', { name: 'Accept all' }).click(),
    { grant: true },
  );
  const beforeReturn = (await rowsSince(since, 'model_view_start')).length;

  await page.getByTestId('home-link').click();
  await expect(page).toHaveURL(/\/en$/);
  await page.getByTestId('products-link').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  await page.mouse.move(320, 260);
  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 90_000 }).toBeGreaterThan(beforeReturn);
  const starts = await rowsSince(since, 'model_view_start');
  const latest = starts[starts.length - 1];
  const views = await rowsSince(since, 'product_view');
  expect(views.some((row) => row.navigationId === latest.navigationId && row.productSlug === latest.productSlug)).toBe(true);
});

test('M2-T7 R2 旧访问的迟到回调不串入新访问', async ({ page }) => {
  test.setTimeout(180_000);
  const since = new Date();
  await page.route(/\/models\/.*\.glb(\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    await route.continue().catch(() => { /* 页面已离开时请求已被取消 */ });
  });
  await acceptAnalytics(page);
  await openCatalogAndArm(page);
  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 45_000 }).toBeGreaterThan(0);
  const firstStarts = await rowsSince(since, 'model_view_start');
  const first = firstStarts[0];

  // 未决时离开：卸载取消未决尝试；返回后新访问重新发起。
  await page.getByTestId('home-link').click();
  await expect(page).toHaveURL(/\/en$/);
  await page.getByTestId('products-link').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  await page.mouse.move(320, 260);
  await expect.poll(async () => (await rowsSince(since, 'model_view_start')).length, { timeout: 90_000 }).toBeGreaterThan(firstStarts.length);
  const starts = await rowsSince(since, 'model_view_start');
  // 两条 start 的 occurredAt 可能完全相同（4e trace：返回访问两条均为 13.147），只按 DB 顺序 .find
  // 会随机落到不同模型；用已有 productSlug 把新 view 绑定到与旧访问同一个模型——迟到回调要考察的正是这一对。
  // first.productSlug 缺失时直接失败（不匹配 null，也不泛化取任意新 view）。
  const returned = starts.find(
    (row) =>
      row.viewId !== first.viewId &&
      row.navigationId !== first.navigationId &&
      first.productSlug !== null &&
      row.productSlug === first.productSlug,
  );
  if (!returned) throw new Error('expected the same product start in the returned visit');

  // 等旧请求的 15s 延迟结束，再核终态只属于新访问。
  await page.waitForTimeout(16_000);
  // 终态由真实 GLB 解析后异步 POST：16s 只保证旧请求窗口已结束，不等于新终态已落库。
  // 有界等待同一 returned.viewId 的终态出现，再读最终 rows 断精确计数，并显式核 kind——
  // 30s 的 model_load_failure(TIMEOUT) 不能充作成功。
  await expect
    .poll(async () => terminalsOf(await rowsSince(since), returned.viewId!).length, { timeout: 10_000 })
    .toBe(1);
  const rows = await rowsSince(since);
  expect(terminalsOf(rows, first.viewId!)).toHaveLength(0);
  const returnedTerminals = terminalsOf(rows, returned.viewId!);
  expect(returnedTerminals).toHaveLength(1);
  expect(returnedTerminals[0].kind).toBe('model_load_success');
});
