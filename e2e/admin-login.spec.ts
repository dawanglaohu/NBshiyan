import { execFileSync } from 'node:child_process';
import { authenticator } from 'otplib';
import { test, expect } from './fixtures';
import { E2E_TOTP } from './shared-admin';

// 自定义 /admin-login。每条用例只按步骤提交必要的凭据：无两步验证 1 次，有两步验证 2 次。
// 不重试、不提交错误密码。整套 e2e 的单 IP 登录次数因此是 26。
const PASSWORD = 'e2e-login-Passw0rd!';

function seedAccount(email: string, withTotp: boolean) {
  const env = {
    ...process.env,
    ADMIN_SEED_EMAIL: email,
    ADMIN_SEED_PASSWORD: PASSWORD,
    ADMIN_SEED_NAME: 'E2E login',
    ADMIN_SEED_ROLE: 'ADMIN',
    ADMIN_SEED_TOTP_SECRET: withTotp ? E2E_TOTP : '',
  };
  try {
    execFileSync('node', ['scripts/create-admin.mjs'], { stdio: 'pipe', env });
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? '');
    throw new Error(stderr.includes('已存在') ? 'account exists' : 'create-admin failed');
  }
}

async function assertNoHiddenFields(page: import('@playwright/test').Page) {
  await expect(page.locator('input[name="recoveryCode"], input[name="rememberDevice"], input[name="mode"]')).toHaveCount(0);
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/recoveryCode|rememberDevice|\bmode\b/i);
}

test('无两步验证的账号从自定义登录页进入询盘管理', async ({ page }) => {
  test.setTimeout(90_000);
  const email = `e2e-login-plain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  seedAccount(email, false);
  const response = await page.goto('/api/auth/signin?callbackUrl=%2Fadmin%2Finquiries');
  await expect(page).toHaveURL(/\/admin-login/);
  expect(new URL(page.url()).searchParams.get('callbackUrl')).toBe('/admin/inquiries');
  const headers = response?.headers() ?? {};
  expect(headers['cache-control'] ?? '').toContain('no-store');
  expect(headers['x-robots-tag'] ?? '').toContain('noindex');
  expect(headers['referrer-policy']).toBe('no-referrer');
  await expect(page.getByLabel('验证码')).toHaveCount(0);
  await assertNoHiddenFields(page);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(PASSWORD);
  const pending = page.waitForResponse((item) => item.url().includes('/admin/inquiries') && item.request().resourceType() === 'document');
  await page.getByRole('button', { name: '登录' }).click();
  expect((await pending).status()).toBe(200);
  await expect(page).toHaveURL(/\/admin\/inquiries/);
  await expect(page.getByRole('heading', { level: 1, name: /询盘管理/ })).toBeVisible();
  expect((await page.request.get('/api/admin/inquiries')).status()).toBe(200);
});

test('开了两步验证的账号在密码正确后输入验证码，再进入询盘管理', async ({ page }) => {
  test.setTimeout(90_000);
  const email = `e2e-login-totp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  seedAccount(email, true);
  await page.goto('/admin-login?callbackUrl=%2Fadmin%2Finquiries');
  await assertNoHiddenFields(page);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  const code = page.getByLabel('验证码');
  await expect(code).toBeVisible();
  await expect(page.getByLabel('邮箱')).toHaveValue(email);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await assertNoHiddenFields(page);
  await code.fill(authenticator.generate(E2E_TOTP));
  const pending = page.waitForResponse((item) => item.url().includes('/admin/inquiries') && item.request().resourceType() === 'document');
  await page.getByRole('button', { name: '登录' }).click();
  expect((await pending).status()).toBe(200);
  await expect(page).toHaveURL(/\/admin\/inquiries/);
  await expect(page.getByRole('heading', { level: 1, name: /询盘管理/ })).toBeVisible();
  expect((await page.request.get('/api/admin/inquiries')).status()).toBe(200);
});
