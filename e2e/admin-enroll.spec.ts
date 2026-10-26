import { execFileSync } from 'node:child_process';
import { authenticator } from 'otplib';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';

// P1：/admin-enroll 首次绑定 2FA。每个用例新建一个未绑定的账号（scripts/create-admin.mjs，仅 E2E 测试库），
// 每个账号的密码校验次数控制在共享限流（同一 IP+账号 10 分钟 5 次）以内。
// #347 方案 A：create-admin.mjs 新建未绑定账号时在 stdout 打印一次性绑定链接，这里从输出里取令牌（不额外登录）。
const PASSWORD = 'e2e-enroll-Passw0rd!';
function freshAccount(tag: string) {
  const email = `e2e-enroll-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const out = execFileSync('node', ['scripts/create-admin.mjs'], {
    stdio: 'pipe',
    env: { ...process.env, ADMIN_SEED_EMAIL: email, ADMIN_SEED_PASSWORD: PASSWORD, ADMIN_SEED_NAME: 'E2E enroll', ADMIN_SEED_ROLE: 'SALES', ADMIN_SEED_TOTP_SECRET: '' },
  });
  const token = /#t=([A-Za-z0-9_-]{43})/.exec(String(out))?.[1];
  if (!token) throw new Error('create-admin.mjs 没有输出绑定链接');
  return { email, token };
}
const origin = { Origin: BASE };
const secretOf = (uri: string) => new URL(uri).searchParams.get('secret')!;

test('/admin-enroll：页面上走完 账号验证 → 扫码并确认 → 保存恢复码 → 去登录', async ({ page, external }) => {
  test.setTimeout(90_000);
  const { email, token } = freshAccount('ui');
  const res = await page.goto(`/admin-enroll#t=${token}`);
  expect(res!.status()).toBe(200);
  expect(res!.headers()['cache-control']).toContain('no-store');
  expect(res!.headers()['x-robots-tag']).toContain('noindex');
  expect(res!.headers()['x-robots-tag']).toContain('nofollow');
  expect(res!.headers()['referrer-policy']).toBe('no-referrer'); // #347：带令牌的地址不能经 Referer 外泄
  expect(new URL(page.url()).pathname).toBe('/admin-enroll'); // 没有被加语言前缀，也没被重定向到登录
  await expect.poll(() => new URL(page.url()).hash).toBe(''); // #347：令牌（#t= fragment）已从地址栏去掉（replaceState）
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('[aria-current="step"]')).toContainText('账号验证');
  await expect(page.getByTestId('enroll-keep-hint')).toHaveText('请在这个页面完成绑定，不要刷新或关闭'); // #347 UX v1.0：有令牌时的灰色提示

  // 第 1 步：密码错 → bad_credentials 文案（顶部 role=alert）
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('初始密码').fill('wrong-password-123');
  await page.getByRole('button', { name: '显示密码' }).click();
  await expect(page.getByLabel('初始密码')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '下一步' }).click();
  // #347 UX v1.0.4：401 统一文案；保留邮箱、清空密码并聚焦，不标红单个字段
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('链接无效或已过期、邮箱或密码不正确，或尝试次数过多。请稍后重试；仍然不行的话，请联系管理员重新发送绑定链接。');
  await expect(page.getByLabel('邮箱')).toHaveValue(email);
  await expect(page.getByLabel('初始密码')).toHaveValue('');
  await expect(page.getByLabel('初始密码')).toBeFocused();
  await expect(page.locator('[aria-invalid="true"]')).toHaveCount(0);
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
  // 不能有 maxlength：浏览器会先按原始字符截断，「751 940」会丢最后一位；只保留 6 位数字由 normalizeCode 负责
  await expect(input).not.toHaveAttribute('maxlength', /.*/);
  await expect(page.getByRole('button', { name: /重新生成/ })).toHaveCount(0);
  // 粘贴 / 输入的格式：只留数字；正好 6 位才能提交；超过 6 位不截断，提示并禁止提交（PM / UX / 全栈）
  const submit = page.getByRole('button', { name: '确认绑定' });
  const lenErr = page.locator('#en-otp-e');
  const paste = (text: string) => input.evaluate((el, t) => {
    const dt = new DataTransfer(); dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  for (const raw of ['751 940', '751-940', ' 751940 ']) {
    await input.fill('');
    await paste(raw);
    await expect(input, `paste ${JSON.stringify(raw)}`).toHaveValue('751940');
    await expect(submit).toBeEnabled();
    await expect(lenErr).toHaveCount(0);
  }
  const confirms: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/enroll/confirm')) confirms.push(r.url()); });
  await input.fill('');
  await input.pressSequentially('75194'); // 不足 6 位：只禁用提交，不提示
  await expect(submit).toBeDisabled();
  await expect(lenErr).toHaveCount(0);
  await input.pressSequentially('01'); // 输入到 7 位
  await expect(input).toHaveValue('7519401');
  await expect(lenErr).toHaveText('请输入 6 位数字验证码');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(submit).toBeDisabled();
  await input.press('Enter');
  await input.fill('');
  await paste('751 940 1'); // 粘贴 7 位
  await expect(input).toHaveValue('7519401');
  await expect(lenErr).toHaveText('请输入 6 位数字验证码');
  await expect(submit).toBeDisabled();
  await input.press('Enter');
  await page.waitForTimeout(300);
  expect(confirms).toEqual([]); // 没有发出 confirm 请求
  await input.fill('');
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
  await expect(go).toHaveAttribute('href', '/admin-login?callbackUrl=%2Fadmin');
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
  await page.waitForURL(/\/admin-login/);
  const landed = new URL(page.url());
  expect(landed.pathname).toBe('/admin-login');
  expect(landed.searchParams.get('callbackUrl')).toBe('/admin');
});

