import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures';

const visuals = JSON.parse(readFileSync('docs/brand-content/company-visuals.json', 'utf8')) as {
  artworks: { alt: { en: string; ru: string }; web: { path: string; sha256: string; width: number; height: number } }[];
};
const plate = visuals.artworks[0];
const webPath = `/${String(plate.web.path).replace(/^public\//, '')}`;

async function dismissConsent(page: Page) {
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  if (await bar.isVisible().catch(() => false)) {
    await bar.getByRole('button', { name: 'Reject all' }).click();
    await expect(bar).toBeHidden();
  }
}

test('footer contact and privacy stay on the same page across en and ru', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
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

test('home summary publishes the company plate, and about follows the existing switch', async ({ page }) => {
  const seen: string[] = [];
  page.on('request', (request) => seen.push(new URL(request.url()).pathname));
  const enHtml = await (await page.request.get('/en')).text();
  const ruHtml = await (await page.request.get('/ru')).text();
  expect(enHtml).toContain(webPath);
  expect(enHtml).toContain('PackJoyU works from its own factory.');
  expect(enHtml).toContain(plate.alt.en);
  expect(ruHtml).toContain('PackJoyU работает на своей фабрике.');
  expect(ruHtml).toContain(plate.alt.ru);
  expect(enHtml.toLowerCase()).not.toContain('yuhao');
  expect(ruHtml.toLowerCase()).not.toContain('yuhao');

  const enAbout = await page.request.get('/en/about');
  const ruAbout = await page.request.get('/ru/about');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en');
  await dismissConsent(page);
  if (enAbout.status() === 404) {
    expect(ruAbout.status()).toBe(404);
    await expect(page.getByTestId('about-link')).toHaveCount(0);
  } else {
    expect(enAbout.status()).toBe(200);
    expect(ruAbout.status()).toBe(200);
    const openHtml = await enAbout.text();
    expect(openHtml).toContain(webPath);
    expect(openHtml).toContain(plate.alt.en);
    expect(openHtml.toLowerCase()).not.toContain('yuhao');
    await page.getByTestId('about-link').click();
    await expect(page).toHaveURL(/\/en\/about$/);
    await expect(page.getByTestId('company-artwork')).toBeVisible();
    await page.locator('footer').getByRole('link', { name: 'Русский', exact: true }).click();
    await expect(page).toHaveURL(/\/ru\/about$/);
  }

  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/en');
    await dismissConsent(page);
    const img = page.getByTestId('company-artwork');
    await img.scrollIntoViewIfNeeded();
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(plate.web.width);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(plate.web.height);
    const box = await img.evaluate((el: HTMLImageElement) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        fit: style.objectFit,
        width: rect.width,
        height: rect.height,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(box.fit).toBe('contain');
    expect(box.overflow).toBeLessThanOrEqual(1);
    expect(box.width).toBeGreaterThan(40);
    expect(Math.abs(box.width / box.height - plate.web.width / plate.web.height)).toBeLessThan(0.03);
  }

  expect(seen).toContain(webPath);
  expect(seen.filter((path) => path.endsWith('.gif'))).toEqual([]);
  const bytes = await (await page.request.get(webPath)).body();
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(plate.web.sha256);
});
