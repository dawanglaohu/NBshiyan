import { test, expect, type Page } from './fixtures';
import { expectEmailFieldClearOfHeader } from './email-field';
import { isThirdPartyChatUrl, thirdPartyChatDomSelector } from './third-party-chat';

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

async function fabPaint(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const c = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      borderTopWidth: c.borderTopWidth,
      borderRadius: c.borderTopLeftRadius,
      backgroundColor: c.backgroundColor,
      color: c.color,
      boxShadow: c.boxShadow,
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  });
}

async function openHumanContact(page: Page, width: number) {
  if (width < 768) await page.getByRole('button', { name: 'Quick actions' }).click();
  const entry = page.locator('#floating-human-contact');
  await expect(entry).toBeVisible();
  expect(await fabPaint(page, '#floating-human-contact')).toEqual(await fabPaint(page, '.fab button[aria-label="Back to top"]'));
  await entry.click();
  await expect(page).toHaveURL(/\/en\/contact$/);
}

for (const viewport of VIEWPORTS) {
  test(`拒分析：浮钮进联系页，聊天关闭时询盘和邮箱仍可点 @${viewport.width}`, async ({ page, external }) => {
    await page.setViewportSize(viewport);
    await rejectAnalytics(page);
    const app: string[] = [];
    page.on('request', (request) => app.push(request.url()));
    await page.goto('/en');
    await openHumanContact(page, viewport.width);
    await expect(page.locator('#chat-availability')).toHaveCount(0);
    await expect(page.locator('#human-contact-notice')).toContainText('The inquiry form and email always work');
    await expect(page.locator('.iq-step')).toContainText('Step 1 of 3');

    const email = page.locator('#inquiry-email-entry');
    await email.focus();
    await expect(email).toBeFocused();
    await email.click();
    await expectEmailFieldClearOfHeader(page);
    const submit = page.locator('form button[type="submit"]');
    await expect(submit).toBeEnabled();
    await submit.click({ trial: true });

    const watched = [...external.urls, ...app];
    expect(watched.filter((url) => isThirdPartyChatUrl(url) || /\/api\/analytics|\/api\/rum/i.test(url))).toEqual([]);
    await expect(page.locator(thirdPartyChatDomSelector())).toHaveCount(0);
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
  await expect(main.getByRole('heading', { name: 'Contacting us' })).toBeVisible();
  await expect(main).toContainText('The inquiry form and email always work, whatever you choose in cookie settings.');
  await expect(main).toContainText('The necessary chat cookie expires after 7\u00A0days of inactivity and no later than 30\u00A0days after it was first set. Automatic deletion of chat messages is not currently enabled on this site.');
  await expect(main).not.toContainText('Tawk');
  await expect(main).toContainText('Inquiries are anonymized 2 years after the last activity');

  await page.locator('#cookie-settings-link').click();
  const dialog = page.getByRole('dialog', { name: 'Cookie settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-consent-category="human-contact"]')).toContainText('Necessary');
  await expect(dialog.locator('[data-consent-category="analytics"]')).toContainText('Optional analytics');
  await expect(dialog.getByRole('switch', { name: 'Optional analytics' })).toBeVisible();
  await expect(dialog).not.toContainText('Tawk');
  await dialog.getByRole('button', { name: 'Close' }).click();

  expect([...external.urls, ...app].filter((url) => isThirdPartyChatUrl(url) || /\/api\/analytics|\/api\/rum/i.test(url))).toEqual([]);
});

test('俄语隐私页说明同一边界', async ({ page, external }) => {
  await rejectAnalytics(page);
  await page.goto('/ru/privacy');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'Как с нами связаться' })).toBeVisible();
  await expect(main).toContainText('Форма запроса и e-mail работают всегда, независимо от настроек cookie.');
  await expect(main).toContainText('Срок действия необходимого файла cookie чата истекает через 7\u00A0дней бездействия, но не позднее чем через 30\u00A0дней после его установки. Автоматическое удаление сообщений чата на сайте сейчас не включено.');
  await expect(main).toContainText('Запросы обезличиваются через 2 года после последней активности');
  await expect(main).not.toContainText('Tawk');
  await expect(main).not.toContainText('снимок');
  expect(external.urls.filter((url) => isThirdPartyChatUrl(url) || /\/api\/analytics/i.test(url))).toEqual([]);
});
