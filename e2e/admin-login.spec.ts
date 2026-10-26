import { execFileSync } from 'node:child_process';
import { authenticator } from 'otplib';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';
import { E2E_TOTP } from './shared-admin';

// 自定义 /admin-login。未登录只打开页面，不计登录。有两步验证的账号提交 2 次。
// 不重试、不提交错误密码。整套 e2e 的单 IP 登录次数因此是 26。
test.use({ locale: 'zh-CN' });
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

test('未登录打开登录页得到 200，且这次请求没有重定向', async ({ page }) => {
  test.setTimeout(90_000);
  const response = await page.goto('/admin-login');
  expect(response?.status()).toBe(200);
  expect(response?.request().redirectedFrom()).toBeNull();
  const headers = response?.headers() ?? {};
  expect(headers['cache-control'] ?? '').toContain('no-store');
  expect(headers['x-robots-tag'] ?? '').toContain('noindex');
  expect(headers['referrer-policy']).toBe('no-referrer');
  await expect(page.getByLabel('验证码')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '显示密码' })).toBeVisible();
  await assertNoHiddenFields(page);
});

test('开了两步验证的账号从登录页回到设置，Auth.js 同源绝对地址也同样回到原页', async ({ page }) => {
  test.setTimeout(90_000);
  const email = `e2e-login-totp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  seedAccount(email, true);
  const models = await page.request.get('/admin/models?x=1', { maxRedirects: 0 });
  expect([303, 307]).toContain(models.status());
  const modelsLocation = models.headers()['location'] ?? '';
  expect(new URL(modelsLocation, BASE).pathname).toBe('/admin-login');
  expect(modelsLocation).toContain('callbackUrl=%2Fadmin%2Fmodels%3Fx%3D1');
  const settings = await page.request.get('/admin/settings', { maxRedirects: 0 });
  expect([303, 307]).toContain(settings.status());
  const settingsLocation = settings.headers()['location'] ?? '';
  expect(new URL(settingsLocation, BASE).pathname).toBe('/admin-login');
  expect(settingsLocation).toContain('callbackUrl=%2Fadmin%2Fsettings');
  await page.goto(`/api/auth/signin?callbackUrl=${encodeURIComponent(`${BASE}/admin/settings`)}`);
  await expect(page).toHaveURL(/\/admin-login/);
  await expect(page.locator('form')).toHaveAttribute('data-callback', '/admin/settings');
  await assertNoHiddenFields(page);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  const code = page.getByLabel('验证码');
  await expect(code).toBeVisible();
  await expect(page.getByText('请输入验证器 App 中显示的 6 位验证码。')).toBeVisible();
  await expect(page.locator('.lg-hint')).not.toHaveAttribute('role', 'alert');
  await expect(page.getByLabel('邮箱')).toHaveValue(email);
  await expect(page.getByLabel('邮箱')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: '返回' })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await assertNoHiddenFields(page);
  await code.fill(authenticator.generate(E2E_TOTP));
  const pending = page.waitForResponse((item) => item.url().includes('/admin/settings') && item.request().resourceType() === 'document');
  await page.getByRole('button', { name: '登录' }).click();
  expect((await pending).status()).toBe(200);
  await expect(page).toHaveURL(/\/admin\/settings/);
  await expect(page.getByRole('heading', { level: 1, name: '公司介绍（/about 页）' })).toBeVisible();
});
