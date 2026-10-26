import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures';

const FRAMES = path.resolve(process.cwd(), '..', '.codex-plans', 'NBshiyan-m5-t7', 'gif-frames');

let db: PrismaClient | undefined;

function database(): PrismaClient {
  if (!process.env.DATABASE_URL) throw new Error('expected the isolated test database');
  db ??= new PrismaClient();
  return db;
}

test.afterAll(async () => {
  await db?.$disconnect();
});

function track(page: Page) {
  const events: string[] = [];
  const consents: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const url = request.url();
    if (url.includes('/api/analytics/events')) events.push(request.postData() ?? '');
    if (url.includes('/api/analytics/consent')) consents.push(request.postData() ?? '');
  });
  return { events, consents };
}

async function queueLength(page: Page): Promise<number> {
  const raw = await page.locator('html').getAttribute('data-analytics-queue');
  return Number(raw ?? '0');
}

function thumbOffset(transform: string): number | null {
  if (transform === 'none') return 0;
  const match = /^matrix\(([^)]+)\)$/.exec(transform);
  if (!match) return null;
  const parts = match[1].split(',').map((part) => Number(part.trim()));
  if (parts.length !== 6 || parts.some((part) => Number.isNaN(part))) return null;
  return parts[4];
}

async function switchFace(page: Page, name: string) {
  return page.getByRole('switch', { name }).locator('i').evaluate((el) => {
    const track = getComputedStyle(el);
    const after = getComputedStyle(el, '::after');
    const before = getComputedStyle(el, '::before');
    const probe = document.createElement('div');
    probe.style.background = 'var(--pj-accent)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      trackW: track.width,
      trackH: track.height,
      trackRadius: track.borderTopLeftRadius,
      border: track.borderTopWidth,
      background: track.backgroundColor,
      accent,
      before: before.content,
      afterW: after.width,
      afterH: after.height,
      afterRadius: after.borderTopLeftRadius,
      transform: after.transform,
      scroll: el.scrollWidth,
      client: el.clientWidth,
    };
  });
}

function flatTrack(face: Awaited<ReturnType<typeof switchFace>>, on: boolean): boolean {
  const offset = thumbOffset(face.transform);
  const moved = offset !== null && Math.abs(offset - (on ? 20 : 0)) < 0.6;
  return face.trackW === '44px'
    && face.trackH === '24px'
    && face.trackRadius === '0px'
    && face.border === '2px'
    && face.before === 'none'
    && face.afterW === '16px'
    && face.afterH === '16px'
    && face.afterRadius === '0px'
    && face.scroll <= face.client
    && moved
    && (on ? face.background === face.accent : face.background !== face.accent);
}

async function assertNoAnalyticsIdentity(page: Page): Promise<void> {
  const cookies = await page.context().cookies();
  if (cookies.some((cookie) => cookie.name === 'pj_analytics')) throw new Error('expected no analytics cookie');
  const stored = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
  if (stored.some((key) => /pj-analytics|browserId|browserHash|analyticsId/i.test(key))) {
    throw new Error('expected no analytics identity in browser storage');
  }
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
    }).toBe(true);
  } finally {
    page.off('response', onResponse);
  }
}

async function waitForCleared(page: Page): Promise<void> {
  await expect.poll(async () => {
    const cookies = await page.context().cookies();
    return cookies.some((cookie) => cookie.name === 'pj_analytics');
  }).toBe(false);
}

async function storedCount(navigationId: string): Promise<number> {
  try {
    return await database().analyticsEvent.count({ where: { navigationId } });
  } catch {
    throw new Error('could not query stored events');
  }
}

async function hashesDiffer(left: string, right: string): Promise<void> {
  let rows: { navigationId: string | null; browserHash: string }[];
  try {
    rows = await database().analyticsEvent.findMany({
      where: { navigationId: { in: [left, right] }, kind: 'page_view' },
      select: { navigationId: true, browserHash: true },
    });
  } catch {
    throw new Error('could not query stored events');
  }
  const first = rows.find((row) => row.navigationId === left)?.browserHash;
  const second = rows.find((row) => row.navigationId === right)?.browserHash;
  if (!first || !second || first === second) throw new Error('expected a new browserHash');
}

