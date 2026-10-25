import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

// notFound() 插入唯一的 <meta name="robots" content="noindex">。
// 本地化 404 不再声明 robots，否则会多出第二条。标题仍是 NotFound.meta.title。
const cases = [
  { path: '/en/does-not-exist-seo5', title: 'Page not found | PackJoyU' },
  { path: '/ru/does-not-exist-seo5', title: 'Страница не найдена | PackJoyU' },
  { path: '/en/products/zzz-not-a-category', title: 'Page not found | PackJoyU' },
];

test.describe('404 robots meta (#429)', () => {
  for (const item of cases) {
    test(`${item.path} 恰好 1 个 robots meta，状态 404，标题不变`, async ({ page }) => {
      const res = await page.goto(item.path);
      expect(res!.status()).toBe(404);
      expect(new URL(page.url()).pathname).toBe(item.path);
      const robots = page.locator('meta[name="robots"]');
      await expect(robots).toHaveCount(1);
      await expect(robots).toHaveAttribute('content', 'noindex');
      const html = await res!.text();
      expect(html).toContain(`<title>${item.title}</title>`);
      expect(titleTags(html)).toEqual([item.title]);
    });
  }

  // 未上线语言 rewrite 到 locale-unavailable 后，Next 会在 head 和客户端渲染各插一次 noindex（框架行为），所以渲染后 DOM 不限条数，只要求都是 noindex。
  test('/de 语言未上线：状态 404，原始 HTML 恰好 1 条 robots 为 noindex', async ({ page }) => {
    const res = await page.goto('/de');
    expect(res!.status()).toBe(404);
    const html = await res!.text();
    const robotsTags = html.match(/<meta name="robots"[^>]*>/g) ?? [];
    expect(robotsTags).toHaveLength(1);
    expect(robotsTags[0]).toContain('content="noindex"');
    expect(html).toContain('<title>Page not found | PackJoyU</title>');
    expect(titleTags(html)).toEqual(['Page not found | PackJoyU']);
    const contents = await page.locator('meta[name="robots"]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('content') ?? ''),
    );
    expect(contents.length).toBeGreaterThanOrEqual(1);
    for (const content of contents) {
      expect(content).toContain('noindex');
      expect(content).not.toMatch(/(^|[\s,])index\b/);
      expect(content).not.toMatch(/\bfollow\b/);
    }
  });
});

// 渲染后 document.title 必须是 404 标题。普通未知路径水合后会落到首页标题；未上线语言 /de 也要锁住，避免只守住一边。
const titleCases = [
  ...cases,
  { path: '/de', title: 'Page not found | PackJoyU' },
];

const HOME_TITLES = [
  'Custom Packaging Supplier: Boxes & Cups | PackJoyU',
  'Упаковка на заказ: коробки, стаканы, печать | PackJoyU',
];

const CATEGORY_PAGE_TITLE = 'Custom Packaging Products in 3D: Boxes & Cups | PackJoyU';

function titleTags(html: string): string[] {
  return [...html.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1]);
}

async function headTitles(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.head.querySelectorAll('title')].map((node) => node.textContent ?? ''));
}

test.describe('404 渲染后 document.title 是 404 标题', () => {
  for (const item of titleCases) {
    test(`${item.path} 加载后以及轮询结束后都是 404 标题`, async ({ page }) => {
      const samples: string[] = [];
      const res = await page.goto(item.path, { waitUntil: 'commit' });
      expect(res!.status()).toBe(404);
      for (let i = 0; i < 6; i++) {
        samples.push(await page.title());
        await page.waitForTimeout(40);
      }
      await page.waitForLoadState('load');
      const atLoad = await page.title();
      expect(atLoad).toBe(item.title);
      samples.push(atLoad);
      expect(await headTitles(page)).toEqual([item.title]);
      const until = Date.now() + 5500;
      while (Date.now() < until) {
        samples.push(await page.title());
        await page.waitForTimeout(200);
      }
      expect(await page.title()).toBe(item.title);
      expect(await headTitles(page)).toEqual([item.title]);
      const homeFrames = samples.filter((title) => HOME_TITLES.includes(title)).length;
      expect(homeFrames).toBeLessThanOrEqual(2);
    });

    test(`${item.path} 改掉 document.title 后 1 秒内写回`, async ({ page }) => {
      const res = await page.goto(item.path);
      expect(res!.status()).toBe(404);
      await expect(page).toHaveTitle(item.title);
      await page.evaluate(() => { document.title = 'not-the-404-title'; });
      await expect.poll(async () => page.title(), { timeout: 1000 }).toBe(item.title);
    });
  }

  test('离开 /en 404 后标题不再锁住，后退和前进跟着历史走', async ({ page }) => {
    const notFound = 'Page not found | PackJoyU';
    const res = await page.goto('/en/does-not-exist-seo5');
    expect(res!.status()).toBe(404);
    await expect(page).toHaveTitle(notFound);
    await page.locator('.nf-grid a').first().click();
    await page.waitForURL(/\/en\/products/);
    expect(await page.title()).not.toBe(notFound);
    await page.waitForTimeout(1000);
    expect(await page.title()).toBe(CATEGORY_PAGE_TITLE);
    await page.goBack();
    await expect(page).toHaveTitle(notFound);
    await page.goForward();
    await expect(page).toHaveTitle(CATEGORY_PAGE_TITLE);
  });
});
