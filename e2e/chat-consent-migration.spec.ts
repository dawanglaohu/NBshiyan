import { test, expect, type Page } from './fixtures';

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

async function rejectAnalytics(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('pj-consent', JSON.stringify({ v: 2, analytics: false, chat: false, ts: Date.now() }));
  });
}

async function openHumanContact(page: Page, width: number) {
  if (width < 768) await page.getByRole('button', { name: 'Quick actions' }).click();
  const entry = page.locator('#floating-human-contact');
  await expect(entry).toBeVisible();
  expectFlat(await flatStyle(page, '#floating-human-contact'), true);
  await entry.click();
  await expect(page).toHaveURL(/\/en\/contact$/);
}

async function flatStyle(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const c = getComputedStyle(el);
    return {
      borderTopWidth: c.borderTopWidth,
      borderTopStyle: c.borderTopStyle,
      borderTopColor: c.borderTopColor,
      borderRadius: c.borderTopLeftRadius,
      boxShadow: c.boxShadow,
      color: c.color,
      width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
    };
  });
}

function expectFlat(style: Awaited<ReturnType<typeof flatStyle>>, accent: boolean) {
  expect(style.borderTopWidth).toBe('2px');
  expect(style.borderTopStyle).toBe('solid');
  expect(style.borderTopColor).toBe('rgb(0, 0, 0)');
  expect(style.borderRadius).toBe('0px');
  expect(style.boxShadow).toBe('none');
  expect(style.color).toBe(accent ? 'rgb(180, 87, 0)' : 'rgb(0, 0, 0)');
  expect(style.width).toBeGreaterThanOrEqual(44);
  expect(style.height).toBeGreaterThanOrEqual(44);
}

for (const viewport of VIEWPORTS) {
  test(`拒分析：浮钮进联系页，聊天关闭时询盘和邮箱仍可点 @${viewport.width}`, async ({ page, external }) => {
    await page.setViewportSize(viewport);
    await rejectAnalytics(page);
    const app: string[] = [];
    page.on('request', (request) => app.push(request.url()));
    await page.goto('/en');
    await openHumanContact(page, viewport.width);
    expectFlat(await flatStyle(page, '#chat-availability'), true);
    expectFlat(await flatStyle(page, '#inquiry-email-entry'), true);

    const sw = page.locator('#chat-availability');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#chat-availability-desc')).toHaveText(/Independent chat is off/);
    await sw.focus();
    await expect(sw).toBeFocused();
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#chat-availability-desc')).toHaveText(/does not load a third-party script/);
    const onFill = await sw.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(onFill).toBe('rgb(180, 87, 0)');
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'false');

    const email = page.locator('#inquiry-email-entry');
    await email.focus();
    await expect(email).toBeFocused();
    await email.click();
    await expect(page).toHaveURL(/\/en\/contact#iq-email$/);
    const submit = page.locator('form button[type="submit"]');
    await expect(submit).toBeEnabled();
    await submit.click({ trial: true });

    const watched = [...external.urls, ...app];
    expect(watched.filter((url) => /tawk\.to|\/api\/analytics|\/api\/rum/i.test(url))).toEqual([]);
    await expect(page.locator('script[src*="tawk.to"], iframe[src*="tawk.to"]')).toHaveCount(0);
    const stored = await page.evaluate(() => ({
      keys: Object.keys(localStorage),
      cookies: document.cookie,
      tawk: Boolean((window as unknown as { Tawk_API?: unknown }).Tawk_API),
    }));
    expect(stored.tawk).toBe(false);
    expect(stored.keys.filter((key) => /analytics|tawk|^_ga|gid/i.test(key))).toEqual([]);
    expect(stored.cookies).not.toMatch(/analytics|tawk/i);
  });
}

test('页脚隐私政策：必要联系、期限和未启用清理，且无分析请求', async ({ page, external }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await rejectAnalytics(page);
  const app: string[] = [];
  page.on('request', (request) => app.push(request.url()));
  await page.goto('/en/contact');
  await page.locator('#privacy-link').click();
  await expect(page).toHaveURL(/\/en\/privacy$/);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'Necessary human contact' })).toBeVisible();
  await expect(main).toContainText('7 days of inactivity and 30 days from the start');
  await expect(main).toContainText('90-day design default');
  await expect(main).toContainText('Real cleanup of that content is not enabled');
  await expect(main).toContainText('Inquiry retention is unchanged');
  await expect(main).toContainText('is not a measurement of capacity available now');
  await expect(main).toContainText('does not buy extra capacity on its own');
  await expect(main).toContainText('Inquiries are anonymized 2 years after the last activity');
  await expect(main).toContainText('does not load Tawk.to');

  await page.locator('#cookie-settings-link').click();
  const dialog = page.getByRole('dialog', { name: 'Cookie settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-consent-category="human-contact"]')).toContainText('Necessary human contact');
  await expect(dialog.locator('[data-consent-category="analytics"]')).toContainText('Optional analytics');
  await expect(dialog.getByRole('switch', { name: 'Optional analytics' })).toBeVisible();
  await expect(dialog).not.toContainText('Tawk');
  await dialog.getByRole('button', { name: 'Close' }).click();

  expect([...external.urls, ...app].filter((url) => /tawk\.to|\/api\/analytics|\/api\/rum/i.test(url))).toEqual([]);
});

test('俄语隐私页说明同一边界', async ({ page, external }) => {
  await rejectAnalytics(page);
  await page.goto('/ru/privacy');
  const main = page.locator('main');
  await expect(main).toContainText('не является измерением ёмкости');
  await expect(main).toContainText('Реальная очистка этого текста не включена');
  await expect(main).toContainText('7 суток без действия и 30 суток с начала');
  await expect(main).toContainText('90 суток');
  await expect(main).toContainText('Хранение запросов не меняется');
  expect(external.urls.filter((url) => /tawk\.to|\/api\/analytics/i.test(url))).toEqual([]);
});
