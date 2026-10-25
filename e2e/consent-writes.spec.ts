import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const SEED_TS = Date.now() - 86_400_000;
const SEED_ANALYTICS = true;
const TAWK_KEY = /^(twk_|tawk|__tawk|TawkConnectionTime)/i;

async function seedLegacyChat(page: Page, analytics: boolean, residueKey: string, ts = Date.now()) {
  await page.goto('/en');
  await page.evaluate(({ analytics, residueKey, ts }) => {
    localStorage.setItem('pj-consent', JSON.stringify({ v: 2, analytics, chat: true, ts }));
    localStorage.setItem(residueKey, 'residue');
  }, { analytics, residueKey, ts });
  await page.reload();
}

async function readStored(page: Page) {
  return page.evaluate((pattern) => {
    const match = new RegExp(pattern, 'i');
    return {
      consent: JSON.parse(localStorage.getItem('pj-consent') ?? 'null') as { v: number; analytics: boolean; chat: boolean; ts: number },
      residue: [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((key) => match.test(key)),
    };
  }, TAWK_KEY.source);
}

test('保存设置写入 chat:false，分析仍开着时提示已保存', async ({ page }) => {
  await seedLegacyChat(page, true, 'twk_uuid_saved');
  await page.locator('#cookie-settings-link').click();
  const dialog = page.getByRole('dialog', { name: 'Cookie settings' });
  await dialog.getByRole('button', { name: 'Save choices' }).click();
  await expect(page.locator('.consent-toast')).toContainText('Your cookie choices were saved.');
  await expect(page.locator('.consent-toast')).not.toContainText('Consent withdrawn');
  const stored = await page.evaluate(() => ({
    consent: JSON.parse(localStorage.getItem('pj-consent') ?? 'null'),
    residue: Object.keys(localStorage).filter((key) => /^(twk_|tawk|__tawk|TawkConnectionTime)/i.test(key)),
  }));
  expect(stored.consent).toMatchObject({ v: 2, analytics: true, chat: false });
  expect(stored.residue).toEqual([]);
});

test('旧 chat:true 且分析从开到关：静默迁移后不刷新，并提示已撤回', async ({ page }) => {
  await seedLegacyChat(page, true, 'twk_uuid_old', SEED_TS);
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('pj-consent') ?? 'null')?.chat)).toBe(false);
  const migrated = await readStored(page);
  expect(migrated.consent).toMatchObject({ v: 2, analytics: true, chat: false, ts: SEED_TS });
  expect(migrated.residue).toEqual([]);
  await page.evaluate(() => { (window as unknown as { __stay?: number }).__stay = 1; });
  await page.locator('#cookie-settings-link').click();
  await page.getByRole('dialog', { name: 'Cookie settings' }).getByRole('button', { name: 'Reject all' }).click();
  expect(await page.evaluate(() => (window as unknown as { __stay?: number }).__stay)).toBe(1);
  await expect(page.locator('.consent-toast')).toContainText('Consent withdrawn. Analytics is off.');
  const stored = await page.evaluate(() => ({
    consent: JSON.parse(localStorage.getItem('pj-consent') ?? 'null'),
    residue: Object.keys(localStorage).filter((key) => /^(twk_|tawk|__tawk|TawkConnectionTime)/i.test(key)),
  }));
  expect(stored.consent).toMatchObject({ v: 2, analytics: false, chat: false });
  expect(stored.residue).toEqual([]);
});

test('打开页面后不操作：旧 chat:true 静默变成 false，ts 与 analytics 保持种子值，残留清掉', async ({ page }) => {
  await seedLegacyChat(page, SEED_ANALYTICS, 'twk_uuid_silent', SEED_TS);
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('pj-consent') ?? 'null')?.chat)).toBe(false);
  const stored = await readStored(page);
  expect(stored.consent).toEqual({ v: 2, analytics: SEED_ANALYTICS, chat: false, ts: SEED_TS });
  expect(stored.residue).toEqual([]);
});

for (const button of ['Save choices', 'Reject all', 'Accept all'] as const) {
  test(`1440 联系页填到第 2 步后点 ${button}：不刷新，询价还在`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedLegacyChat(page, SEED_ANALYTICS, `twk_uuid_${button.replace(/\s+/g, '_')}`, SEED_TS);
    await page.goto('/en/contact');
    await expect(page.locator('.iq-step')).toContainText('Step 1 of 3');
    await page.locator('form.wizard').getByRole('button', { name: 'Next' }).click();
    await expect(page.locator('.iq-step')).toContainText('Step 2 of 3');
    const size = '120 x 80 x 60 mm';
    await page.locator('#iq-size').fill(size);

    await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('pj-consent') ?? 'null')?.chat)).toBe(false);
    const migrated = await readStored(page);
    expect(migrated.consent.ts).toBe(SEED_TS);
    expect(migrated.consent.analytics).toBe(SEED_ANALYTICS);
    expect(migrated.consent.chat).toBe(false);
    expect(migrated.residue).toEqual([]);

    await page.evaluate(() => { (window as unknown as { __stay?: number }).__stay = 1; });
    await page.locator('#cookie-settings-link').click();
    await page.getByRole('dialog', { name: 'Cookie settings' }).getByRole('button', { name: button }).click();

    expect(await page.evaluate(() => (window as unknown as { __stay?: number }).__stay)).toBe(1);
    await expect(page).toHaveURL(/\/en\/contact$/);
    await expect(page.locator('.iq-step')).toContainText('Step 2 of 3');
    await expect(page.locator('#iq-size')).toHaveValue(size);
    const after = await readStored(page);
    expect(after.consent.chat).toBe(false);
  });
}
