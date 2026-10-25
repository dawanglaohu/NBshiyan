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
      await expect(page).toHaveTitle(item.title);
    });
  }
});
