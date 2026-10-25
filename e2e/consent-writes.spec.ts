import { test, expect } from './fixtures';

test('保存设置写入 chat:false，分析仍开着时提示已保存', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pj-consent', JSON.stringify({ v: 2, analytics: true, chat: true, ts: Date.now() }));
    localStorage.setItem('twk_uuid_saved', 'residue');
  });
  await page.goto('/en');
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

test('旧 chat:true 且分析从开到关：清残留、刷新，并提示已撤回', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pj-consent', JSON.stringify({ v: 2, analytics: true, chat: true, ts: Date.now() }));
    localStorage.setItem('twk_uuid_old', 'residue');
  });
  await page.goto('/en');
  await page.locator('#cookie-settings-link').click();
  await page.getByRole('dialog', { name: 'Cookie settings' }).getByRole('button', { name: 'Reject all' }).click();
  await expect(page.locator('.consent-toast')).toContainText('Consent withdrawn. Analytics is off.');
  const stored = await page.evaluate(() => ({
    consent: JSON.parse(localStorage.getItem('pj-consent') ?? 'null'),
    residue: Object.keys(localStorage).filter((key) => /^(twk_|tawk|__tawk|TawkConnectionTime)/i.test(key)),
  }));
  expect(stored.consent).toMatchObject({ v: 2, analytics: false, chat: false });
  expect(stored.residue).toEqual([]);
});
