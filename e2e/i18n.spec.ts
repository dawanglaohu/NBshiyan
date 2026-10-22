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

for (const [loc, cur, other] of [['en', 'English', 'Русский'], ['ru', 'Русский', 'English']] as const) {
  test(`下拉键盘 (${loc})：Enter/Space 打开并聚焦当前语言项，↑↓ 移动，Esc 关闭并还焦点`, async ({ page }) => {
    await page.goto(`/${loc}/contact`);
    const banner = page.getByRole('banner');
    const btn = banner.getByRole('button', { name: cur });
    for (const key of ['Enter', ' '] as const) {
      await btn.focus();
      await page.keyboard.press(key);
      await expect(btn).toHaveAttribute('aria-expanded', 'true');
      await expect(banner.getByRole('menuitem', { name: cur })).toBeFocused();
      await expect(banner.getByRole('menuitem', { name: cur })).toHaveAttribute('aria-current', 'true');
      await page.keyboard.press('ArrowDown');
      await expect(banner.getByRole('menuitem', { name: other })).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(banner.getByRole('menuitem', { name: cur })).toBeFocused();
      await page.keyboard.press('ArrowUp'); // 循环到最后一项
      await expect(banner.getByRole('menuitem', { name: other })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(btn).toHaveAttribute('aria-expanded', 'false');
      await expect(btn).toBeFocused();
    }
  });

  test(`下拉 (${loc})：点外面关闭并把焦点还给按钮；每项 lang 正确`, async ({ page }) => {
    await page.goto(`/${loc}/contact`);
    const banner = page.getByRole('banner');
    const btn = banner.getByRole('button', { name: cur });
    await btn.click();
    await expect(banner.getByRole('menuitem', { name: 'English' })).toHaveAttribute('lang', 'en');
    await expect(banner.getByRole('menuitem', { name: 'Русский' })).toHaveAttribute('lang', 'ru');
    await page.locator('main h1').first().click();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(btn).toBeFocused();
  });
}

test('未发布语言 404 页：下拉各项指向对应语言首页', async ({ page }) => {
  const res = await page.goto('/ja/products');
  expect(res?.status()).toBe(404);
  const banner = page.getByRole('banner');
  await banner.getByRole('button', { name: 'English' }).click();
  await expect(banner.getByRole('menuitem', { name: 'English' })).toHaveAttribute('href', '/en');
  await expect(banner.getByRole('menuitem', { name: 'Русский' })).toHaveAttribute('href', '/ru');
});

test('#124 回归：语言切换保留 #hash 和 ?query', async ({ page }) => {
  test.fixme(true, '#124 未修复（usePathname 丢掉 search/hash）；修复合并后去掉 fixme');
  await page.goto('/en/products#gift-boxes');
  await page.getByRole('banner').getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('menuitem', { name: 'Русский' })).toHaveAttribute('href', '/ru/products#gift-boxes');
});