test('#347 没有 #t= 令牌（直接打开或刷新后）→「需要绑定链接」页，不显示表单，不发任何请求', async ({ page, external }) => {
  const calls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/auth-admin/')) calls.push(r.url()); });
  await page.goto('/admin-enroll');
  await expect(page.getByRole('heading', { level: 1, name: '需要绑定链接' })).toBeVisible();
  await expect(page.getByText('这个页面只能从管理员发给你的绑定链接打开。如果你刚刚刷新了页面，请重新点开那个链接；链接失效的话请联系管理员重新发送。')).toBeVisible();
  await expect(page.getByRole('link', { name: '去登录' })).toHaveAttribute('href', '/admin-login?callbackUrl=%2Fadmin');
  await expect(page.getByLabel('初始密码')).toHaveCount(0);
  expect(calls).toEqual([]);
  expect(external.urls).toEqual([]);
});

test('#347 新文档从绑定链接进入后刷新 → 令牌已清除，显示需要绑定链接', async ({ page, external }) => {
  const calls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/auth-admin/')) calls.push(r.url()); });
  // 新页面模拟从外部绑定链接打开；同文档 hash 导航不会重新挂载向导。
  await page.goto('/admin-enroll#t=' + 'A'.repeat(43));
  await expect(page.getByLabel('初始密码')).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: '需要绑定链接' })).toBeVisible();
  expect(calls).toEqual([]);
  expect(external.urls).toEqual([]);
});

test('已绑定的账号再调 enroll → 401 bad_credentials（#347：确认成功后令牌已用掉）', async ({ request }) => {
  const { email, token } = freshAccount('enrolled');
  const en = await request.post('/api/auth-admin/enroll', { headers: origin, data: { email, password: PASSWORD, token } });
  expect(en.status()).toBe(200);
  const secret = secretOf((await en.json()).otpauthUri);
  const c = await request.post('/api/auth-admin/enroll/confirm', { headers: origin, data: { email, password: PASSWORD, totp: authenticator.generate(secret), token } });
  expect(c.status()).toBe(200);
  const again = await request.post('/api/auth-admin/enroll', { headers: origin, data: { email, password: PASSWORD, token } });
  expect(again.status()).toBe(401);
  expect((await again.json()).error).toBe('bad_credentials');
});

test('#347 只有初始密码没有令牌 → 401；待确认密钥 10 分钟内不能被覆盖：再次 enroll → 429 rate_limited，第一次的密钥仍可确认', async ({ request }) => {
  const { email, token } = freshAccount('rotate');
  const noToken = await request.post('/api/auth-admin/enroll', { headers: origin, data: { email, password: PASSWORD } });
  expect(noToken.status()).toBe(401);
  expect((await noToken.json()).error).toBe('bad_credentials');
  const first = secretOf((await (await request.post('/api/auth-admin/enroll', { headers: origin, data: { email, password: PASSWORD, token } })).json()).otpauthUri);
  const again = await request.post('/api/auth-admin/enroll', { headers: origin, data: { email, password: PASSWORD, token } });
  expect(again.status()).toBe(429);
  expect((await again.json()).error).toBe('rate_limited');
  const ok = await request.post('/api/auth-admin/enroll/confirm', { headers: origin, data: { email, password: PASSWORD, totp: authenticator.generate(first), token } });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).recoveryCodes).toHaveLength(10);
});