async function clientNavigate(page: Page, href: string): Promise<{ events: { kind: string; eventId: string; navigationId: string; productSlug?: string }[] }> {
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
  return response.request().postDataJSON() as { events: { kind: string; eventId: string; navigationId: string; productSlug?: string }[] };
}

test('未选择和拒绝都不采集，页脚偏好面板和产品控件仍可用', async ({ page }) => {
  const seen = track(page);
  await page.goto('/en/products');
  await assertNoAnalyticsIdentity(page);
  expect(seen.events).toEqual([]);

  const open = page.getByRole('button', { name: 'Open' }).first();
  await open.click();
  await expect(open).toHaveAttribute('aria-pressed', 'true');
  await page.locator('footer a[href$="#gift-boxes"]').click();
  await expect(page).toHaveURL(/#gift-boxes/);
  expect(seen.events).toEqual([]);

  await page.locator('#analytics-preferences').click();
  const dialog = page.getByRole('dialog', { name: 'Cookie settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  // 关闭后 50ms 才把焦点还给打开面板的页脚按钮。先等这次归还，再把焦点移到横幅。
  await expect(page.locator('#analytics-preferences #cookie-settings-link')).toBeFocused();
  await assertNoAnalyticsIdentity(page);

  const banner = page.getByRole('region', { name: 'Cookie consent' });
  await banner.getByRole('link').focus();
  await page.keyboard.press('Tab');
  await expect(banner.getByRole('button', { name: 'Reject all' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(banner).toBeHidden();
  await expect(page.locator('.consent-toast')).toBeVisible();
  await assertNoAnalyticsIdentity(page);
  expect(seen.events).toEqual([]);
  expect(seen.consents.some((body) => body.includes('"analytics":false'))).toBe(true);
  await open.click();
  await expect(open).toHaveAttribute('aria-pressed', 'true');
});

test('同意后导航去重，en 与 ru 产品页使用同一个内部 productSlug，换环境得到新 browserHash', async ({ page }) => {
  test.setTimeout(90_000);
  const seen = track(page);
  await page.goto('/en');
  const banner = page.getByRole('region', { name: 'Cookie consent' });
  await banner.getByRole('link').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(banner.getByRole('button', { name: 'Accept all' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.consent-toast')).toBeVisible();
  await expect.poll(() => seen.consents.some((body) => body.includes('"analytics":true'))).toBe(true);
  await waitForGrant(page);

  // 回执在 Node 侧从 route.fetch() 读取。点击后页面一跳转，Chromium 就丢掉这条响应体，再调 response.json() 会报 No data found。
  type PostedEvent = { kind: string; eventId: string; navigationId: string };
  type NavigationCapture = {
    receipt: { acceptedIds: string[] };
    postData: string;
    payload: { events: PostedEvent[] };
  };
  const captured: { current: NavigationCapture | null } = { current: null };
  let claiming = false;
  const captureNavigationReceipt = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST' || captured.current || claiming) {
      await route.fallback();
      return;
    }
    claiming = true;
    let res: Awaited<ReturnType<Route['fetch']>>;
    try {
      res = await route.fetch();
    } catch {
      claiming = false;
      try { await route.abort(); } catch { /* 页面已经离开时 abort 也会失败，请求不会再挂着 */ }
      return;
    }
    try {
      if (!res.ok()) {
        claiming = false;
        return;
      }
      captured.current = {
        receipt: await res.json() as NavigationCapture['receipt'],
        postData: request.postData() ?? '',
        payload: request.postDataJSON() as NavigationCapture['payload'],
      };
    } finally {
      await route.fulfill({ response: res });
    }
  };
  await page.route('**/api/analytics/events', captureNavigationReceipt);
  try {
    await page.locator('.nav-desktop').getByTestId('products-link').click();
    await expect.poll(() => captured.current !== null, {
      message: 'expected the navigation receipt',
      timeout: 20_000,
    }).toBe(true);
  } finally {
    await page.unroute('**/api/analytics/events', captureNavigationReceipt);
  }
  const saved = captured.current;
  if (!saved) throw new Error('expected the page view to be accepted');
  const pageView = saved.payload.events.find((event) => event.kind === 'page_view');
  if (!pageView || !saved.receipt.acceptedIds.includes(pageView.eventId)) {
    throw new Error('expected the page view to be accepted');
  }
  const replay = await page.evaluate(async (body) => {
    const response = await fetch('/api/analytics/events', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return response.json() as Promise<{ duplicateIds?: string[] }>;
  }, saved.postData);
  if (!replay.duplicateIds?.includes(pageView.eventId)) throw new Error('expected the same navigation to be a duplicate');
  if (await storedCount(pageView.navigationId) !== 1) throw new Error('expected one stored navigation');

  await expect.poll(() => queueLength(page)).toBe(0);
  const en = await clientNavigate(page, '/en/products/custom-greeting-cards');
  const enSlug = en.events.find((event) => event.kind === 'product_view')?.productSlug;
  if (enSlug !== 'gift-cards') throw new Error('expected the internal product key');

  await expect.poll(() => queueLength(page)).toBe(0);
  await page.context().clearCookies();
  await page.locator('#analytics-preferences').click();
  await page.getByRole('dialog', { name: 'Cookie settings' }).getByRole('button', { name: 'Accept all' }).click();
  await waitForGrant(page);
  const cleared = await clientNavigate(page, '/en/contact');
  const clearedView = cleared.events.find((event) => event.kind === 'page_view');
  if (!clearedView) throw new Error('expected a page view after a cleared identifier');
  await hashesDiffer(pageView.navigationId, clearedView.navigationId);

  const origin = new URL(page.url()).origin;
  const context = await page.context().browser()!.newContext();
  const other = await context.newPage();
  try {
    await other.goto(`${origin}/ru`);
    await other.getByRole('button', { name: 'Принять все' }).click();
    await waitForGrant(other);
    const fresh = await clientNavigate(other, '/ru/products/otkrytki-na-zakaz');
    const freshView = fresh.events.find((event) => event.kind === 'page_view');
    const ruSlug = fresh.events.find((event) => event.kind === 'product_view')?.productSlug;
    if (!freshView) throw new Error('expected a page view from a new context');
    if (ruSlug !== 'gift-cards') throw new Error('expected the internal product key');
    await hashesDiffer(pageView.navigationId, freshView.navigationId);
  } finally {
    await context.close();
  }

  const browser = await page.context().browser()!.browserType().launch();
  try {
    const isolated = await browser.newContext();
    const second = await isolated.newPage();
    await second.goto(`${origin}/en`);
    await second.getByRole('button', { name: 'Accept all' }).click();
    await waitForGrant(second);
    const again = await clientNavigate(second, '/en/contact');
    const againView = again.events.find((event) => event.kind === 'page_view');
    if (!againView) throw new Error('expected a page view from another browser');
    await hashesDiffer(pageView.navigationId, againView.navigationId);
    await isolated.close();
  } finally {
    await browser.close();
  }
});

test('断网待发在撤回后丢弃，恢复后不补发，无 cookie 的旧请求返回 403', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    let online = true;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    (window as unknown as { __setOnline?: (value: boolean) => void }).__setOnline = (value: boolean) => {
      online = value;
      window.dispatchEvent(new Event(value ? 'online' : 'offline'));
    };
  });
  const seen = track(page);
  await page.goto('/en');
  await page.getByRole('button', { name: 'Accept all' }).click();
  await waitForGrant(page);
  const posted = page.waitForResponse((response) => (
    response.url().includes('/api/analytics/events') && response.request().method() === 'POST' && response.ok()
  ));
  await page.locator('.nav-desktop').getByTestId('products-link').click();
  const first = await posted;
  const captured = first.request().postData() ?? '';

  await page.evaluate(() => (window as unknown as { __setOnline: (value: boolean) => void }).__setOnline(false));
  const before = seen.events.length;
  await page.locator('.nav-desktop').getByRole('link', { name: 'Home' }).click();
  await expect.poll(() => queueLength(page)).toBeGreaterThan(0);
  expect(seen.events.length).toBe(before);

  await page.locator('#analytics-preferences').click();
  const dialog = page.getByRole('dialog', { name: 'Cookie settings' });
  const analytics = dialog.getByRole('switch', { name: 'Optional analytics' });
  await analytics.focus();
  if (await analytics.getAttribute('aria-checked') !== 'false') await page.keyboard.press('Space');
  await dialog.getByRole('button', { name: 'Save choices' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.consent-toast')).toBeVisible();
  await expect.poll(() => queueLength(page)).toBe(0);
  await waitForCleared(page);
  await assertNoAnalyticsIdentity(page);

  await page.evaluate(() => (window as unknown as { __setOnline: (value: boolean) => void }).__setOnline(true));
  const frozen = seen.events.length;
  await page.locator('.nav-desktop').getByTestId('products-link').click();
  await page.waitForURL(/\/en\/products/);
  expect(seen.events.length).toBe(frozen);
  await expect.poll(() => queueLength(page)).toBe(0);

  const status = await page.evaluate(async (body) => {
    const response = await fetch('/api/analytics/events', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return response.status;
  }, captured);
  if (status !== 403) throw new Error('expected 403 without a consent cookie');
});

test('同意写串行，后到的撤回覆盖尚未返回的同意', async ({ page }) => {
  test.setTimeout(60_000);
  const seen = track(page);
  const marks: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/analytics/consent', async (route) => {
    const body = route.request().postData() ?? '';
    const allow = body.includes('"analytics":true');
    if (allow) {
      marks.push('true-start');
      await held;
      marks.push('true-end');
    } else {
      marks.push('false-start');
    }
    const response = await route.fetch();
    await route.fulfill({ response });
    if (!allow) marks.push('false-end');
  });
  try {
    await page.goto('/en');
    await page.getByRole('button', { name: 'Accept all' }).click();
    await expect.poll(() => marks.includes('true-start')).toBe(true);
    await page.locator('#analytics-preferences').click();
    await page.getByRole('dialog', { name: 'Cookie settings' }).getByRole('button', { name: 'Reject all' }).click();
    release();
    await expect.poll(() => marks.includes('false-end')).toBe(true);
    const ended = marks.indexOf('true-end');
    const started = marks.indexOf('false-start');
    if (ended < 0 || started <= ended) throw new Error('expected serial consent writes');
    const last = seen.consents[seen.consents.length - 1] ?? '';
    if (!last.includes('"analytics":false')) throw new Error('expected the last consent write to be false');
    await waitForCleared(page);
    await assertNoAnalyticsIdentity(page);
    await expect.poll(() => queueLength(page)).toBe(0);
    const before = seen.events.length;
    await page.locator('.nav-desktop').getByTestId('products-link').click();
    await page.waitForURL(/\/en\/products/);
    expect(seen.events.length).toBe(before);
    if (await page.locator('html').getAttribute('data-analytics-collecting') !== 'false') {
      throw new Error('expected collection to stay off');
    }
  } finally {
    release();
  }
});

test('三个视口的同意控件是扁平强调色，键盘可操作，触控目标至少 44px', async ({ page }) => {
  test.setTimeout(60_000);
  mkdirSync(FRAMES, { recursive: true });
  const widths = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ];
  await page.goto('/en');
  for (const size of widths) {
    await page.setViewportSize(size);
    const banner = page.getByRole('region', { name: 'Cookie consent' });
    await expect(banner).toBeVisible();
    await page.screenshot({ path: path.join(FRAMES, `${size.width}-banner.png`) });
    const chrome = await banner.locator('button.consent-main').first().evaluate((element) => {
      const computed = getComputedStyle(element);
      const probe = document.createElement('div');
      probe.style.background = 'var(--pj-accent)';
      document.body.appendChild(probe);
      const accent = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const box = element.getBoundingClientRect();
      return {
        width: computed.borderTopWidth,
        radius: computed.borderTopLeftRadius,
        background: computed.backgroundColor,
        accent,
        target: box.width >= 44 && box.height >= 44,
      };
    });
    if (chrome.width !== '2px' || chrome.radius !== '0px' || chrome.background !== chrome.accent || !chrome.target) {
      throw new Error('expected flat accent chrome');
    }
    await page.locator('#analytics-preferences').click();
    const dialog = page.getByRole('dialog', { name: 'Cookie settings' });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: path.join(FRAMES, `${size.width}-dialog.png`) });
    const dialogChrome = await dialog.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { width: computed.borderTopWidth, radius: computed.borderTopLeftRadius };
    });
    if (dialogChrome.width !== '2px' || dialogChrome.radius !== '0px') throw new Error('expected a flat dialog');
    // 等弹层入场结束再量。静止后的按钮仍须至少 44px。
    await dialog.evaluate(async (element) => {
      const pending = element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined));
      await Promise.all(pending);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect.poll(async () => dialog.locator('button').evaluateAll((elements) => elements.flatMap((element) => {
      const box = element.getBoundingClientRect();
      if (box.width >= 44 && box.height >= 44) return [];
      const name = element.getAttribute('aria-label') || element.textContent?.trim() || element.className;
      return [`${name} ${box.width.toFixed(2)}x${box.height.toFixed(2)}`];
    }))).toEqual([]);
    const analytics = dialog.getByRole('switch', { name: 'Optional analytics' });
    await expect(analytics).toBeFocused();
    await expect.poll(async () => flatTrack(await switchFace(page, 'Necessary'), true)).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(async () => flatTrack(await switchFace(page, 'Optional analytics'), true)).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(async () => flatTrack(await switchFace(page, 'Optional analytics'), false)).toBe(true);
    await page.screenshot({ path: path.join(FRAMES, `${size.width}-switch.png`) });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }

  await page.locator('#cookie-settings-link').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Cookie settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const privacy = page.locator('#privacy-link');
  const privacyBox = await privacy.boundingBox();
  if (!privacyBox || privacyBox.width < 44 || privacyBox.height < 44) throw new Error('expected a 44px privacy link');
  const prefs = await page.locator('#cookie-settings-link').boundingBox();
  if (!prefs || prefs.width < 44 || prefs.height < 44) throw new Error('expected a 44px preferences control');
});

test('在途的撤回清掉后到的同意，全程只有一次同意请求', async ({ page }) => {
  test.setTimeout(60_000);
  const seen = track(page);
  let heldFalse = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/analytics/consent', async (route) => {
    const body = route.request().postData() ?? '';
    if (!heldFalse && body.includes('"analytics":false')) {
      heldFalse = true;
      await gate;
    }
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  try {
    await page.goto('/en');
    await page.getByRole('button', { name: 'Reject all' }).click();
    await expect.poll(() => heldFalse).toBe(true);
    await page.locator('.consent-toast').getByRole('button', { name: 'Change' }).click();
    await page.getByRole('dialog', { name: 'Cookie settings' }).getByRole('button', { name: 'Accept all' }).click();
    await page.locator('.consent-toast').getByRole('button', { name: 'Change' }).click();
    await page.getByRole('dialog', { name: 'Cookie settings' }).getByRole('button', { name: 'Reject all' }).click();
    const finished = page.waitForResponse((response) => (
      response.url().includes('/api/analytics/consent')
      && (response.request().postData() ?? '').includes('"analytics":false')
    ));
    release();
    await finished;
    await page.evaluate(() => new Promise((resolve) => { window.setTimeout(resolve, 300); }));
    if (seen.consents.length !== 1) throw new Error('expected a single consent request');
    if (!seen.consents[0]?.includes('"analytics":false')) throw new Error('expected the consent request to be a withdrawal');
    if (await page.locator('html').getAttribute('data-analytics-collecting') !== 'false') {
      throw new Error('expected collection to stay off');
    }
    await expect.poll(() => queueLength(page)).toBe(0);
  } finally {
    release();
    await page.unroute('**/api/analytics/consent');
  }
});

test('同意后刷新会接受这一次加载的 page_view', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/en');
  await page.getByRole('button', { name: 'Accept all' }).click();
  await waitForGrant(page);

  type PostedEvent = { kind: string; eventId: string; navigationId?: string };
  const priorNavigationIds = new Set<string>();
  const acceptedPageViews: string[] = [];
  let reloading = false;
  const record = (postData: string, raw: string, ok: boolean, fromReload: boolean) => {
    if (!ok) return;
    let payload: { events?: PostedEvent[] };
    let receipt: { acceptedIds?: string[] };
    try {
      payload = JSON.parse(postData) as { events?: PostedEvent[] };
      receipt = JSON.parse(raw) as { acceptedIds?: string[] };
    } catch {
      return;
    }
    const pageView = payload.events?.find((event) => event.kind === 'page_view');
    if (!pageView?.eventId) return;
    const navigationId = pageView.navigationId ?? '';
    if (!fromReload) {
      if (navigationId) priorNavigationIds.add(navigationId);
      return;
    }
    if (navigationId && priorNavigationIds.has(navigationId)) return;
    if (receipt.acceptedIds?.includes(pageView.eventId)) acceptedPageViews.push(pageView.eventId);
  };

  // 响应体在 Node 侧读取。刷新会替换文档，事后再向浏览器取体会丢。
  await page.route('**/api/analytics/events', async (route) => {
    const request = route.request();
    const fromReload = reloading;
    if (request.method() !== 'POST') {
      await route.continue();
      return;
    }
    const postData = request.postData() ?? '';
    const res = await route.fetch();
    const raw = await res.text();
    const headers = { ...res.headers() };
    delete headers['content-encoding'];
    delete headers['content-length'];
    record(postData, raw, res.ok(), fromReload);
    try {
      await route.fulfill({ response: res, body: raw, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/aborted|closed|disposed|Target page/i.test(message)) throw error;
    }
  });

  try {
    reloading = true;
    await page.reload();
    await expect.poll(() => acceptedPageViews.length, {
      message: 'expected the reloaded page view to be accepted',
      timeout: 15_000,
    }).toBeGreaterThan(0);
    if (await page.locator('html').getAttribute('data-analytics-collecting') !== 'true') {
      throw new Error('expected collection to resume after reload');
    }
  } finally {
    await page.unroute('**/api/analytics/events');
  }
});

test('390 下确认 toast 显示期间悬浮按钮中心命中自身', async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const cases = [
    { path: '/en', accept: 'Accept all' },
    { path: '/ru', accept: 'Принять все' },
  ];
  for (const item of cases) {
    await page.context().clearCookies();
    await page.goto(item.path);
    await page.evaluate(() => localStorage.removeItem('pj-consent'));
    await page.reload();
    const accept = page.getByRole('button', { name: item.accept });
    await expect(accept).toBeVisible();
    const before = await page.evaluate(() => {
      const root = document.documentElement;
      const footer = document.querySelector('.site-footer');
      return {
        fabH: getComputedStyle(root).getPropertyValue('--fab-h').trim(),
        footerPad: footer ? getComputedStyle(footer).paddingBottom : '',
      };
    });
    await accept.click();
    const toast = page.locator('.consent-toast');
    await expect(toast).toBeVisible();
    const deadline = Date.now() + 8_000;
    let samples = 0;
    let checkedLayout = false;
    while (await toast.isVisible()) {
      if (Date.now() > deadline) throw new Error('toast remained visible past the deadline');
      const hit = await page.locator('.fab .toggle').evaluate((el) => {
        const box = el.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) return false;
        const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        const fab = el.closest('.fab');
        return Boolean(target && fab && fab.contains(target));
      });
      if (!hit) throw new Error('expected the FAB center to hit the FAB');
      samples += 1;
      const layout = await page.evaluate(() => {
        const root = document.documentElement;
        const style = getComputedStyle(root);
        const footer = document.querySelector('.site-footer');
        return {
          banner: root.classList.contains('has-consent'),
          clearance: style.getPropertyValue('--fab-clearance').trim(),
          padding: getComputedStyle(document.body).paddingBottom,
          fabH: style.getPropertyValue('--fab-h').trim(),
          footerPad: footer ? getComputedStyle(footer).paddingBottom : '',
        };
      });
      // 横幅关掉后页脚留白回到 84px，并在 toast 全程保持。--fab-h 和页脚 padding 保持点同意之前的值。
      if (!layout.banner) {
        if (layout.clearance !== '84px' || layout.padding !== '84px' || layout.fabH !== before.fabH || layout.footerPad !== before.footerPad) {
          throw new Error(`expected the footer clearance to stay put while the toast is visible: clearance=${layout.clearance} padding=${layout.padding} fabH=${layout.fabH} was=${before.fabH} footer=${layout.footerPad} was=${before.footerPad}`);
        }
        checkedLayout = true;
      }
      await page.waitForTimeout(200);
    }
    if (!checkedLayout) throw new Error('expected the banner to close while the toast was visible');
    if (samples < 8) throw new Error('expected samples across the whole toast');
  }
});
