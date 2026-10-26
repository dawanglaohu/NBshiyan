import { execFileSync } from 'node:child_process';
import { authenticator } from 'otplib';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';

const E2E_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const PASSWORD = 'hotfix-login-empty-Passw0rd!';

test('credentials callback accepts email, password and totp when the other fields stay empty', async ({ request }) => {
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

  const csrf = (await (await request.get('/api/auth/csrf')).json()).csrfToken as string;
  const body = new URLSearchParams({
    csrfToken: csrf,
    email,
    password: PASSWORD,
    totp: authenticator.generate(E2E_TOTP),
    recoveryCode: '',
    rememberDevice: '',
    mode: '',
    callbackUrl: `${BASE}/admin`,
  });
  const response = await request.post('/api/auth/callback/credentials', {
    headers: { Origin: BASE, 'content-type': 'application/x-www-form-urlencoded' },
    data: body.toString(),
    maxRedirects: 0,
  });
  expect(response.status()).toBe(302);
  expect(response.headers().location ?? '').not.toContain('error');
  await expect.poll(async () => {
    const session = await request.get('/api/auth/session');
    return session.ok() ? ((await session.json())?.user?.email ?? '') : '';
  }).toBe(email);
});
