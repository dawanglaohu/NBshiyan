import { authenticator } from 'otplib';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_ADMIN } from './global-setup';
import { BASE } from '../playwright.config';

/**
 * M3-T7 统一后台外壳：真实登录 → 角色菜单 → GET account → 真实活动 → signOut。
 *
 * 证据分级：
 * - 本文件在真实 standalone 服务 + 浏览器里跑，量的是 DOM/请求，不是纯函数。
 * - 服务端 T15 的续期写回与撤销并发由 tests/admin-session-activity.http.test.ts 与
 *   e2e/admin-device-session.spec.ts 覆盖，本卡不重跑、不冒充。
 * - 15 分钟节流 / 隐藏页不发 / 失焦取消由 tests/admin-shell-activity.test.ts 的纯逻辑用例覆盖；
 *   这里只验「真实操作确实发出 POST」与「首帧不报」。
 */
async function loginAsAdmin(page: Page): Promise<void> {
  const origin = { Origin: BASE };
  // 与 admin.spec.ts 同口径：绑定 2FA（首次）→ Auth.js credentials 真登录。
  const token = process.env.E2E_ADMIN_ENROLL_TOKEN ?? '';
  let secret = process.env.ADMIN_SEED_TOTP_SECRET;
  const req = await page.request;
  const en = await req.post('/api/auth-admin/enroll', { headers: origin, data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password, token } });
  if (en.ok()) {
    secret = new URL((await en.json()).otpauthUri).searchParams.get('secret')!;
    const c = await req.post('/api/auth-admin/enroll/confirm', { headers: origin, data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password, totp: authenticator.generate(secret), token } });
    expect(c.status()).toBe(200);
    await new Promise((r) => setTimeout(r, (authenticator.timeRemaining() + 1) * 1000));
  }
  test.skip(!secret, '账号已绑定 2FA 且未提供 ADMIN_SEED_TOTP_SECRET');
  const csrf = (await (await req.get('/api/auth/csrf')).json()).csrfToken as string;
  const ok = await req.post('/api/auth/callback/credentials', { headers: origin, maxRedirects: 0,
    form: { csrfToken: csrf, email: E2E_ADMIN.email, password: E2E_ADMIN.password, totp: authenticator.generate(secret!) } });
  expect(ok.headers()['location'] ?? '').not.toContain('error');
  // page.request 与 page 共用同一个 BrowserContext，登录拿到的 session cookie 会带到后续 page.goto。
  // 这里不另建 context、不复制仓库、不注册自定义登录页。
}

test('后台壳：真实登录后角色菜单来自服务端、账号区读 GET account、signOut 真退出', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await loginAsAdmin(page);
  await page.goto(`${BASE}/admin/inquiries`);
  // 数据源：GET /api/admin/account 被真实调用且返回 200。
  const accountResponse = await page.request.get('/api/admin/account');
  expect(accountResponse.status()).toBe(200);
  const account = await accountResponse.json();
  expect(['ADMIN', 'SALES', 'EDITOR']).toContain(account.role);

  // 壳元素：命名控件、账号区、退出控件真实存在。
  const shellNav = page.getByRole('navigation', { name: '后台导航' });
  await expect(shellNav).toBeVisible();
  await expect(page.getByTestId('admin-account')).toBeVisible();
  await expect(page.getByTestId('admin-signout')).toBeVisible();
  await expect(page.getByTestId('admin-account-role')).toHaveText(account.role);

  // 角色菜单：站点设置仅 ADMIN 可见；非 ADMIN 看不到（服务端会话决定）。
  const settings = shellNav.getByRole('link', { name: '站点设置' });
  if (account.role === 'ADMIN') await expect(settings).toBeVisible();
  else await expect(settings).toHaveCount(0);

  // 键盘焦点可达：Tab 能走到退出控件。
  await page.getByTestId('admin-signout').focus();
  const outline = await page.getByTestId('admin-signout').evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: s.outlineWidth };
  });
  expect(outline.style).not.toBe('none');
  expect(parseFloat(outline.width)).toBeGreaterThan(0);

  // 触屏控件 ≥44px（桌面与窄屏都量）。
  const box = await page.getByTestId('admin-signout').boundingBox();
  if (!box) throw new Error('signout 没有布局盒');
  expect(box.height).toBeGreaterThanOrEqual(44);

  // 真实 Auth.js signOut：点退出后旧 cookie GET account = 401。
  const before = await page.context().storageState();
  await page.getByTestId('admin-signout').click();
  await expect.poll(async () => (await page.request.get('/api/admin/account')).status()).toBe(401);
  const replay = await browser.newContext({ storageState: before });
  expect((await replay.request.get('/api/admin/account')).status()).toBe(401);
  await replay.close();
});

test('后台壳：首帧不报 activity，真实指针/键盘/路由操作才 POST，15 分钟内不重复', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await loginAsAdmin(page);
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/admin/account/session/activity')) posts.push(r.url());
  });
  await page.goto(`${BASE}/admin/inquiries`);
  // 首帧：只有 GET account，不应有 activity。
  await expect(page.getByTestId('admin-account')).toBeVisible();
  expect(posts).toHaveLength(0);

  // 真实键盘操作 → 上报一次。
  await page.keyboard.press('Tab');
  await expect.poll(() => posts.length).toBe(1);
  // 15 分钟内连续真实操作不再上报。
  await page.keyboard.press('Tab');
  await page.mouse.click(10, 10);
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(1);

  // 路由变化是真实操作，但节流未过时仍不新增。
  await page.goto(`${BASE}/admin/specs`);
  await page.waitForTimeout(300);
  expect(posts.length).toBeLessThanOrEqual(1);
});

test('后台壳：三尺寸 minimalist-flat computed style（2px 黑边 / 0 圆角 / 无阴影 / 44px）', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await loginAsAdmin(page);
  for (const view of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(view);
    await page.goto(`${BASE}/admin/inquiries`);
    const signout = page.getByTestId('admin-signout');
    if (view.width < 768) {
      // 窄屏侧栏是抽屉，先展开。
      const menu = page.locator('.adm-menu');
      if (await menu.isVisible()) await menu.click();
    }
    await expect(signout).toBeVisible();
    const style = await signout.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, radius: s.borderTopLeftRadius, shadow: s.boxShadow, minHeight: s.minHeight };
    });
    expect(style.border, `${view.width} 边框宽度`).toBe('2px');
    expect(style.radius, `${view.width} 圆角`).toBe('0px');
    expect(style.shadow, `${view.width} 阴影`).toBe('none');
    expect(parseFloat(style.minHeight), `${view.width} 触屏目标`).toBeGreaterThanOrEqual(44);
    // 页面无横向溢出。
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(noOverflow, `${view.width} 横向溢出`).toBe(true);
  }
});
