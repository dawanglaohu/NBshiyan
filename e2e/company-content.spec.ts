import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';
import { expect, test, type APIRequestContext, type Page } from './fixtures';

const CROP_WIDTHS = [480, 960, 1440];
const FULL_WIDTHS = [800, 1600, 2400];
const ALT = {
  en: 'PackJoyU conceptual illustrations of custom packaging and printed products',
  ru: 'Условные иллюстрации PackJoyU: упаковка и печатная продукция на заказ',
};
const BODY_HTML = `<p>${'Sample text for the about page. '.repeat(4)}</p>`;
const KEYS = ['about.enabled', 'about.en', 'about.ru'] as const;

function ensureDatabaseUrl() {
  if (process.env.DATABASE_URL) return;
  let text = '';
  try {
    text = readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  } catch {
    throw new Error('DATABASE_URL is not set');
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    if (key !== 'DATABASE_URL') continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env.DATABASE_URL = value;
    return;
  }
  throw new Error('DATABASE_URL is not set');
}

function imageIds(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) return [];
  return value.items.flatMap((item) => {
    if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string') return [];
    return /^[A-Za-z0-9]{24}$/.test(item.id) ? [item.id] : [];
  });
}

function pickWidth(widths: number[], need: number): number {
  const sorted = [...widths].sort((a, b) => a - b);
  return sorted.find((width) => width >= need) ?? sorted[sorted.length - 1];
}

async function revalidate(request: APIRequestContext) {
  const response = await request.post('/api/e2e/revalidate-site-settings');
  expect(response.status()).toBe(204);
}

async function waitText(request: APIRequestContext, path: string, needle: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = await (await request.get(path)).text();
    if (text.includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${path} did not include the published company entry`);
}

async function waitStatus(request: APIRequestContext, path: string, status: number) {
  const deadline = Date.now() + 20_000;
  let last = 0;
  while (Date.now() < deadline) {
    last = (await request.get(path)).status();
    if (last === status) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${path} stayed ${last}, wanted ${status}`);
}

async function preparePage(page: Page, viewport: { width: number; height: number }) {
  await page.addInitScript(() => {
    localStorage.setItem('pj-consent', JSON.stringify({ v: 2, analytics: false, chat: false, ts: Date.now() }));
    const target = window as Window & { __cls?: number };
    target.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!shift.hadRecentInput) target.__cls = (target.__cls ?? 0) + (shift.value ?? 0);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.setViewportSize(viewport);
}

test('footer contact and privacy stay on the same page across en and ru', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  if (await bar.isVisible().catch(() => false)) {
    await bar.getByRole('button', { name: 'Reject all' }).click();
    await expect(bar).toBeHidden();
  }
  await page.locator('#footer-contact-link').click();
  await expect(page).toHaveURL(/\/en\/contact$/);
  await expect(page.locator('main h1')).toBeVisible();
  await page.locator('footer').getByRole('link', { name: 'Русский', exact: true }).click();
  await expect(page).toHaveURL(/\/ru\/contact$/);
  await expect(page.locator('main h1')).toBeVisible();
  await page.locator('#privacy-link').click();
  await expect(page).toHaveURL(/\/ru\/privacy$/);
  await expect(page.locator('main h1')).toBeVisible();
  await page.locator('footer').getByRole('link', { name: 'English', exact: true }).click();
  await expect(page).toHaveURL(/\/en\/privacy$/);
  await expect(page.locator('main h1')).toBeVisible();
});

