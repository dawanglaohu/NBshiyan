import { execFileSync } from 'node:child_process';
import { authenticator } from 'otplib';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';

// P1：/admin-enroll 首次绑定 2FA。每个用例新建一个未绑定的账号（scripts/create-admin.mjs，仅 E2E 测试库），
// 每个账号的密码校验次数控制在共享限流（同一 IP+账号 10 分钟 5 次）以内。
const PASSWORD = 'e2e-enroll-Passw0rd!';
function freshAccount(tag: string) {
  const email = `e2e-enroll-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  execFileSync('node', ['scripts/create-admin.mjs'], {
    stdio: 'pipe',
    env: { ...process.env, ADMIN_SEED_EMAIL: email, ADMIN_SEED_PASSWORD: PASSWORD, ADMIN_SEED_NAME: 'E2E enroll', ADMIN_SEED_ROLE: 'SALES', ADMIN_SEED_TOTP_SECRET: '' },
  });
  return email;
}
const origin = { Origin: BASE };
const secretOf = (uri: string) => new URL(uri).searchParams.get('secret')!;
/** 两个密钥的当前验证码是否不同；两个密钥同一时刻撞码的概率约 1e-6，撞了就跳过 */
const differs = (a: string, b: string) => authenticator.generate(a) !== authenticator.generate(b);

test('/admin-enroll：页面上走完 账号验证 → 扫码并确认 → 保存恢复码 → 去登录', async ({ page, external }) => {
  test.setTimeout(90_000);
  const email = freshAccount('ui');
  const res = await page.goto('/admin-enroll');
  expect(res!.status()).toBe(200);
  expect(res!.headers()['cache-control']).toContain('no-store');
  expect(res!.headers()['x-robots-tag']).toContain('noindex');
  expect(new URL(page.url()).pathname).toBe('/admin-enroll'); // 没有被加语言前缀，也没被重定向到登录
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('[aria-current="step"]')).toContainText('账号验证');

  // 第 1 步：密码错 → bad_credentials 文案（顶部 role=alert）
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('初始密码').fill('wrong-password-123');
  await page.getByRole('button', { name: '显示密码' }).click();
  await expect(page.getByLabel('初始密码')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('邮箱或密码错误，或该账号已绑定');
  await page.getByLabel('初始密码').fill(PASSWORD);
  await page.getByRole('button', { name: '下一步' }).click();

  // 第 2 步：本地二维码 + 手动密钥 + 验证码
  await expect(page.getByRole('heading', { name: '扫码并确认' })).toBeFocused();
  const qr = page.getByRole('img', { name: /绑定用二维码/ });
  await expect(qr).toHaveAttribute('src', /^data:image\/svg\+xml/);
  expect((await qr.boundingBox())!.width).toBeGreaterThanOrEqual(200);
  await page.getByText('无法扫码？显示密钥').click();
  const grouped = (await page.getByLabel('密钥').textContent())!;
  expect(grouped).toMatch(/^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/);
  const secret = grouped.replace(/\s+/g, '');
  const input = page.getByLabel('6 位验证码');
  await expect(input).toHaveAttribute('inputmode', 'numeric');
  await expect(input).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(input).toHaveAttribute('maxlength', '6');
  await expect(page.getByRole('button', { name: /重新生成/ })).toHaveCount(0);
  // 错码 → 输入框下方红字、输入保留
  const wrong = authenticator.generate(secret) === '000000' ? '111111' : '000000';
  await input.fill(wrong);
  await page.getByRole('button', { name: '确认绑定' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('验证码不正确或已过期');
  await expect(input).toHaveValue(wrong);
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  // 粘贴带空格的正确码
  const ok = authenticator.generate(secret);
  await input.fill(`${ok.slice(0, 3)} ${ok.slice(3)}`);
  await expect(input).toHaveValue(ok);
  await page.getByRole('button', { name: '确认绑定' }).click();

  // 第 3 步：恢复码；勾选 + 等满 30 秒后才能去登录
  await expect(page.getByRole('heading', { name: '保存恢复码' })).toBeFocused();
  await expect(page.getByRole('list', { name: '10 个恢复码' }).getByRole('listitem')).toHaveCount(10);
  await expect(page.getByText('请等待下一个验证码（约 30 秒）再登录')).toBeVisible();
  const go = page.getByRole('link', { name: '去登录' });
  await expect(go).toHaveAttribute('aria-disabled', 'true');
  await expect(go).toHaveAttribute('href', '/api/auth/signin?callbackUrl=%2Fadmin');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 .txt' }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe('packjoyu-admin-recovery-codes.txt');
  await page.getByLabel('我已保存恢复码').check();
  await expect(go).toHaveAttribute('aria-disabled', 'true'); // 还在 30 秒倒计时内
  await expect(go).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 35_000 });
  // 页面没有访问任何外部地址（没有外部二维码服务），也没写浏览器存储
  expect(external.urls).toEqual([]);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await go.click();
  await page.waitForURL(/\/api\/auth\/signin/);
});

test('已绑定的账号再调 enroll → 401 bad_credentials', async ({ request }) => {
  const email = freshAccount('enrolled');
  const en = await request.post('/api/auth-admin/enroll', { headers: origin, data: { email, password: PASSWORD } });
  expect(en.status()).toBe(200);
  const secret = secretOf((await en.json()).otpauthUri);
  const c = await request.post('/api/auth-admin/enroll/confirm', { headers: origin, data: { email, password: PASSWORD, totp: authenticator.generate(secret) } });
  expect(c.status()).toBe(200);
  const again = await request.post('/api/auth-admin/enroll', { headers: origin, data: { email, password: PASSWORD } });
  expect(again.status()).toBe(401);
  expect((await again.json()).error).toBe('bad_credentials');
});

test('再次 enroll 后旧的待确认密钥作废：用旧密钥的码确认 → 401 bad_totp，新密钥可以', async ({ request }) => {
  const email = freshAccount('rotate');
  const first = secretOf((await (await request.post('/api/auth-admin/enroll', { headers: origin, data: { email, password: PASSWORD } })).json()).otpauthUri);
  const second = secretOf((await (await request.post('/api/auth-admin/enroll', { headers: origin, data: { email, password: PASSWORD } })).json()).otpauthUri);
  expect(second).not.toBe(first);
  test.skip(!differs(first, second), '两个密钥当前验证码相同（概率约百万分之一）');
  const old = await request.post('/api/auth-admin/enroll/confirm', { headers: origin, data: { email, password: PASSWORD, totp: authenticator.generate(first) } });
  expect(old.status()).toBe(401);
  expect((await old.json()).error).toBe('bad_totp');
  const ok = await request.post('/api/auth-admin/enroll/confirm', { headers: origin, data: { email, password: PASSWORD, totp: authenticator.generate(second) } });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).recoveryCodes).toHaveLength(10);
});
