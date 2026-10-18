import { execFileSync } from 'node:child_process';
import { authenticator } from 'otplib';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';
import type { APIRequestContext } from '@playwright/test';

export const E2E_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // 测试用假密钥

/**
 * 每组只登录一次（在 test.describe 里调用）：beforeAll 新建一个 ADMIN（scripts/create-admin.mjs；ADMIN_SEED_TOTP_SECRET 只在非生产可用），
 * 用独立的 request context 登录一次，存下 storageState（会话 cookie）；组里每个测试开始前把 cookie 放进自己的 page context
 * （page.request 和页面共用），不再重新登录。
 * 为什么：单 IP 登录桶 30 次 / 10 分钟（#376 起 enroll / confirm 也算、而且不退），整套 e2e 1 个 worker 共用一个 IP，
 * 每个测试各登录一次会把后面 admin.spec.ts 的登录挤爆（CredentialsSignin）。
 * 不用 serial：某个测试失败不会连带跳过同组其他测试；失败后 Playwright 换 worker 会重跑 beforeAll，多登录一次（只在出错时）。
 * 每个测试仍然自己把要用的数据重置到基线，互不依赖。
 */
export function useSharedAdmin(o: { emailPrefix: string; name: string; password: string; probe: string }) {
  let state: Awaited<ReturnType<APIRequestContext['storageState']>>;
  test.beforeAll(async ({ playwright }) => {
    const email = `${o.emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    execFileSync('node', ['scripts/create-admin.mjs'], {
      stdio: 'pipe',
      env: { ...process.env, ADMIN_SEED_EMAIL: email, ADMIN_SEED_PASSWORD: o.password, ADMIN_SEED_NAME: o.name, ADMIN_SEED_ROLE: 'ADMIN', ADMIN_SEED_TOTP_SECRET: E2E_TOTP },
    });
    const req = await playwright.request.newContext({ baseURL: BASE });
    const csrf = (await (await req.get('/api/auth/csrf')).json()).csrfToken as string;
    const ok = await req.post('/api/auth/callback/credentials', { headers: { Origin: BASE }, form: { csrfToken: csrf, email, password: o.password, totp: authenticator.generate(E2E_TOTP) }, maxRedirects: 0 });
    expect(ok.headers()['location'] ?? '').not.toContain('error');
    expect((await req.get(o.probe)).status()).toBe(200);
    state = await req.storageState();
    await req.dispose();
  });
  test.beforeEach(async ({ page }) => { await page.context().addCookies(state.cookies); });
}
