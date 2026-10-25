import { expect, test, type Page } from './fixtures';

async function dismissConsent(page: Page) {
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  if (await bar.isVisible().catch(() => false)) {
    await bar.getByRole('button', { name: 'Reject all' }).click();
    await expect(bar).toBeHidden();
  }
}

function clampViewport(viewportWidth: number) {
  return Math.min(440, Math.max(360, viewportWidth * 0.28));
}

async function cardBox(page: Page) {
  return page.locator('article.card').first().evaluate((card) => {
    const stage = card.querySelector('[data-testid="product-viewport"]');
    if (!stage) throw new Error('viewport missing');
    const cardRect = card.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const name = card.querySelector('h2');
    const spec = card.querySelector('.specs');
    const nameStyle = name ? getComputedStyle(name) : null;
    const specStyle = spec ? getComputedStyle(spec) : null;
    return {
      cardWidth: cardRect.width,
      viewportHeight: stageRect.height,
      viewportWidth: stageRect.width,
      nameSize: nameStyle?.fontSize ?? '',
      nameLine: nameStyle?.lineHeight ?? '',
      specSize: specStyle?.fontSize ?? '',
      specLine: specStyle?.lineHeight ?? '',
      specColor: specStyle?.color ?? '',
      viewportInLink: !!stage.closest('a'),
      descCount: card.querySelectorAll('.desc').length,
    };
  });
}

test('products-link opens the server catalog, large cards, and the real model file', async ({ page }) => {
  test.setTimeout(60_000);
  const seen: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/models' || path.endsWith('.glb') || /^\/api\/models\/[^/]+\//.test(path)) {
      seen.push(`${request.method()} ${path}`);
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  await page.locator('[data-testid="products-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  const ssr = await page.request.get('/en/products');
  expect(ssr.status()).toBe(200);
  const html = await ssr.text();
  expect((html.match(/<article[^>]*class="card/g) ?? []).length).toBeGreaterThanOrEqual(12);
  expect(html).toMatch(/\/models\/[^"'\\\s]+\.glb|\/api\/models\/[^"'\\\s]+\/glb/);
  expect(html).not.toContain('class="desc"');
  await expect(page.locator('main article.card').first()).toBeVisible();

  const desktop = await cardBox(page);
  expect(desktop.cardWidth).toBeGreaterThanOrEqual(560);
  expect(desktop.viewportHeight).toBeGreaterThanOrEqual(clampViewport(1440) - 1);
  expect(desktop.viewportHeight).toBeLessThanOrEqual(clampViewport(1440) + 1);
  expect(desktop.nameSize).toBe('24px');
  expect(desktop.nameLine).toBe('28px');
  expect(desktop.specSize).toBe('16px');
  expect(desktop.specLine).toBe('24px');
  expect(desktop.specColor).toBe('rgb(0, 0, 0)');
  expect(desktop.viewportInLink).toBe(false);
  expect(desktop.descCount).toBe(0);
  const first = page.locator('article.card').first();
  await expect(first.getByTestId('product-name-link')).toBeVisible();
  await expect(first.getByTestId('category-link')).toBeVisible();
  await expect(first.getByRole('button', { name: 'Add to quote' })).toBeVisible();
  await expect(first.locator('.specs li').first()).toBeVisible();

  await page.setViewportSize({ width: 1920, height: 1080 });
  const wide = await cardBox(page);
  expect(wide.cardWidth).toBeGreaterThanOrEqual(560);
  expect(wide.viewportHeight).toBeGreaterThanOrEqual(clampViewport(1920) - 1);
  expect(wide.viewportHeight).toBeLessThanOrEqual(clampViewport(1920) + 1);

  const viewport = page.getByTestId('product-viewport').first();
  const box = await viewport.boundingBox();
  if (!box) throw new Error('viewport box missing');
  await page.mouse.move(box.x + 48, box.y + 48);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\/en\/products$/);
  await expect(first.getByRole('button', { name: 'Add to quote' })).toBeVisible();
  expect(seen.filter((hit) => hit === 'GET /api/models')).toEqual([]);
  await expect.poll(() => seen.some((hit) => hit.startsWith('GET ') && hit !== 'GET /api/models'), { timeout: 25_000 }).toBe(true);

  const href = await first.getByTestId('category-link').getAttribute('href');
  expect(href).toMatch(/\/products#corrugated-boxes$/);
  const blocked = await page.request.get('/en/products/custom-corrugated-boxes');
  expect(blocked.status()).toBe(404);
  await first.getByTestId('category-link').click();
  await expect(page).toHaveURL(/\/en\/products#corrugated-boxes$/);
  await expect(page.locator('#corrugated-boxes')).toBeVisible();

  const api = await page.request.get('/api/models');
  expect(api.status()).toBe(200);
  expect(api.headers()['cache-control']).toContain('max-age=60');
  const body = await api.json() as { items: unknown };
  expect(Array.isArray(body.items)).toBe(true);
  expect(seen.filter((hit) => hit === 'GET /api/models')).toEqual([]);
});

test('a 390px products entry does not overflow and keeps the name, specs, and inquiry control', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en');
  await dismissConsent(page);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('[data-testid="products-link"]:visible').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  const narrow = await cardBox(page);
  expect(narrow.cardWidth).toBeLessThanOrEqual(390);
  expect(narrow.viewportWidth).toBeLessThanOrEqual(390);
  expect(narrow.viewportHeight).toBeGreaterThanOrEqual(240);
  const ratio = narrow.viewportWidth / narrow.viewportHeight;
  expect(ratio).toBeGreaterThan(1.2);
  expect(ratio).toBeLessThan(1.5);
  expect(narrow.nameSize).toBe('20px');
  expect(narrow.nameLine).toBe('24px');
  expect(narrow.descCount).toBe(0);
  const first = page.locator('article.card').first();
  await expect(first.getByTestId('product-name-link')).toBeVisible();
  await expect(first.locator('.specs li').first()).toBeVisible();
  await expect(first.getByRole('button', { name: 'Add to quote' })).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
});

const liveOrigin = process.env.M2_LIVE_ORIGIN;
if (liveOrigin) {
  test('category-link opens the published shell and returns to the 3D catalog', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${liveOrigin}/en`);
    await dismissConsent(page);
    await page.locator('[data-testid="products-link"]:visible').click();
    await expect(page).toHaveURL(/\/en\/products$/);
    const link = page.locator('article.card').first().getByTestId('category-link');
    await expect(link).toHaveAttribute('href', /\/products\/custom-corrugated-boxes$/);
    await link.click();
    await expect(page).toHaveURL(/\/en\/products\/custom-corrugated-boxes$/);
    await expect(page.locator('main h1')).toHaveText('Corrugated Boxes');
    await expect(page.getByTestId('product-viewport')).toHaveCount(0);
    await page.getByTestId('catalog-return-link').click();
    await expect(page).toHaveURL(/\/en\/products/);
    await expect(page.getByTestId('product-viewport').first()).toBeVisible();
  });
}
