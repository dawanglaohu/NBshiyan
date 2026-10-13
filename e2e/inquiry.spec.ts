import { test, expect } from './fixtures';

async function toStep3(page: import('@playwright/test').Page, path = '/en/contact') {
  await page.goto(path);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByLabel(/Name/)).toBeVisible();
}
async function fillContact(page: import('@playwright/test').Page) {
  await page.getByLabel(/^Name/).fill('QA E2E');
  await page.getByLabel(/Business email|Email/).fill('qa@acme-test.com');
  await page.getByLabel(/Company/).fill('Acme');
  await page.getByLabel(/Country/).selectOption('DE');
  await page.getByRole('checkbox', { name: /agree|consent|privacy/i }).check();
}

test('询价全流程：三步提交成功并显示询盘编号', async ({ page }) => {
  await toStep3(page);
  await fillContact(page);
  await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveCount(1);
  const resp = page.waitForResponse((r) => r.url().endsWith('/api/inquiries') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send request' }).click();
  expect((await resp).status()).toBeLessThan(300);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  await expect(page.locator('strong').filter({ hasText: /\w{4,}/ }).first()).toBeVisible();
});

test('#98 回归：第 3 步 Back → Next 后联系人信息保留', async ({ page }) => {
  test.fixme(true, '#98 未修复（step 3 为非受控输入，卸载后清空）；修复合并后去掉 fixme');
  await toStep3(page);
  await fillContact(page);
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByLabel(/^Name/)).toHaveValue('QA E2E');
  await expect(page.getByLabel(/Business email|Email/)).toHaveValue('qa@acme-test.com');
  await expect(page.getByLabel(/Company/)).toHaveValue('Acme');
  await expect(page.getByLabel(/Country/)).toHaveValue('DE');
  await expect(page.getByRole('checkbox', { name: /agree|consent|privacy/i })).toBeChecked();
});
