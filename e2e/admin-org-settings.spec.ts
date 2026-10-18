import { execFileSync } from 'node:child_process';
import { authenticator } from 'otplib';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';
import type { Page } from '@playwright/test';

// #350 /admin/settings?section=org「组织信息」：真实页面 + 真实接口（#367），仅 E2E 测试库。
// 每次新建一个 ADMIN 账号（scripts/create-admin.mjs；ADMIN_SEED_TOTP_SECRET 只在非生产可用），登录用 page.request，cookie 和页面共用。
const PASSWORD = 'e2e-org-Passw0rd!';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // 测试用假密钥
const origin = { Origin: BASE };
const API = '/api/admin/site-settings/organization';

async function loginFreshAdmin(page: Page) {
  const email = `e2e-org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  execFileSync('node', ['scripts/create-admin.mjs'], {
    stdio: 'pipe',
    env: { ...process.env, ADMIN_SEED_EMAIL: email, ADMIN_SEED_PASSWORD: PASSWORD, ADMIN_SEED_NAME: 'E2E org', ADMIN_SEED_ROLE: 'ADMIN', ADMIN_SEED_TOTP_SECRET: TOTP },
  });
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrfToken as string;
  const ok = await page.request.post('/api/auth/callback/credentials', { headers: origin, form: { csrfToken: csrf, email, password: PASSWORD, totp: authenticator.generate(TOTP) }, maxRedirects: 0 });
  expect(ok.headers()['location'] ?? '').not.toContain('error');
  expect((await page.request.get(API)).status()).toBe(200);
}

test('组织信息：分区导航、占位不预填、计数器、社交主页上限、保存、409 保留输入 + 刷新确认', async ({ page }) => {
  test.setTimeout(90_000);
  await loginFreshAdmin(page);
  // 从干净的状态开始（测试库可能被前一次运行写过）
  const cur = await (await page.request.get(API)).json();
  const clear = await page.request.put(API, { headers: origin, data: { expectedVersion: cur.version, sameAs: [] } });
  expect(clear.status()).toBe(200);

  const res = await page.goto('/admin/settings?section=org');
  expect(res!.status()).toBe(200);
  const nav = page.getByRole('navigation', { name: '站点设置分区' });
  await expect(nav.getByRole('link', { name: '组织信息' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: '关于我们' })).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 1, name: '组织信息' })).toBeVisible();
  await expect(page.getByText('这些信息会出现在搜索引擎的结构化数据里，不确定的就不要填。')).toBeVisible();

  // 默认值只是占位，不预填
  const name = page.getByLabel('公司名称（对外）');
  await expect(name).toHaveValue('');
  await expect(name).toHaveAttribute('placeholder', 'PackJoyU');
  await expect(page.getByLabel('别名')).toHaveAttribute('placeholder', '保乐优');
  await expect(page.getByLabel('网站地址（只读）')).toHaveValue(BASE);
  await expect(page.getByLabel('网站地址（只读）')).toHaveAttribute('readonly', '');

  // 计数器按 code point：150 个 emoji = 150 字
  const desc = page.getByLabel('一句话介绍（英文）');
  await desc.fill('😀'.repeat(150));
  await expect(page.locator('#st-org-description-c')).toHaveText('150/300');
  await desc.fill('a'.repeat(270));
  await expect(page.locator('#st-org-description-c')).toHaveClass(/warn/);
  await desc.fill('a'.repeat(301));
  await expect(page.locator('#st-org-description-c')).toHaveClass(/bad/);
  await expect(page.getByText('超出上限：301 / 300')).toBeVisible();
  const save = page.getByRole('region', { name: '保存' }).getByRole('button', { name: '保存' });
  await expect(save).toBeDisabled();
  await desc.fill('');

  // 邮箱格式（离开输入框后提示）
  const email = page.getByLabel('对外联系邮箱');
  await email.fill('example@example');
  await email.blur();
  await expect(page.getByText('邮箱格式不正确')).toBeVisible();
  await expect(save).toBeDisabled();
  await email.fill('example@example.com');
  await expect(page.getByText('邮箱格式不正确')).toHaveCount(0);

  // 社交主页：最多 10 条，满了「添加链接」禁用 +「最多 10 条」
  const add = page.getByRole('button', { name: '＋ 添加链接' });
  for (let i = 1; i <= 10; i++) {
    await add.click();
    await page.getByLabel(`社交主页链接（第 ${i} 条）`).fill(`https://example.com/sample-${i}`);
  }
  await expect(add).toBeDisabled();
  await expect(page.getByText('最多 10 条', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除第 10 条链接' }).click();
  await expect(add).toBeEnabled();
  await page.getByLabel('社交主页链接（第 9 条）').fill('https://example.com/sample-1'); // 重复：保存时自动去掉
  await expect(page.getByText('和上面的链接重复，保存时会自动去掉')).toBeVisible();

  await page.getByLabel('公司注册全称').fill('示例文字 Sample Co., Ltd.');
  await expect(page.getByRole('region', { name: '保存' })).toContainText('基本信息、联系方式、其他');
  await save.click();
  await expect(page.getByRole('status')).toHaveText('✓ 已保存，前台约 1 分钟内生效');
  await expect(page.getByLabel(/社交主页链接/)).toHaveCount(8); // 去重后 8 条
  const after = await (await page.request.get(API)).json();
  expect(after.legalName).toBe('示例文字 Sample Co., Ltd.');
  expect(after.email).toBe('example@example.com');
  expect(after.sameAs).toHaveLength(8);

  // 别人先保存（版本 +1）→ 我这边保存 409：输入保留、横幅 +「刷新」、保存禁用、只发一次 PUT
  const other = await page.request.put(API, { headers: origin, data: { expectedVersion: after.version, legalName: 'Other Co.', sameAs: [] } });
  expect(other.status()).toBe(200);
  const puts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith(API)) puts.push(r.url()); });
  await page.getByLabel('对外电话').fill('+86 000 0000 0000');
  await save.click();
  const banner = page.getByRole('alert').filter({ hasText: '内容已被他人修改，请刷新后重新编辑' });
  await expect(banner).toBeVisible();
  await expect(page.getByLabel('对外电话')).toHaveValue('+86 000 0000 0000');
  await expect(save).toBeDisabled();
  await page.locator('#st-org-address').fill('still editable');
  await expect(save).toBeDisabled();
  expect(puts).toHaveLength(1);

  // 刷新 → 确认框；取消留在原页；丢弃并刷新 → 读最新内容和 version
  await banner.getByRole('button', { name: '刷新' }).click();
  const dlg = page.getByRole('alertdialog', { name: '未保存的修改将丢弃' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: '取消' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(banner).toBeVisible();
  await expect(page.getByLabel('对外电话')).toHaveValue('+86 000 0000 0000');
  await banner.getByRole('button', { name: '刷新' }).click();
  await dlg.getByRole('button', { name: '丢弃并刷新' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByLabel('公司注册全称')).toHaveValue('Other Co.');
  await expect(page.getByLabel('对外电话')).toHaveValue('');
  expect(puts).toHaveLength(1);

  // 用最新 version 再保存就成功
  await page.getByLabel('对外电话').fill('+86 000 0000 0000');
  await save.click();
  await expect(page.getByRole('status')).toHaveText('✓ 已保存，前台约 1 分钟内生效');
  expect(puts).toHaveLength(2);

  // 关于我们分区照常
  await nav.getByRole('link', { name: '关于我们' }).click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(page.getByRole('navigation', { name: '站点设置分区' }).getByRole('link', { name: '关于我们' })).toHaveAttribute('aria-current', 'page');
});

test('组织信息：未登录不能读接口，页面跳登录', async ({ request }) => {
  expect((await request.get(API)).status()).toBe(401);
  const r = await request.get('/admin/settings?section=org', { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(r.status());
});
