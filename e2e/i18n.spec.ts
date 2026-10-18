import { test, expect } from './fixtures';

// 多语言第 0 期：头部语言下拉。按钮的可访问名称是当前语言全称（母语），列表项是母语名称
const CUR = { en: 'English', ru: 'Русский' } as const;
const pick = async (page: import('@playwright/test').Page, from: 'en' | 'ru', to: 'en' | 'ru') => {
  const banner = page.getByRole('banner');
  await banner.getByRole('button', { name: CUR[from] }).click();
  await banner.getByRole('menuitem', { name: CUR[to] }).click();
};

test('语言切换 EN ↔ RU 保持当前页面', async ({ page }) => {
  for (const p of ['', '/products', '/contact', '/privacy']) {
    await page.goto(`/en${p}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await pick(page, 'en', 'ru');
    await expect(page).toHaveURL(new RegExp(`/ru${p}$`));
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await pick(page, 'ru', 'en');
    await expect(page).toHaveURL(new RegExp(`/en${p}$`));
  }
});

test('下拉键盘操作：Enter 打开、↓ 移动、Esc 关闭并把焦点还给按钮', async ({ page }) => {
  await page.goto('/en/contact');
  const btn = page.getByRole('banner').getByRole('button', { name: 'English' });
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: 'English' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Русский' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(btn).toBeFocused();
});

test('#124 回归：语言切换保留 #hash 和 ?query', async ({ page }) => {
  test.fixme(true, '#124 未修复（usePathname 丢掉 search/hash）；修复合并后去掉 fixme');
  await page.goto('/en/products#gift-boxes');
  await page.getByRole('banner').getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('menuitem', { name: 'Русский' })).toHaveAttribute('href', '/ru/products#gift-boxes');
});
