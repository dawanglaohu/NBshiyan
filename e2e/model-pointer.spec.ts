import { expect, test, type Locator, type Page } from './fixtures';
import { assertModelPointerContract } from '../src/lib/three/model-pointer';

async function dismissConsent(page: Page) {
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  const appeared = await bar.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true, () => false);
  if (!appeared) return;
  await bar.getByRole('button', { name: 'Reject all' }).click();
  await expect(bar).toBeHidden();
}

async function openProducts(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  await page.locator('[data-testid="products-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  const viewport = page.getByTestId('product-viewport').first();
  await expect(viewport.locator('.hint')).toHaveText('Drag to rotate', { timeout: 25_000 });
  await expect(viewport).toHaveAttribute('data-framed', '1', { timeout: 25_000 });
  return viewport;
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('viewport has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.beforeEach(async ({ page }) => {
  // 本地 next dev 的热更新要 eval，而站点 CSP 不含 unsafe-eval，客户端不会水合。
  // CI 用生产构建，不设这个变量，CSP 保持原样。
  if (process.env.E2E_RELAX_CSP !== '1') return;
  const client = await page.context().newCDPSession(page);
  await client.send('Page.setBypassCSP', { enabled: true });
});

test('legacy hover zoom fails the wheel contract and the focused policy passes', () => {
  assertModelPointerContract();
});

test('pointer capture, page wheel, modifier zoom, and release', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const first = await openProducts(page);
  const second = page.getByTestId('product-viewport').nth(1);
  await expect(second).toHaveAttribute('data-framed', '1', { timeout: 25_000 });
  await expect(page.locator('[data-direct-rotate]')).toHaveAttribute('data-direct-rotate', '1');
  const slugA = await first.getAttribute('data-slug');
  const slugB = await second.getAttribute('data-slug');
  expect(slugA && slugB && slugA !== slugB).toBe(true);

  const card = page.locator('article.card').first();
  const scale = await card.evaluate((el) => ({
    card: getComputedStyle(el).transform,
    stage: getComputedStyle(el.querySelector('[data-testid="product-viewport"]')!).transform,
  }));
  expect(scale.card === 'none' || scale.card.startsWith('matrix(1, 0, 0, 1')).toBe(true);
  expect(scale.stage === 'none' || scale.stage.startsWith('matrix(1, 0, 0, 1')).toBe(true);

  const distanceBeforeHover = await first.getAttribute('data-camera-distance');
  await first.hover();
  const hoverHeld = await first.evaluate(async (el) => {
    const start = el.getAttribute('data-camera-distance');
    const t0 = performance.now();
    while (performance.now() - t0 < 700) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      if (el.getAttribute('data-camera-distance') !== start) return false;
    }
    return true;
  });
  expect(hoverHeld).toBe(true);
  expect(await first.getAttribute('data-camera-distance')).toBe(distanceBeforeHover);
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', '');

  const azimuthA = await first.getAttribute('data-azimuth');
  const azimuthB = await second.getAttribute('data-azimuth');
  const start = await center(first);
  const other = await center(second);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', slugA!);
  await page.mouse.move(other.x, other.y, { steps: 16 });
  await expect(first).not.toHaveAttribute('data-azimuth', azimuthA!);
  await expect(second).toHaveAttribute('data-azimuth', azimuthB!);
  await expect(page).toHaveURL(/\/en\/products$/);
  await expect(first).not.toHaveClass(/\bactive\b/);
  const locked = await page.evaluate(() => ({
    body: document.body.style.overflow,
    touch: getComputedStyle(document.querySelector('[data-testid="product-viewport"]')!).touchAction,
  }));
  expect(locked.body).not.toBe('hidden');
  expect(locked.touch).toContain('pan-y');
  await page.mouse.up();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', '');

  await page.evaluate(() => window.scrollTo(0, 0));
  const plainDistance = await first.getAttribute('data-camera-distance');
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const back = await center(first);
  await page.mouse.move(back.x, back.y);
  await page.mouse.wheel(0, 480);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollBefore);
  await expect(first).toHaveAttribute('data-camera-distance', plainDistance!);

  await page.evaluate(() => window.scrollTo(0, 0));
  const cardB = page.locator('article.card').nth(1);
  const beforeButton = await second.getAttribute('data-camera-distance');
  await cardB.getByTestId('model-zoom-in').click();
  await expect(second).not.toHaveAttribute('data-camera-distance', beforeButton!);
  const minDistance = Number(await second.getAttribute('data-min-distance'));
  for (let step = 0; step < 18; step += 1) await cardB.getByTestId('model-zoom-in').click();
  const clamped = Number(await second.getAttribute('data-camera-distance'));
  expect(Math.abs(clamped - minDistance)).toBeLessThan(0.05);

  await first.focus();
  await expect(first).toHaveAttribute('data-focused', '1');
  const focusedDistance = Number(await first.getAttribute('data-camera-distance'));
  const scrollAtFocus = await page.evaluate(() => window.scrollY);
  await page.keyboard.down('Control');
  const focusedPoint = await center(first);
  await page.mouse.move(focusedPoint.x, focusedPoint.y);
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expect.poll(async () => Number(await first.getAttribute('data-camera-distance'))).not.toBe(focusedDistance);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollAtFocus);

  await page.keyboard.press('Escape');
  await expect(first).toHaveAttribute('data-focused', '0');
  await expect(page.locator('[data-focused-model]')).toHaveAttribute('data-focused-model', '');
  const afterEscape = await first.getAttribute('data-camera-distance');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -80);
  await page.keyboard.up('Control');
  await expect(first).toHaveAttribute('data-camera-distance', afterEscape!);

  const again = await center(first);
  await page.mouse.move(again.x, again.y);
  await page.mouse.down();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', slugA!);
  await first.dispatchEvent('pointercancel');
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', '');
  await page.mouse.up();

  await second.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(second).toHaveAttribute('data-focused', '0');
  const next = await center(second);
  await page.mouse.move(next.x, next.y);
  await page.mouse.down();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', slugB!);
  await page.mouse.up();

  await page.locator('[data-testid="home-link"]:visible').first().click();
  await expect(page).toHaveURL(/\/en$/);
  await page.locator('[data-testid="products-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  const returned = page.getByTestId('product-viewport').nth(1);
  await expect(returned).toHaveAttribute('data-framed', '1', { timeout: 25_000 });
  const returnedSlug = await returned.getAttribute('data-slug');
  const point = await center(returned);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', returnedSlug!);
  await page.mouse.up();
  await expect(page.locator('[data-capture-owner]')).toHaveAttribute('data-capture-owner', '');
});

