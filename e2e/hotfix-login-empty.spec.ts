import { execFileSync } from 'node:child_process';
import { authenticator } from 'otplib';
import { test, expect } from './fixtures';

const E2E_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const PASSWORD = 'hotfix-login-empty-Passw0rd!';

test('default Auth.js sign-in accepts email, password and totp when the other boxes stay empty', async ({ page }) => {
  test.setTimeout(180_000);
  const email = `hotfix-login-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  execFileSync('node', ['scripts/create-admin.mjs'], {
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      APP_ENV: 'test',
      VERCEL_ENV: '',
      ADMIN_SEED_EMAIL: email,
      ADMIN_SEED_PASSWORD: PASSWORD,
      ADMIN_SEED_NAME: 'Hotfix login empty',
      ADMIN_SEED_ROLE: 'ADMIN',
      ADMIN_SEED_TOTP_SECRET: E2E_TOTP,
    },
  });

  await page.goto('/api/auth/signin');
  const form = page.locator('form').filter({ has: page.locator('input[name="email"]') });
  await form.locator('input[name="email"]').fill(email);
  await form.locator('input[name="password"]').fill(PASSWORD);
  await form.locator('input[name="totp"]').fill(authenticator.generate(E2E_TOTP));
  await expect(form.locator('input[name="recoveryCode"]')).toHaveValue('');
  await expect(form.locator('input[name="rememberDevice"]')).toHaveValue('');
  await expect(form.locator('input[name="mode"]')).toHaveValue('');
  await expect(form).toHaveAttribute('action', /\/api\/auth\/callback\/credentials$/);

  const submitted = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/api/auth/callback/credentials'));
  await form.getByRole('button', { name: 'Sign in with Credentials' }).click({ noWaitAfter: true });
  const response = await submitted;
  expect(response.status()).toBe(302);
  expect(response.headers().location ?? '').not.toContain('error');
  await expect.poll(async () => {
    const session = await page.request.get('/api/auth/session');
    return session.ok() ? ((await session.json())?.user?.email ?? '') : '';
  }).toBe(email);
});
