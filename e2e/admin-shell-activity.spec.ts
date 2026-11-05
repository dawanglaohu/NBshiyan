import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';
import { useSharedAdmin } from './shared-admin';

/**
 * M3-T7 统一后台外壳：真实登录 → 角色菜单 → GET account → 真实活动 → signOut。
 *
 * 登录：照 e2e/shared-admin.ts 的模式，用 scripts/create-admin.mjs 建**独立**管理员
 * （唯一 email、ADMIN_SEED_TOTP_SECRET=E2E_TOTP），整组 beforeAll 只登录一次、
 * beforeEach 把 cookie 放进每个用例自己的 page context。
 * 不复用全局 E2E_ADMIN：它会把共享管理员绑掉，让同文件后续用例与 admin.spec.ts 静默 skip，
 * 等于拿覆盖回退换 CI 绿。
 *
 * 视觉证据：test.use({ video: 'on' })，CI 从 test-results 视频转 GIF；本文件在三尺寸下
 * 直接量真实壳元素（顶栏 / 侧栏 / 主内容外框）的 computed style，不量旧业务内层。
 *
 * 证据分级：
 * - 本文件在真实 standalone 服务 + 浏览器里跑，量的是 DOM/请求，不是纯函数。
 * - 服务端 T15 的续期写回与撤销并发由 tests/admin-session-activity.http.test.ts 与
 *   e2e/admin-device-session.spec.ts 覆盖，本卡不重跑、不冒充。
 * - 15 分钟节流 / 隐藏页不发 / 失焦取消由 tests/admin-shell-activity.test.ts 的纯逻辑用例覆盖；
 *   这里只验「真实操作确实发出 POST」与「首帧不报」。
 */
const PASSWORD = 'e2e-shell-Passw0rd!';
const ACCOUNT = '/api/admin/account';

