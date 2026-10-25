import { expect, type Page } from '@playwright/test';

/** 邮箱输入和它的 label 都要落在吸顶页头底边之下。 */
export async function expectEmailFieldClearOfHeader(page: Page) {
  const email = page.locator('#iq-email');
  const label = page.locator('label[for="iq-email"]');
  await expect(email).toBeVisible();
  await expect(email).toBeFocused();
  await expect.poll(async () => {
    const header = await page.locator('header.site').boundingBox();
    const input = await email.boundingBox();
    const lab = await label.boundingBox();
    if (!header || !input || !lab) return false;
    const bottom = header.y + header.height;
    return lab.y >= bottom - 1 && input.y >= bottom - 1;
  }).toBe(true);
}
