import { test, expect } from './fixtures';

// 头部语言切换按钮的可访问名称来自 messages 的 switchLang
const NAME = { RU: 'Русская версия', EN: 'English version' } as const;
const sw = (page: import('@playwright/test').Page, to: 'EN' | 'RU') => page.getByRole('banner').getByRole('link', { name: NAME[to] }).first();

test('语言切换 EN ↔ RU 保持当前页面', async ({ page }) => {
  for (const p of ['', '/products', '/contact', '/privacy']) {
    await page.goto(`/en${p}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await sw(page, 'RU').click();
    await expect(page).toHaveURL(new RegExp(`/ru${p}$`));
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await sw(page, 'EN').click();
    await expect(page).toHaveURL(new RegExp(`/en${p}$`));
  }
});

test('#124 回归：语言切换保留 #hash 和 ?query', async ({ page }) => {
  test.fixme(true, '#124 未修复（usePathname 丢掉 search/hash）；修复合并后去掉 fixme');
  await page.goto('/en/products#gift-boxes');
  await expect(sw(page, 'RU')).toHaveAttribute('href', '/ru/products#gift-boxes');
  await page.goto('/en/contact?from=quote');
  await expect(sw(page, 'RU')).toHaveAttribute('href', '/ru/contact?from=quote');
});
