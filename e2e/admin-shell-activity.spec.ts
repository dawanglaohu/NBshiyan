import { writeFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';
import { useSharedAdmin } from './shared-admin';

/**
 * M3-T7 统一后台外壳：真实登录 → 角色菜单 → GET account → 真实活动 → signOut。
 *
 * 登录：照 e2e/shared-admin.ts 的模式，用 scripts/create-admin.mjs 建**独立**管理员
 * （唯一 email、ADMIN_SEED_TOTP_SECRET=E2E_TOTP），每组 beforeAll 只登录一次、
 * beforeEach 把 cookie 放进每个用例自己的 page context。
 * 不复用全局 E2E_ADMIN：它会把共享管理员绑掉，让同文件后续用例与 admin.spec.ts 静默 skip。
 *
 * 为什么 signOut 单独一组会话：signOut 会撤销该设备会话，若与其它用例共用 beforeAll 的
 * 旧 cookie，后续 beforeEach 注入的旧 cookie 已失效，会 401 落到登录页。这里给 signOut
 * 单独建管理员/会话，不依赖用例执行顺序（即使将来 workers/fullyParallel 变化也不互相污染）。
 *
 * 视觉证据：`test.use({ video: 'on' })` 写在**文件顶层一次**（Playwright 不允许放在 describe 内，
 * 会强制新 worker、收集阶段直接报错）；CI 从 test-results 视频转 GIF；三尺寸下量真实壳元素。
 * `.adm-top` 桌面断点 display:none，只在窄屏（<768）断言；桌面量始终可见的 .adm-side/.adm-main。
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

/** 侧栏 `.adm-account` 面板几何帧（只读采集，不含 cookie/token/账号邮箱）。 */
type AccountFrame = {
  state: string;
  viewport: string;
  panel: {
    w: number; h: number;
    padTop: string; padRight: string; padBottom: string; padLeft: string;
    rowGap: string; columnGap: string; minHeight: string;
    display: string; flexDirection: string; visibility: string;
  };
  kids: Array<{ tag: string; cls: string; top: number; left: number; w: number; h: number }>;
  textLen: number;
};

/** 11 节 / density_probe.js 既有阈值，不自造更宽阈值。 */
const ACCOUNT_DENSITY = { padMax: 20, gapMax: 24, leftMax: 40, nearMax: 24, sparsePad: 32, sparseHeight: 80, sparseText: 120 };

/**
 * 独立判定：D4 是 CSS 值（padding / gap），D5 是几何布局结果（内容左上、computed min-height、
 * 底部留白、子项间距、稀疏撑高块）。五项 D5 互不重复，也不拿 D4 通过充当 D5 通过。
 */
function judgeAccountFrame(f: AccountFrame) {
  const p = f.panel;
  const pads = [p.padTop, p.padRight, p.padBottom, p.padLeft].map((v) => parseFloat(v) || 0);
  const padMax = Math.max(...pads);
  const rowGap = parseFloat(p.rowGap) || 0;
  const colGap = parseFloat(p.columnGap) || 0;
  const minHeightPx = parseFloat(p.minHeight) || 0;
  const kids = f.kids || [];
  const contentTop = kids.length ? Math.min(...kids.map((k) => k.top)) : null;
  const contentLeft = kids.length ? Math.min(...kids.map((k) => k.left)) : null;
  const contentBottom = kids.length ? Math.max(...kids.map((k) => k.top + k.h)) : null;
  const sorted = kids.slice().sort((a, b) => a.top - b.top);
  let worstChildGap = 0;
  for (let i = 1; i < sorted.length; i++) worstChildGap = Math.max(worstChildGap, sorted[i].top - (sorted[i - 1].top + sorted[i - 1].h));
  const bottomWhitespace = contentBottom !== null ? p.h - contentBottom - pads[2] : null;

  const d4 = {
    paddingLe20: padMax <= ACCOUNT_DENSITY.padMax,
    rowGapLe24: rowGap <= ACCOUNT_DENSITY.gapMax,
    colGapLe24: colGap <= ACCOUNT_DENSITY.gapMax,
  };
  const d5 = {
    // 局部左上：内容顶部/左边缘紧贴 padding 内边，无大块居中留白
    contentTopNear: contentTop !== null && contentTop - pads[0] <= ACCOUNT_DENSITY.nearMax,
    contentLeftNear: contentLeft !== null && contentLeft - pads[3] <= ACCOUNT_DENSITY.nearMax,
    // 无空 min-height 撑高：computed min-height 不把面板撑到内容之外
    minHeightNoStretch: minHeightPx === 0 || (contentBottom !== null && minHeightPx <= contentBottom),
    // 底部无大块留白 / 居中插画
    bottomWhitespaceSmall: bottomWhitespace !== null && bottomWhitespace <= ACCOUNT_DENSITY.nearMax,
    // 子项之间无大块竖向空白
    childGapSmall: worstChildGap <= ACCOUNT_DENSITY.gapMax,
    // 探针 D5 稀疏撑高块语义（用真实采集值，不依赖前面 pad<=20 的结论）
    notSparseBlock: !(padMax >= ACCOUNT_DENSITY.sparsePad && p.h >= ACCOUNT_DENSITY.sparseHeight && f.textLen < ACCOUNT_DENSITY.sparseText && kids.length <= 4),
  };
  return {
    d4: { ...d4, pass: Object.values(d4).every(Boolean) },
    d5: { ...d5, pass: Object.values(d5).every(Boolean) },
    metrics: { padMax, rowGap, colGap, minHeightPx, contentTop, contentLeft, contentBottom, worstChildGap, bottomWhitespace, textLen: f.textLen, kidCount: kids.length },
  };
}

/** 注入浏览器：只读 MutationObserver。仅在样式已生效、panel 可见且非零尺寸时把 state 记 seen，否则继续等有效帧。 */
function installAccountObserver(): void {
  const frames: unknown[] = [];
  (window as unknown as { __admAccountFrames: unknown[] }).__admAccountFrames = frames;
  const snap = (state: string): boolean => {
    const panel = document.querySelector('.adm-account') as HTMLElement | null;
    if (!panel) return false;
    const pr = panel.getBoundingClientRect();
    const ps = getComputedStyle(panel);
    if (ps.display === 'none' || ps.visibility === 'hidden' || pr.width < 1 || pr.height < 1) return false;
    if (!ps.paddingTop || ps.minHeight === undefined || ps.minHeight === null) return false;
    const kids = Array.from(panel.children).map((c) => {
      const r = c.getBoundingClientRect();
      return {
        tag: c.tagName.toLowerCase(), cls: String(c.getAttribute('class') || ''),
        top: Math.round(r.top - pr.top), left: Math.round(r.left - pr.left),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    });
    frames.push({
      state, viewport: `${window.innerWidth}x${window.innerHeight}`,
      panel: {
        w: Math.round(pr.width), h: Math.round(pr.height),
        padTop: ps.paddingTop, padRight: ps.paddingRight, padBottom: ps.paddingBottom, padLeft: ps.paddingLeft,
        rowGap: ps.rowGap, columnGap: ps.columnGap, minHeight: ps.minHeight,
        display: ps.display, flexDirection: ps.flexDirection, visibility: ps.visibility,
      },
      kids, textLen: (panel.textContent || '').trim().length,
    });
    return true;
  };
  const seen: Record<string, boolean> = {};
  const scan = () => {
    if (!seen.loading && document.querySelector('.adm-account-loading')) { if (snap('loading')) seen.loading = true; }
    if (!seen.data && document.querySelector('.adm-account-name')) { if (snap('data')) seen.data = true; }
    if (!seen.cleared && document.querySelector('.adm-account-cleared')) { if (snap('cleared')) seen.cleared = true; }
  };
  new MutationObserver(scan).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  document.addEventListener('DOMContentLoaded', scan);
  if (document.readyState !== 'loading') requestAnimationFrame(scan);
}

async function readAccountFrames(page: import('@playwright/test').Page): Promise<AccountFrame[]> {
  return (await page.evaluate(() => {
    const w = window as unknown as { __admAccountFrames?: unknown };
    return w.__admAccountFrames ?? [];
  })) as AccountFrame[];
}

// Playwright 只允许 video 在文件顶层或 config：写在 describe 内会强制新 worker，
// 收集阶段直接报 "Cannot use({ video }) in a describe group"。整文件一次，两组共用。
// CI 从 test-results 视频转 GIF；本文件不用本机浏览器录。
test.use({ video: 'on' });

test('后台壳：未登录不能读 account，页面跳登录', async ({ request }) => {
  expect((await request.get(ACCOUNT)).status()).toBe(401);
  const r = await request.get('/admin/inquiries', { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(r.status());
});

test.describe('后台壳主体（独立管理员，整组一次登录）', () => {
  useSharedAdmin({ emailPrefix: 'e2e-shell', name: 'E2E shell', password: PASSWORD, probe: ACCOUNT });

  test('角色菜单来自服务端、账号区读 GET account、退出控件可达', async ({ page }) => {
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

      // 真实壳元素：侧栏、主内容外框始终可见；顶栏桌面 display:none，只在窄屏量。
      const measured = await page.evaluate(() => {
        const pick = (selector: string) => document.querySelector(selector);
        const box = (selector: string) => {
          const el = pick(selector);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return { w: Math.round(r.width), h: Math.round(r.height), border: s.borderTopWidth, radius: s.borderTopLeftRadius, shadow: s.boxShadow, display: s.display };
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

      // 始终可见的壳容器：2px 边框、0 圆角、无阴影。
      for (const [name, el] of Object.entries({ side: measured.side, main: measured.main })) {
        expect(el, `${view.label} ${name} 必须有布局盒`).not.toBeNull();
        expect(el!.border, `${view.label} ${name} 边框宽度`).toBe('2px');
        expect(el!.radius, `${view.label} ${name} 圆角`).toBe('0px');
        expect(el!.shadow, `${view.label} ${name} 阴影`).toBe('none');
      }
      // 顶栏：桌面 display:none 不是可见外框，只在窄屏（<768）断言其 2px/0/none。
      if (view.width < 768) {
        expect(measured.top!.display, '390 顶栏必须可见').not.toBe('none');
        expect(measured.top!.border, '390 顶栏边框').toBe('2px');
        expect(measured.top!.radius, '390 顶栏圆角').toBe('0px');
        expect(measured.top!.shadow, '390 顶栏阴影').toBe('none');
      } else {
        expect(measured.top!.display, `${view.label} 顶栏桌面隐藏`).toBe('none');
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

  /**
   * 补证：侧栏 `.adm-account` 面板（被 density_probe.js 的 rail 排除，14 次既有 main 探针量不到）
   * 的真实 data / loading 态 D4 / D5 几何，以及同元素跨断点 D1 间距。
   *
   * 只读观测：addInitScript 里挂 MutationObserver，仅在样式已生效、panel 可见且非零尺寸时
   * 记录真实 getBoundingClientRect / getComputedStyle；不改 DOM / CSS / React state，
   * 不注入 localStorage / sessionStorage，不伪造会话或业务记录。CDP 标准网络限速只用于让
   * 客户端 GET account 稍慢、使 loading 帧有稳定观测窗口，响应仍是真实服务端数据，
   * 不用 route.fulfill 模拟任何账号或 401。401-cleared 态另见本文件末尾独立会话补证。
   * D4（CSS 值）与 D5（几何布局结果）用 judgeAccountFrame 独立判定，不互相充当。
   */
  test('壳内账号区 data/loading 态的 D4/D5 与跨断点 D1 间距（补证）', async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    await page.addInitScript(installAccountObserver);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 250, downloadThroughput: -1, uploadThroughput: -1 });
    const all: AccountFrame[] = [];
    for (const view of [{ width: 1920, height: 1080, label: '1920x1080' }, { width: 1440, height: 900, label: '1440x900' }]) {
      await page.setViewportSize(view);
      await page.goto(`${BASE}/admin/inquiries`, { waitUntil: 'load' });
      await expect(page.getByTestId('admin-account-role')).toBeVisible({ timeout: 20_000 });
      all.push(...(await readAccountFrames(page)).filter((f) => f.viewport === view.label));
    }
    await cdp.detach();

    const checked: Array<Record<string, unknown>> = [];
    for (const label of ['1920x1080', '1440x900']) {
      const vf = all.filter((f) => f.viewport === label);
      // 缺帧明确失败，不用非法/空帧伪填通过。
      expect(vf.some((f) => f.state === 'loading'), `${label} 须采集到样式已生效的真实 loading 有效帧`).toBe(true);
      expect(vf.some((f) => f.state === 'data'), `${label} 须采集到样式已生效的真实 data 有效帧`).toBe(true);
      for (const f of vf) {
        const j = judgeAccountFrame(f);
        const tag = `${label} ${f.state}`;
        expect(j.d4.paddingLe20, `${tag} D4 padding≤20（实际 ${j.metrics.padMax}）`).toBe(true);
        expect(j.d4.rowGapLe24, `${tag} D4 row-gap≤24（实际 ${j.metrics.rowGap}）`).toBe(true);
        expect(j.d4.colGapLe24, `${tag} D4 column-gap≤24（实际 ${j.metrics.colGap}）`).toBe(true);
        // D5 五项独立有效断言（几何布局），不拿 D4 通过重复充当 D5 通过：
        expect(j.d5.contentTopNear, `${tag} D5 内容靠上（top ${j.metrics.contentTop}）`).toBe(true);
        expect(j.d5.contentLeftNear, `${tag} D5 内容靠左（left ${j.metrics.contentLeft}）`).toBe(true);
        expect(j.d5.minHeightNoStretch, `${tag} D5 无空 min-height 撑高（${j.metrics.minHeightPx}）`).toBe(true);
        expect(j.d5.bottomWhitespaceSmall, `${tag} D5 底部无大块留白（${j.metrics.bottomWhitespace}）`).toBe(true);
        expect(j.d5.childGapSmall, `${tag} D5 子项无大块间距（${j.metrics.worstChildGap}）`).toBe(true);
        expect(j.d5.notSparseBlock, `${tag} D5 非稀疏撑高块`).toBe(true);
        checked.push({ viewport: label, state: f.state, panel: f.panel, kids: f.kids, metrics: j.metrics, d4: j.d4, d5: j.d5 });
      }
    }
    // D1：两档断点同元素 padding / gap 不随宽度增大
    const d1920 = all.find((f) => f.viewport === '1920x1080' && f.state === 'data');
    const d1440 = all.find((f) => f.viewport === '1440x900' && f.state === 'data');
    expect(d1920 && d1440, '两档都须有 data 帧供 D1 对比').toBeTruthy();
    const d1 = {
      padLeftEqual: d1920!.panel.padLeft === d1440!.panel.padLeft,
      padTopEqual: d1920!.panel.padTop === d1440!.panel.padTop,
      gapEqual: d1920!.panel.rowGap === d1440!.panel.rowGap,
      values: { x1920: { padLeft: d1920!.panel.padLeft, rowGap: d1920!.panel.rowGap }, x1440: { padLeft: d1440!.panel.padLeft, rowGap: d1440!.panel.rowGap } },
    };
    expect(d1.padLeftEqual && d1.padTopEqual && d1.gapEqual, 'D1 断点变宽不增大 padding/gap').toBe(true);

    const report = {
      suite: 'M3-T7 admin-account density supplement (#529)',
      selector: '.adm-account', rail: 'nav#adm-nav（既有 14 次 main 探针排除侧栏，本补证直接量面板）',
      viewports: ['1920x1080', '1440x900'], statesMeasured: ['data', 'loading'],
      thresholds: ACCOUNT_DENSITY,
      sampling: '样式已生效、panel 可见且非零尺寸才记有效帧；缺帧即失败',
      d4Definition: 'CSS 值：padding≤20 / row-gap≤24 / column-gap≤24',
      d5Definition: '几何布局：内容左上、computed min-height 不撑高、底部留白、子项间距、稀疏撑高块；与 D4 独立',
      frames: checked, d1,
      cleared401: { scope: '本用例只采 data/loading；401-cleared 的构造结果见独立会话补证报告 admin-account-cleared.json，不在此伪填。' },
      note: '390x844 仅沿用既有 44px 触控与无横向溢出证据，不伪填手机 D1–D6；card 不是本卡新增页面类型，不新造 card 页面。',
      pass: true,
    };
    const reportPath = testInfo.outputPath('admin-account-density.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach('admin-account-density', { path: reportPath, contentType: 'application/json' });
  });
});

// signOut 会撤销设备会话，单独建管理员/会话，不与上面的 beforeAll 旧 cookie 共用。
test.describe('admin-signout 真退出（独立会话）', () => {
  useSharedAdmin({ emailPrefix: 'e2e-shell-signout', name: 'E2E shell signout', password: PASSWORD, probe: ACCOUNT });

  test('点 admin-signout 执行真实 Auth.js signOut，旧 cookie GET account=401', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.goto(`${BASE}/admin/inquiries`);
    await expect(page.getByTestId('admin-signout')).toBeVisible();
    expect((await page.request.get(ACCOUNT)).status()).toBe(200);

    // 真实 Auth.js signOut：点退出后旧 cookie GET account = 401。
    const before = await page.context().storageState();
    await page.getByTestId('admin-signout').click();
    await expect.poll(async () => (await page.request.get(ACCOUNT)).status()).toBe(401);
    const replay = await browser.newContext({ storageState: before });
    expect((await replay.request.get(ACCOUNT)).status()).toBe(401);
    await replay.close();
  });
});

/**
 * 401-cleared 态补证（独立会话，不污染主体组共享管理员/会话）。
 *
 * 时序：整页 goto 时 layout 服务端 checkAdminSession 通过、壳 DOM 已挂载；客户端 AdminShell
 * mount 的 getAccount（useEffect）发出后被 CDP 标准网络限速挂起；此时用**另一真实请求**
 * （独立 request context 复制会话 cookie，发真实 Auth.js /api/auth/signout）撤销服务端设备会话；
 * 放开限速后客户端 GET /api/admin/account 命中已撤销会话返回 401，AdminShell.tsx:38-41 只
 * setAccount(null)/setAccountCleared(true)，不 assign，页面保留壳 DOM 并渲染 .adm-account-cleared。
 *
 * 不 route.fulfill、不拦改本应用响应、不写 DB 绕过产品、不改 src、不注入存储；
 * 401 由真实受保护请求产生，signout 走真实 Auth.js 端点。只读 observer 采有效帧。
 * 若竞争窗口本次未构造成功，如实记录时序/请求结果标「本次未构造/未捕获」，不伪填通过，
 * 也不下「实现不可能 / 须改产品」的定论（mount 路径确实不跳转）。
 */
test.describe('admin-account 401-cleared 态布局补证（独立会话）', () => {
  useSharedAdmin({ emailPrefix: 'e2e-shell-cleared', name: 'E2E shell cleared', password: PASSWORD, probe: ACCOUNT });

  test('SSR 挂载后另一真实请求撤销会话，客户端 GET account 401 触发 .adm-account-cleared', async ({ page, playwright }, testInfo) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(installAccountObserver);
    const sessionState = await page.context().storageState();

    // CDP 标准网络限速：只让客户端 GET account 在 hydration 后稍慢到达服务端，制造竞争窗口。
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });

    // SSR 校验此刻仍有效 → 壳 DOM 挂载；不等 account 完成。
    await page.goto(`${BASE}/admin/inquiries`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('admin-account')).toBeVisible({ timeout: 20_000 });
    const shellMounted = true;

    // 另一真实请求：独立 context 用同一会话发真实 Auth.js signout（不拦改本应用响应、不写 DB）。
    const revoker = await playwright.request.newContext({ baseURL: BASE, storageState: sessionState });
    const csrf = (await (await revoker.get('/api/auth/csrf')).json()).csrfToken as string;
    const signout = await revoker.post('/api/auth/signout', { maxRedirects: 0, headers: { Origin: BASE }, form: { csrfToken: csrf, callbackUrl: `${BASE}/admin-login` } });
    const signoutStatus = signout.status();
    // 真实受保护请求确认会话已撤销（复制旧 state 的新 context，不复用 revoker 已清的 cookie）。
    const replay = await playwright.request.newContext({ baseURL: BASE, storageState: sessionState });
    const replayStatus = (await replay.get(ACCOUNT)).status();

    // 放开限速，让被挂起的客户端 GET account 打到已撤销会话上。
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    let clearedTextVisible = false;
    try {
      await expect(page.getByRole('status').filter({ hasText: '会话已失效' })).toBeVisible({ timeout: 8_000 });
      clearedTextVisible = true;
    } catch { /* 未构造成功：如实记录，不伪填 */ }
    const frames = await readAccountFrames(page);
    const cleared = frames.filter((f) => f.state === 'cleared');
    const urlAfter = page.url();
    await cdp.detach();
    await revoker.dispose();
    await replay.dispose();

    const captured = cleared.length > 0 && clearedTextVisible;
    const judged = cleared.map((f) => ({ frame: f, d4: judgeAccountFrame(f).d4, d5: judgeAccountFrame(f).d5, metrics: judgeAccountFrame(f).metrics }));
    if (captured) {
      // 真实捕获才做 D4/D5 判定；独立几何断言，不拿 D4 充当 D5。
      for (const j of judged) {
        expect(j.d4.pass, 'cleared 态 D4 全项通过').toBe(true);
        expect(j.d5.pass, 'cleared 态 D5 全项通过').toBe(true);
        expect(j.d5.minHeightNoStretch, 'cleared 态 D5 无空 min-height 撑高').toBe(true);
        expect(j.d5.bottomWhitespaceSmall, 'cleared 态 D5 底部无大块留白').toBe(true);
      }
    }

    const report = {
      suite: 'M3-T7 admin-account 401-cleared density supplement (#529)',
      selector: '.adm-account / .adm-account-cleared',
      viewport: '1440x900',
      method: 'SSR 挂载后独立真实 Auth.js signout 撤销 + CDP 标准网络限速构造竞争窗口；无 route.fulfill / 无 DB 写入 / 无 src 改动 / 无存储注入',
      realRequests: { signoutStatus, replayAccountStatus: replayStatus, shellMounted, urlAfter },
      result: captured ? 'captured' : 'not-captured',
      clearedTextVisible, clearedFrames: cleared.length,
      frames: judged,
      thresholds: ACCOUNT_DENSITY,
      note: captured
        ? '本次捕获到真实 cleared 态并已完成 D4/D5 几何判定。'
        : '本次未构造/未捕获：以上为实际时序与请求结果，供 Chief 定窄补证方案；不伪填通过，也不下「实现不可能 / 须改产品」结论（AdminShell mount 的 401 路径确实不 assign）。390 手机 D1–D6 仍 n/a；card 不适用、不新造页面。',
      pass: captured,
    };
    const reportPath = testInfo.outputPath('admin-account-cleared.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach('admin-account-cleared', { path: reportPath, contentType: 'application/json' });
  });
});