test.describe('company plate derivatives', () => {
  test.describe.configure({ mode: 'serial', timeout: 90_000 });
  let db: PrismaClient;
  let previous: { key: string; value: Prisma.JsonValue | null }[] = [];
  let restored = false;

  async function writeRow(key: string, value: Prisma.JsonValue | null) {
    if (value === null) {
      await db.siteSetting.deleteMany({ where: { key } });
      return;
    }
    await db.siteSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async function restore(request: APIRequestContext) {
    if (restored || !db) return;
    restored = true;
    for (const row of previous) await writeRow(row.key, row.value);
    await revalidate(request);
  }

  test.beforeAll(async ({ request }) => {
    ensureDatabaseUrl();
    db = new PrismaClient();
    const rows = await db.siteSetting.findMany({ where: { key: { in: [...KEYS, 'about.images'] } } });
    previous = KEYS.map((key) => ({ key, value: rows.find((row) => row.key === key)?.value ?? null }));
    const ids = imageIds(rows.find((row) => row.key === 'about.images')?.value);
    const imageMeta = Object.fromEntries(ids.map((id) => [id, { alt: 'Packaging', caption: '' }]));
    const content = {
      version: 1,
      title: 'About PackJoyU',
      summary: '',
      bodyHtml: BODY_HTML,
      stats: [],
      home: { title: '', intro: '' },
      imageMeta,
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    };
    await writeRow('about.en', content);
    await writeRow('about.ru', content);
    await writeRow('about.enabled', { enabled: true, version: 1, updatedAt: new Date().toISOString(), updatedBy: null });
    await revalidate(request);
    await waitStatus(request, '/en/about', 200);
    await waitStatus(request, '/ru/about', 200);
    await waitText(request, '/en', 'Company page');
    await waitText(request, '/ru', 'Страница компании');
  });

  test.afterAll(async ({ request }) => {
    try {
      await restore(request);
    } finally {
      await db?.$disconnect();
    }
  });

  for (const spec of [
    { name: 'home en 390', path: '/en', width: 390, height: 844, kind: 'crop' as const, slot: 'narrow' as const },
    { name: 'home ru 390', path: '/ru', width: 390, height: 844, kind: 'crop' as const, slot: 'narrow' as const },
    { name: 'home en 1440', path: '/en', width: 1440, height: 900, kind: 'crop' as const, slot: 'wide' as const },
    { name: 'about en 390', path: '/en/about', width: 390, height: 844, kind: 'crop' as const, slot: 'source' as const },
    { name: 'about ru 390', path: '/ru/about', width: 390, height: 844, kind: 'crop' as const, slot: 'narrow' as const },
    { name: 'about en 1440', path: '/en/about', width: 1440, height: 900, kind: 'full' as const, slot: 'wide' as const },
  ]) {
    test(`${spec.name} selects the expected plate and keeps the first screen stable`, async ({ page }) => {
      await preparePage(page, { width: spec.width, height: spec.height });
      await page.goto(spec.path);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))));
      });
      const cls = await page.evaluate(() => (window as Window & { __cls?: number }).__cls ?? 0);
      expect(cls).toBeLessThan(0.05);

      const html = await (await page.request.get(spec.path)).text();
      const locale = spec.path.includes('/ru') ? 'ru' : 'en';
      expect(html).toContain(ALT[locale]);
      expect(html.toLowerCase()).not.toContain('yuhao');
      const fullInHtml = spec.path === '/en/about';
      if (fullInHtml) {
        expect(html).toContain('company-introduction-v3-en-w800.');
        expect(html).toContain('company-introduction-v3-en-crop-480.');
      } else {
        expect(html).not.toContain('company-introduction-v3-en-w');
        expect(html).not.toContain('company-introduction-v3-en.png');
        expect(html).toContain('company-introduction-v3-en-crop-480.');
      }
      if (locale === 'en') expect(html).toContain('PackJoyU works from its own factory.');
      if (locale === 'ru') expect(html).toContain('PackJoyU работает на своей фабрике.');

      const summary = page.getByTestId('company-summary');
      await expect(summary.locator('picture')).toHaveCount(spec.path === '/en/about' ? 1 : 0);
      if (spec.path === '/en' || spec.path === '/ru') {
        await expect(page.locator('main a[href$="/about"]')).toHaveCount(1);
        await expect(page.locator('#ab-home-h')).toHaveCount(0);
        await expect(page.locator('main')).not.toContainText(locale === 'ru' ? 'Подробнее о компании' : 'Learn more about us');
        await expect(page.getByTestId('about-link')).toHaveCount(1);
      }

      const img = page.getByTestId('company-artwork');
      await img.scrollIntoViewIfNeeded();
      await expect(img).toBeVisible();
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      const slot = spec.slot === 'wide' ? spec.width * 0.45 : spec.width;
      const expected = pickWidth(spec.kind === 'full' ? FULL_WIDTHS : CROP_WIDTHS, slot * dpr);
      const marker = spec.kind === 'full'
        ? `/brand/company/company-introduction-v3-en-w${expected}.`
        : `/brand/company/company-introduction-v3-en-crop-${expected}.`;
      await expect.poll(async () => {
        const current = await img.evaluate((el) => (el as HTMLImageElement).currentSrc);
        return current ? new URL(current).pathname : '';
      }).toContain(marker);
    });
  }

  test('a closed switch returns 404 and removes about links', async ({ page, request }) => {
    await writeRow('about.enabled', { enabled: false, version: 1, updatedAt: new Date().toISOString(), updatedBy: null });
    await revalidate(request);
    await waitStatus(request, '/en/about', 404);
    await waitStatus(request, '/ru/about', 404);
    await preparePage(page, { width: 1440, height: 900 });
    await page.goto('/en');
    await expect(page.getByTestId('about-link')).toHaveCount(0);
    await expect(page.locator('main a[href$="/about"]')).toHaveCount(0);
    await expect(page.locator('footer a[href$="/about"]')).toHaveCount(0);
    await page.goto('/ru');
    await expect(page.getByTestId('about-link')).toHaveCount(0);
    await expect(page.locator('main a[href$="/about"]')).toHaveCount(0);
    await expect(page.locator('footer a[href$="/about"]')).toHaveCount(0);
  });
});
