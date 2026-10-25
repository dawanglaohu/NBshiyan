import { test, expect } from './fixtures';
import { isThirdPartyChatUrl, thirdPartyChatDomSelector } from './third-party-chat';

test.describe('同意前不加载统计上报', () => {
  test('不加载任何第三方聊天和同意前不上报统计', async ({ page, external }) => {
    const rum: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/rum')) rum.push(r.url()); });
    await page.goto('/en');
    await page.mouse.move(200, 200); await page.keyboard.press('Tab'); await page.mouse.wheel(0, 600);
    await page.waitForTimeout(3500);
    await page.goto('/en/products'); await page.waitForTimeout(1000);
    expect(external.urls.filter(isThirdPartyChatUrl)).toEqual([]);
    expect(rum).toEqual([]);
    expect(await page.evaluate(() => Boolean((window as unknown as { Tawk_API?: unknown }).Tawk_API))).toBe(false);
    await expect(page.locator(thirdPartyChatDomSelector())).toHaveCount(0);

    await page.getByRole('button', { name: 'Accept all' }).click();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pj-consent') ?? 'null'));
    expect(stored).toMatchObject({ v: 2, analytics: true, chat: false });
    await page.mouse.move(300, 300); await page.mouse.wheel(0, 300);
    await page.waitForTimeout(3500);
    expect(external.urls.filter(isThirdPartyChatUrl)).toEqual([]);
    expect(await page.evaluate(() => Boolean((window as unknown as { Tawk_API?: unknown }).Tawk_API))).toBe(false);
  });
});

test('Cookie 同意条：拒绝后不加载第三方，刷新后不再出现', async ({ page, external }) => {
  const rum: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/rum')) rum.push(r.url()); });
  await page.goto('/en');
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  await expect(bar).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __stay?: number }).__stay = 1; });
  await bar.getByRole('button', { name: 'Reject all' }).click();
  await expect(bar).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __stay?: number }).__stay)).toBe(1);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pj-consent') ?? 'null'));
  expect(stored).toMatchObject({ v: 2, analytics: false, chat: false });

  await page.mouse.move(200, 200); await page.mouse.wheel(0, 600);
  await page.waitForTimeout(3500);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Cookie consent' })).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(external.urls.filter(isThirdPartyChatUrl)).toEqual([]);
  expect(rum).toEqual([]);
  expect(await page.evaluate(() => Boolean((window as unknown as { Tawk_API?: unknown }).Tawk_API))).toBe(false);
});

// #183：手机 390px 下 Cookie 条不能盖住页脚最后一行。前端合并 #183/#184 的 PR 后去掉 fixme。
test.fixme('Cookie 同意条：390px 下页脚最后一行不被遮挡（#183）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en');
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  await expect(bar).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const footer = page.getByRole('contentinfo');
  const links = footer.getByRole('link');
  const last = links.last();
  await expect(last).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  const lastBox = (await last.boundingBox())!;
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(barBox.y);
  await last.click({ trial: true }); // 能点到，没被盖住
});

// #184：Cookie 条按钮和隐私链接点击区域高度不小于 44px。
test.fixme('Cookie 同意条：按钮和隐私链接高度不小于 44px（#184）', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en');
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  await expect(bar).toBeVisible();
  const targets = [...(await bar.getByRole('button').all()), ...(await bar.getByRole('link').all())];
  expect(targets.length).toBeGreaterThan(0);
  for (const t of targets) {
    const box = (await t.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});