test('后台壳：未登录不能读 account，页面跳登录', async ({ request }) => {
  expect((await request.get(ACCOUNT)).status()).toBe(401);
  const r = await request.get('/admin/inquiries', { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(r.status());
});

test.describe('已登录的 ADMIN（整组共用一次登录，独立管理员）', () => {
  useSharedAdmin({ emailPrefix: 'e2e-shell', name: 'E2E shell', password: PASSWORD, probe: ACCOUNT });
  // 视频留给 CI 转 GIF；本文件不用本机浏览器录。
  test.use({ video: 'on' });

  test('角色菜单来自服务端、账号区读 GET account、signOut 真退出', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.goto(`${BASE}/admin/inquiries`);
    const accountResponse = await page.request.get(ACCOUNT);
    expect(accountResponse.status()).toBe(200);
    const account = await accountResponse.json();
    expect(['ADMIN', 'SALES', 'EDITOR']).toContain(account.role);

    const shellNav = page.getByRole('navigation', { name: '后台导航' });
    await expect(shellNav).toBeVisible();
    await expect(page.getByTestId('admin-account')).toBeVisible();
    await expect(page.getByTestId('admin-signout')).toBeVisible();
    await expect(page.getByTestId('admin-account-role')).toHaveText(account.role);

    // 角色菜单：站点设置仅 ADMIN 可见（本组是独立 ADMIN）。
    const settings = shellNav.getByRole('link', { name: '站点设置' });
    if (account.role === 'ADMIN') await expect(settings).toBeVisible();
    else await expect(settings).toHaveCount(0);

    // 键盘焦点可达：退出控件有可见焦点环。
    await page.getByTestId('admin-signout').focus();
    const outline = await page.getByTestId('admin-signout').evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: s.outlineWidth };
    });
    expect(outline.style).not.toBe('none');
    expect(parseFloat(outline.width)).toBeGreaterThan(0);

    const box = await page.getByTestId('admin-signout').boundingBox();
    if (!box) throw new Error('signout 没有布局盒');
    expect(box.height).toBeGreaterThanOrEqual(44);

    // 真实 Auth.js signOut：点退出后旧 cookie GET account = 401。
    const before = await page.context().storageState();
    await page.getByTestId('admin-signout').click();
    await expect.poll(async () => (await page.request.get(ACCOUNT)).status()).toBe(401);
    const replay = await browser.newContext({ storageState: before });
    expect((await replay.request.get(ACCOUNT)).status()).toBe(401);
    await replay.close();
  });

  test('首帧不报 activity，真实指针/键盘/路由操作才 POST，15 分钟内不重复', async ({ page }) => {
    test.setTimeout(120_000);
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/admin/account/session/activity') posts.push(r.url());
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

  test('三尺寸壳元素 computed style：2px 黑边 / 0 圆角 / 无阴影 / 强调色 #b45700 / 44px / 无横向溢出', async ({ page }) => {
    test.setTimeout(150_000);
    for (const view of [{ width: 1920, height: 1080, label: '1920x1080' }, { width: 1440, height: 900, label: '1440x900' }, { width: 390, height: 844, label: '390x844' }]) {
      await page.setViewportSize(view);
      await page.goto(`${BASE}/admin/inquiries`);
      if (view.width < 768) {
        const menu = page.locator('.adm-menu');
        if (await menu.isVisible()) await menu.click();
      }
      await expect(page.getByTestId('admin-signout')).toBeVisible();

      // 真实壳元素：顶栏、侧栏、主内容外框、当前导航项、退出控件。
      const measured = await page.evaluate(() => {
        const pick = (selector: string) => document.querySelector(selector);
        const box = (selector: string) => {
          const el = pick(selector);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return { w: Math.round(r.width), h: Math.round(r.height), border: s.borderTopWidth, radius: s.borderTopLeftRadius, shadow: s.boxShadow };
        };
        const current = pick('.adm-side a[aria-current=page]');
        const signoutEl = pick('[data-testid="admin-signout"]');
        const hover = signoutEl ? getComputedStyle(signoutEl) : null;
        const rootAccent = getComputedStyle(document.documentElement).getPropertyValue('--pj-accent').trim();
        return {
          top: box('.adm-top'),
          side: box('.adm-side'),
          main: box('.adm-main'),
          currentBg: current ? getComputedStyle(current).backgroundColor : null,
          currentColor: current ? getComputedStyle(current).color : null,
          currentAccentBorder: current ? getComputedStyle(current).borderLeftColor : null,
          signout: box('[data-testid="admin-signout"]'),
          signoutMinHeight: hover?.minHeight ?? null,
          rootAccent,
          noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        };
      });

      // 三个壳容器：2px 边框、0 圆角、无阴影。
      for (const [name, el] of Object.entries({ top: measured.top, side: measured.side, main: measured.main })) {
        expect(el, `${view.label} ${name} 必须有布局盒`).not.toBeNull();
        expect(el!.border, `${view.label} ${name} 边框宽度`).toBe('2px');
        expect(el!.radius, `${view.label} ${name} 圆角`).toBe('0px');
        expect(el!.shadow, `${view.label} ${name} 阴影`).toBe('none');
      }
      // 当前导航项：黑白反转，不靠颜色单独传义；左边框用强调色标记当前入口。
      expect(measured.currentBg, `${view.label} 当前导航底色`).toBe('rgb(255, 255, 255)');
      expect(measured.currentColor, `${view.label} 当前导航文字色`).toBe('rgb(0, 0, 0)');
      expect(measured.currentAccentBorder, `${view.label} 当前导航强调色标记`).toBe('rgb(180, 87, 0)');
      // 强调色 #b45700：从 :root 的 --pj-accent 直接读实际值，并核壳样式确实消费该 token。
      expect(measured.rootAccent, `${view.label} 强调色 token`).toBe('#b45700');
      const usesAccent = await page.evaluate(() => {
        const css = [...document.styleSheets].flatMap((sheet) => {
          try { return [...sheet.cssRules]; } catch { return []; }
        });
        return css.some((rule) => rule.cssText?.includes('var(--pj-accent)'));
      });
      expect(usesAccent, `${view.label} 壳样式必须消费 --pj-accent`).toBe(true);
      // 触屏目标 ≥44px（桌面与窄屏都量）；退出控件同为 2px/0/无阴影。
      expect(parseFloat(measured.signoutMinHeight ?? '0'), `${view.label} 退出控件触屏目标`).toBeGreaterThanOrEqual(44);
      expect(measured.signout!.border, `${view.label} 退出控件边框`).toBe('2px');
      expect(measured.signout!.radius, `${view.label} 退出控件圆角`).toBe('0px');
      expect(measured.signout!.shadow, `${view.label} 退出控件阴影`).toBe('none');
      expect(measured.noHorizontalOverflow, `${view.label} 横向溢出`).toBe(true);
    }
  });
});
