import { test, expect } from './fixtures';
import { expectEmailFieldClearOfHeader } from './email-field';

async function preset(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('pj-consent', JSON.stringify({ v: 2, analytics: false, chat: false, ts: Date.now() }));
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const) {
  test(`联系页第 1 步跳到邮箱字段，label 不被页头挡住 @${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await preset(page);
    await page.goto('/en/contact');
    await expect(page.locator('.iq-step')).toContainText('Step 1 of 3');
    await expect(page.locator('#iq-email')).toHaveCount(0);
    await page.locator('#inquiry-email-entry').click();
    await expect(page).not.toHaveURL(/mailto:/);
    await expectEmailFieldClearOfHeader(page);
  });
}