test('hover pauses spin and a user pause survives hide and foreground', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const first = await openProducts(page);
  await expect(first).toHaveAttribute('data-spinning', '1');
  const moved = await first.evaluate(async (el) => {
    const start = el.getAttribute('data-azimuth');
    const t0 = performance.now();
    while (performance.now() - t0 < 500) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      if (el.getAttribute('data-azimuth') !== start) return true;
    }
    return false;
  });
  expect(moved).toBe(true);

  await first.hover();
  await expect(first).toHaveAttribute('data-spinning', '0');
  const held = await first.evaluate(async (el) => {
    const start = el.getAttribute('data-azimuth');
    const t0 = performance.now();
    while (performance.now() - t0 < 300) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      if (el.getAttribute('data-azimuth') !== start) return false;
    }
    return true;
  });
  expect(held).toBe(true);

  await page.locator('h1').hover();
  await expect(first).toHaveAttribute('data-spinning', '1');
  await page.locator('article.card').first().getByTestId('model-pause-rotation').click();
  await expect(first).toHaveAttribute('data-user-paused', '1');
  await expect(first).toHaveAttribute('data-spinning', '0');

  await page.mouse.move(8, 8);
  await page.mouse.wheel(0, 2400);
  await expect(first).not.toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(first).toBeInViewport();
  await expect(first).toHaveAttribute('data-user-paused', '1');
  await expect(first).toHaveAttribute('data-spinning', '0');

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(first).toHaveAttribute('data-spinning', '0');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(first).toHaveAttribute('data-user-paused', '1');
  await expect(first).toHaveAttribute('data-spinning', '0');
  const still = await first.evaluate(async (el) => {
    const start = el.getAttribute('data-azimuth');
    const t0 = performance.now();
    while (performance.now() - t0 < 300) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      if (el.getAttribute('data-azimuth') !== start) return false;
    }
    return el.getAttribute('data-user-paused') === '1';
  });
  expect(still).toBe(true);
});
