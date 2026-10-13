import { test, expect, consent } from './fixtures';

const tawk = (u: string) => /tawk\.to/.test(u);

test('同意前不加载 Tawk.to 和统计上报；同意后才加载 Tawk.to', async ({ page, external }) => {
  const rum: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/rum')) rum.push(r.url()); });
  await page.goto('/en');
  await page.mouse.move(200, 200); await page.keyboard.press('Tab'); await page.mouse.wheel(0, 600);
  await page.waitForTimeout(3500); // useTawk 在交互或空闲后才加载，留出时间确认它没有加载
  await page.goto('/en/products'); await page.waitForTimeout(1000);
  expect(external.urls.filter(tawk)).toEqual([]);
  expect(rum).toEqual([]);
  expect(await page.evaluate(() => Boolean(window.Tawk_API))).toBe(false);

  test.skip(!process.env.NEXT_PUBLIC_TAWK_PROPERTY_ID, '未配置 Tawk 测试 ID，跳过同意后加载检查');
  await consent(page, 'all');
  await page.mouse.move(300, 300); await page.mouse.wheel(0, 300);
  await expect.poll(() => external.urls.filter(tawk).length, { timeout: 10_000 }).toBeGreaterThan(0);
});

test('Cookie 同意条：拒绝后不加载第三方', async () => {
  test.fixme(true, 'Cookie 同意条（feat/cookie-consent）未合并到 main；合并后补 getByRole 用例');
});
