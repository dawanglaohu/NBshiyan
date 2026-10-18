import { authenticator } from 'otplib';
import { test, expect } from './fixtures';
import { E2E_ADMIN } from './global-setup';
import { BASE } from '../playwright.config';

// 后台还没有登录页 UI，按接口走：绑定 2FA → Auth.js credentials 登录 → 访问 /api/admin/*
test('后台登录：密码 + TOTP，登录前后 /api/admin 鉴权', async ({ request }) => {
  test.setTimeout(90_000);
  const origin = { Origin: BASE };
  expect((await request.get('/api/admin/inquiries')).status()).toBe(401);

  // 首次运行绑定 2FA；测试库重复运行时账号已绑定，需 ADMIN_SEED_TOTP_SECRET（后端待加）
  let secret = process.env.ADMIN_SEED_TOTP_SECRET;
  // #347：绑定要带一次性令牌（global-setup 新建账号时从 create-admin.mjs 的输出里取）；账号已存在时没有令牌，enroll 401，走下面的 skip / 预置密钥
  const token = process.env.E2E_ADMIN_ENROLL_TOKEN ?? '';
  const en = await request.post('/api/auth-admin/enroll', { headers: origin, data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password, token } });
  if (en.ok()) {
    secret = new URL((await en.json()).otpauthUri).searchParams.get('secret')!;
    const c = await request.post('/api/auth-admin/enroll/confirm', { headers: origin, data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password, totp: authenticator.generate(secret), token } });
    expect(c.status()).toBe(200);
    expect((await c.json()).recoveryCodes).toHaveLength(10);
    // 同一时间窗的验证码不能重复使用（防重放），等到下一个 30 秒窗口
    await new Promise((r) => setTimeout(r, (authenticator.timeRemaining() + 1) * 1000));
  }
  test.skip(!secret, '账号已绑定 2FA 且未提供 ADMIN_SEED_TOTP_SECRET');

  const csrf = (await (await request.get('/api/auth/csrf')).json()).csrfToken as string;
  const bad = await request.post('/api/auth/callback/credentials', { headers: origin, form: { csrfToken: csrf, email: E2E_ADMIN.email, password: E2E_ADMIN.password, totp: '000000' }, maxRedirects: 0 });
  expect(bad.headers()['location'] ?? '').toContain('error');
  expect((await request.get('/api/admin/inquiries')).status()).toBe(401);

  const ok = await request.post('/api/auth/callback/credentials', { headers: origin, form: { csrfToken: csrf, email: E2E_ADMIN.email, password: E2E_ADMIN.password, totp: authenticator.generate(secret!) }, maxRedirects: 0 });
  expect(ok.headers()['location'] ?? '').not.toContain('error');
  expect((await request.get('/api/admin/inquiries')).status()).toBe(200);
});
