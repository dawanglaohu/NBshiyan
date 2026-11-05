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

/** 侧栏 `.adm-account` 面板几何帧（只读采集，不含 cookie/token/账号邮箱/正文文本）。 */
type AccountFrame = {
  state: string;
  viewport: string;
  panel: {
    w: number; h: number;
    borderTop: string; borderRight: string; borderBottom: string; borderLeft: string;
    padTop: string; padRight: string; padBottom: string; padLeft: string;
    rowGap: string; columnGap: string; minHeight: string;
    display: string; flexDirection: string; visibility: string;
    cssReady: boolean;
  };
  /** 面板同坐标系（相对 panel 左上角）的可见内容盒：文字用 Range rect，控件/有底色块用盒子 rect。 */
  content: Array<{ kind: 'text' | 'box'; top: number; left: number; right: number; bottom: number; h: number }>;
  textLen: number;
};

/** 11 节 / density_probe.js 既有阈值，不自造更宽阈值。 */
const ACCOUNT_DENSITY = { padMax: 20, gapMax: 24, nearMax: 24, sparsePad: 32, sparseHeight: 80, sparseText: 120 };
const EPS = 1.5; // 仅浮点容差，不放宽任何验收阈值

/** 严格读数：非法/缺失/负值返回 null，绝不 `|| 0` 静默当通过。 */
function px(v: string | undefined): number | null {
  if (typeof v !== 'string') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 独立判定：D4 是 CSS 值（四边 padding / row+column gap），D5 是几何布局结果。
 * D5 用**可见文字 Range rect / 控件盒**，检查内容在 panel 内（四边有界、无负坐标）、
 * 首尾内容相对 border+padding 内边的局部留白、子块内部撑高居中、computed min-height、
 * 底部留白、子项间距、稀疏撑高块——不拿 D4 通过重复充当 D5 通过。
 */
function judgeAccountFrame(f: AccountFrame) {
  const p = f.panel;
  const pads = [px(p.padTop), px(p.padRight), px(p.padBottom), px(p.padLeft)];
  const borders = [px(p.borderTop), px(p.borderRight), px(p.borderBottom), px(p.borderLeft)];
  const rowGap = px(p.rowGap), colGap = px(p.columnGap), minHeightPx = px(p.minHeight);
  const w = p.w, h = p.h;
  const c = (f.content || []).filter((r) => r.h > 0 && r.right > r.left);
  const contentTop = c.length ? Math.min(...c.map((r) => r.top)) : null;
  const contentLeft = c.length ? Math.min(...c.map((r) => r.left)) : null;
  const contentRight = c.length ? Math.max(...c.map((r) => r.right)) : null;
  const contentBottom = c.length ? Math.max(...c.map((r) => r.bottom)) : null;
  const sorted = c.slice().sort((a, b) => a.top - b.top);
  let worstChildGap = 0;
  for (let i = 1; i < sorted.length; i++) worstChildGap = Math.max(worstChildGap, sorted[i].top - sorted[i - 1].bottom);
  // 相对 border+padding 内边的留白（同坐标系）；上下左右都要求内容落在面板内，负值失败。
  const innerLeft = (borders[3] ?? 0) + (pads[3] ?? 0);
  const innerTop = (borders[0] ?? 0) + (pads[0] ?? 0);
  const innerRight = w - (borders[1] ?? 0) - (pads[1] ?? 0);
  const innerBottom = h - (borders[2] ?? 0) - (pads[2] ?? 0);
  const topGap = contentTop !== null ? contentTop - innerTop : null;
  const leftGap = contentLeft !== null ? contentLeft - innerLeft : null;
  const bottomWhitespace = contentBottom !== null ? innerBottom - contentBottom : null;
  // 子块内部撑高居中：某个可见内容盒自身高度远大于文字行高、且文字/控件贴其上下边缘之外的空白过大。
  const stretchedInner = c.some((r) => r.h >= ACCOUNT_DENSITY.sparseHeight && r.h > 80);

  const numbersValid = [...pads, ...borders, rowGap, colGap, minHeightPx].every((n) => n !== null);
  const d4 = {
    numbersValid,
    paddingLe20: numbersValid && Math.max(...(pads as number[])) <= ACCOUNT_DENSITY.padMax,
    rowGapLe24: numbersValid && (rowGap as number) <= ACCOUNT_DENSITY.gapMax,
    colGapLe24: numbersValid && (colGap as number) <= ACCOUNT_DENSITY.gapMax,
  };
  const d5 = {
    numbersValid, // 非法/缺失数值不得静默当通过（与 D4 共用同一读数门）
    hasContent: c.length > 0,
    // 四边有界：内容在 border+padding 内侧，无负坐标 / 不越右、越下
    insideLeft: leftGap !== null && leftGap >= -EPS,
    insideTop: topGap !== null && topGap >= -EPS,
    insideRight: contentRight !== null && contentRight <= innerRight + EPS,
    insideBottom: bottomWhitespace !== null && bottomWhitespace >= -EPS,
    // 局部左上（不靠负坐标通过）
    contentTopNear: topGap !== null && topGap >= -EPS && topGap <= ACCOUNT_DENSITY.nearMax,
    contentLeftNear: leftGap !== null && leftGap >= -EPS && leftGap <= ACCOUNT_DENSITY.nearMax,
    // 无空 min-height 撑高
    minHeightNoStretch: minHeightPx !== null && (minHeightPx <= EPS || (contentBottom !== null && minHeightPx <= contentBottom + EPS)),
    // 子块内部不得撑高居中
    noStretchedInner: !stretchedInner,
    // 底部无大块留白
    bottomWhitespaceSmall: bottomWhitespace !== null && bottomWhitespace >= -EPS && bottomWhitespace <= ACCOUNT_DENSITY.nearMax,
    // 子项之间无大块间距
    childGapSmall: worstChildGap <= ACCOUNT_DENSITY.gapMax + EPS,
    // 探针 D5 稀疏撑高块语义
    notSparseBlock: numbersValid && !(
      Math.max(...(pads as number[])) >= ACCOUNT_DENSITY.sparsePad &&
      h >= ACCOUNT_DENSITY.sparseHeight && f.textLen < ACCOUNT_DENSITY.sparseText && c.length <= 4
    ),
  };
  return {
    d4: { ...d4, pass: Object.values(d4).every(Boolean) },
    d5: { ...d5, pass: Object.values(d5).every(Boolean) },
    metrics: {
      pads, borders, rowGap, colGap, minHeightPx, w, h,
      contentTop, contentLeft, contentRight, contentBottom, innerLeft, innerTop, innerRight, innerBottom,
      topGap, leftGap, bottomWhitespace, worstChildGap, stretchedInner, contentBoxes: c.length, textLen: f.textLen,
    },
  };
}

/**
 * 注入浏览器：只读 observer。样式就绪判据取**本来就应存在的壳样式特征**
 * （--pj-* token 已解析、面板 display:flex、有非零边框宽度、四边 padding 解析为有限数），
 * 这些不是验收阈值，不会筛掉真实失败帧（例如 padding 超标仍会被采、由 judge 判失败）。
 * 按 state+viewport 管理 seen；样式就绪前不锁 seen，用有界 rAF 继续只读重采；结束时 cancel。
 */
function installAccountObserver(): void {
  const frames: unknown[] = [];
  (window as unknown as { __admAccountFrames: unknown[]; __admObserverStop?: () => void }).__admAccountFrames = frames;
  const bounded = { n: 0, raf: 0 as number | null };
  const MAX_FRAMES = 900; // ~15s @60fps 的有界只读重采，不无限跑
  const rootStyle = () => window.getComputedStyle(document.documentElement);
  const cssReady = (ps: CSSStyleDeclaration): boolean => {
    const bw = parseFloat(ps.borderTopWidth);
    const pad = parseFloat(ps.paddingTop);
    const accent = rootStyle().getPropertyValue('--pj-accent').trim();
    const border = rootStyle().getPropertyValue('--pj-border-width').trim();
    // 壳样式特征：flex 布局 + 真实边框 + 已解析的 --pj-* token；与「padding≤20」等验收阈值无关。
    return ps.display === 'flex' && Number.isFinite(bw) && bw > 0 && Number.isFinite(pad) &&
      accent === '#b45700' && /^\d/.test(border);
  };
  const snap = (state: string): boolean => {
    const panel = document.querySelector('.adm-account') as HTMLElement | null;
    if (!panel) return false;
    const pr = panel.getBoundingClientRect();
    const ps = getComputedStyle(panel);
    if (ps.display === 'none' || ps.visibility === 'hidden' || pr.width < 1 || pr.height < 1) return false;
    if (!cssReady(ps)) return false; // 样式未生效：不锁 seen，等下一帧重采
    const content: Array<{ kind: 'text' | 'box'; top: number; left: number; right: number; bottom: number; h: number }> = [];
    const rel = (r: DOMRect) => ({ top: r.top - pr.top, left: r.left - pr.left, right: r.right - pr.left, bottom: r.bottom - pr.top, h: r.height });
    const walk = (node: Node) => {
      if (node.nodeType === 3 && (node.nodeValue || '').trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of Array.from(range.getClientRects())) {
          if (r.width > 0 && r.height > 0) content.push({ kind: 'text', ...rel(r as DOMRect) });
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as HTMLElement;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const replaceable = /^(IMG|SVG|CANVAS|VIDEO|INPUT|SELECT|TEXTAREA|BUTTON|PROGRESS|METER|IFRAME)$/.test(el.tagName);
      const surfaced = parseFloat(cs.borderTopWidth) > 0 || (cs.backgroundColor !== 'transparent' && cs.backgroundColor !== 'rgba(0, 0, 0, 0)');
      if (replaceable || surfaced) content.push({ kind: 'box', ...rel(r as DOMRect) });
      for (const child of Array.from(el.childNodes)) walk(child);
    };
    for (const child of Array.from(panel.childNodes)) walk(child);
    frames.push({
      state, viewport: `${window.innerWidth}x${window.innerHeight}`,
      panel: {
        w: Math.round(pr.width), h: Math.round(pr.height),
        borderTop: ps.borderTopWidth, borderRight: ps.borderRightWidth, borderBottom: ps.borderBottomWidth, borderLeft: ps.borderLeftWidth,
        padTop: ps.paddingTop, padRight: ps.paddingRight, padBottom: ps.paddingBottom, padLeft: ps.paddingLeft,
        rowGap: ps.rowGap, columnGap: ps.columnGap, minHeight: ps.minHeight,
        display: ps.display, flexDirection: ps.flexDirection, visibility: ps.visibility, cssReady: true,
      },
      content, textLen: (panel.textContent || '').trim().length,
    });
    return true;
  };
  const seen: Record<string, boolean> = {};
  const key = (s: string) => `${s}@${window.innerWidth}x${window.innerHeight}`;
  const scan = () => {
    const states: Array<[string, boolean]> = [
      ['loading', !!document.querySelector('.adm-account-loading')],
      ['data', !!document.querySelector('.adm-account-name')],
      ['cleared', !!document.querySelector('.adm-account-cleared')],
    ];
    let pending = false;
    for (const [s, present] of states) {
      if (present && !seen[key(s)] && snap(s)) seen[key(s)] = true;
      if (present && !seen[key(s)]) pending = true; // 样式未就绪：继续重采
    }
    if (pending && bounded.n++ < MAX_FRAMES) bounded.raf = requestAnimationFrame(scan);
  };
  const stop = () => { if (bounded.raf !== null) cancelAnimationFrame(bounded.raf); };
  (window as unknown as { __admObserverStop?: () => void }).__admObserverStop = stop;
  new MutationObserver(scan).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  document.addEventListener('DOMContentLoaded', scan);
  if (document.readyState !== 'loading') requestAnimationFrame(scan);
  // resize 后按新 viewport 的 seen key 重新只读采样（cleared 态跨两档桌面，不需要第二次登录/signout）。
  window.addEventListener('resize', () => requestAnimationFrame(scan));
  window.addEventListener('pagehide', stop);
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
   * 只读观测：addInitScript 里挂 MutationObserver，用真实壳样式特征（--pj-* token 已解析、
   * display:flex、非零边框宽度）确认 CSS 已生效后才记有效帧，样式就绪前不锁 seen、有界 rAF 重采。
   * 采可见文字 Range rect / 控件盒（只存几何，不存正文），不改 DOM/CSS/React state，不注入存储，
   * 不伪造会话或业务记录，不用 route.fulfill。401-cleared 态另见本文件末尾独立会话补证。
   * D4（CSS 值）与 D5（几何布局结果）独立判定，缺帧/非法数值明确失败。
   */
  test('壳内账号区 data/loading 态的 D4/D5 与跨断点 D1 间距（补证）', async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    await page.addInitScript(installAccountObserver);
    const all: AccountFrame[] = [];
    for (const view of [{ width: 1920, height: 1080, label: '1920x1080' }, { width: 1440, height: 900, label: '1440x900' }]) {
      await page.setViewportSize(view);
      await page.goto(`${BASE}/admin/inquiries`, { waitUntil: 'load' });
      await expect(page.getByTestId('admin-account-role')).toBeVisible({ timeout: 20_000 });
      await page.evaluate(() => (window as unknown as { __admObserverStop?: () => void }).__admObserverStop?.());
      all.push(...(await readAccountFrames(page)).filter((f) => f.viewport === view.label));
    }

    const checked: Array<Record<string, unknown>> = [];
    const asserts: Array<() => void> = [];
    for (const label of ['1920x1080', '1440x900']) {
      const vf = all.filter((f) => f.viewport === label);
      asserts.push(() => expect(vf.some((f) => f.state === 'loading'), `${label} 须采集到 CSS 已生效的真实 loading 有效帧`).toBe(true));
      asserts.push(() => expect(vf.some((f) => f.state === 'data'), `${label} 须采集到 CSS 已生效的真实 data 有效帧`).toBe(true));
      for (const f of vf) {
        const j = judgeAccountFrame(f);
        const tag = `${label} ${f.state}`;
        for (const [k, v] of Object.entries(j.d4)) if (typeof v === 'boolean') asserts.push(() => expect(v, `${tag} D4 ${k}`).toBe(true));
        for (const [k, v] of Object.entries(j.d5)) if (typeof v === 'boolean') asserts.push(() => expect(v, `${tag} D5 ${k}`).toBe(true));
        checked.push({ viewport: label, state: f.state, panel: f.panel, content: f.content, metrics: j.metrics, d4: j.d4, d5: j.d5 });
      }
    }
    // D1：两档断点完整四边 padding 与 row/column gap 都不随宽度增大。
    const d1920 = all.find((f) => f.viewport === '1920x1080' && f.state === 'data');
    const d1440 = all.find((f) => f.viewport === '1440x900' && f.state === 'data');
    const d1Keys = ['padTop', 'padRight', 'padBottom', 'padLeft', 'rowGap', 'columnGap'] as const;
    const d1 = {
      present: !!d1920 && !!d1440,
      equal: d1920 && d1440 ? d1Keys.map((k) => ({ key: k, a: d1920.panel[k], b: d1440.panel[k], equal: d1920.panel[k] === d1440.panel[k] })) : [],
    };
    asserts.push(() => expect(d1.present, '两档都须有 data 帧供 D1 对比').toBe(true));
    asserts.push(() => expect(d1.equal.every((e) => e.equal), 'D1 断点变宽不增大四边 padding / row+column gap').toBe(true));

    // 先落盘含真实判定的报告，再执行失败断言，保证几何失败也留下 JSON 供同次 artifact 定位。
    const report = {
      suite: 'M3-T7 admin-account density supplement (#529)',
      selector: '.adm-account', rail: 'nav#adm-nav（既有 14 次 main 探针排除侧栏，本补证直接量面板）',
      viewports: ['1920x1080', '1440x900'], statesMeasured: ['data', 'loading'],
      thresholds: ACCOUNT_DENSITY, eps: EPS,
      sampling: 'CSS 已生效（--pj-* / display:flex / 非零边框）+ panel 可见非零才记有效帧；按 state+viewport 管 seen；缺帧即失败',
      d4Definition: 'CSS 值：四边 padding≤20 / row+column-gap≤24；非法/缺失数值失败',
      d5Definition: '可见文字 Range / 控件盒几何：四边有界、局部左上、无撑高子块、computed min-height、底部留白、子项间距、稀疏撑高块；与 D4 独立',
      frames: checked, d1,
      cleared401: { scope: '本用例只采 data/loading；401-cleared 构造结果见独立会话补证报告 admin-account-cleared.json。' },
      note: '390x844 phone probe 未跑，仅复用既有 44px 触控与无横向溢出证据，不伪填手机 D1–D6；card 不是本卡新增页面类型，不新造 card 页面。',
      pass: checked.length > 0 && checked.every((c) => (c.d4 as { pass: boolean }).pass && (c.d5 as { pass: boolean }).pass) && d1.present && d1.equal.every((e) => e.equal),
    };
    const reportPath = testInfo.outputPath('admin-account-density.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach('admin-account-density', { path: reportPath, contentType: 'application/json' });
    for (const a of asserts) a();
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
 * 实证方式（不用 CDP 延迟推定时序）：**导航前**注册浏览器自身 `GET /api/admin/account` 的
 * request / response / requestfailed 监听，记录路径、方法、status、requestId 与同源相对时间
 * （时钟源 = performance.now()，只描述浏览器可观测事件，不写服务端到达时刻）。
 * 预建 revoker request context 与 CSRF；SSR 导航响应已获得、壳 DOM 出现后尽早触发真实
 * Auth.js signout（机会策略，非「请求被挂起」的证明），并用复制旧 state 的真实请求确认
 * 旧 cookie GET account=401。cleared 判定必须同时满足：浏览器自身客户端 GET account 实际 401
 * + 同页 `.adm-account-cleared` 可见 + 两档桌面各取得 CSS 已生效的有效几何帧。
 *
 * 不 route.fulfill、不拦改本应用响应、不写 DB 绕过产品、不改 src/DOM/CSS/React、不注入存储。
 * 若竞争窗口本次未构造成功，报告标 not-captured + 具体事件时序/请求结果，不伪填通过，
 * 也不下「实现不可能 / 须改产品」的定论（旧头 run 42046524928 已真实 captured 过一次）。
 */
test.describe('admin-account 401-cleared 态布局补证（独立会话）', () => {
  useSharedAdmin({ emailPrefix: 'e2e-shell-cleared', name: 'E2E shell cleared', password: PASSWORD, probe: ACCOUNT });

  test('SSR 挂载后另一真实请求撤销会话，浏览器自身 GET account 401 触发 .adm-account-cleared（两档桌面）', async ({ page, playwright }, testInfo) => {
    test.setTimeout(150_000);
    const accountEvents: Array<Record<string, unknown>> = [];
    const t0 = Date.now();
    const at = () => Date.now() - t0; // 同源相对时间，仅作事件排序，不冒充服务端时刻
    const watchRequest = (r: import('@playwright/test').Request) => {
      try {
        const u = new URL(r.url());
        if (r.method() === 'GET' && u.pathname === ACCOUNT) {
          accountEvents.push({ event: 'request', atMs: at(), method: r.method(), path: u.pathname, requestId: (r as unknown as { _guid?: string })._guid ?? undefined });
        }
      } catch { /* 忽略非 URL */ }
    };
    const watchResponse = (r: import('@playwright/test').Response) => {
      try {
        const u = new URL(r.url());
        if (r.request().method() === 'GET' && u.pathname === ACCOUNT) {
          accountEvents.push({ event: 'response', atMs: at(), path: u.pathname, status: r.status(), requestId: (r.request() as unknown as { _guid?: string })._guid ?? undefined });
        }
      } catch { /* 忽略非 URL */ }
    };
    const watchFailed = (r: import('@playwright/test').Request) => {
      try {
        const u = new URL(r.url());
        if (r.method() === 'GET' && u.pathname === ACCOUNT) {
          accountEvents.push({ event: 'requestfailed', atMs: at(), path: u.pathname, requestId: (r as unknown as { _guid?: string })._guid ?? undefined });
        }
      } catch { /* 忽略非 URL */ }
    };
    page.on('request', watchRequest);
    page.on('response', watchResponse);
    page.on('requestfailed', watchFailed);

    // 预建 revoker 与 CSRF：导航前就绪，避免错过 SSR 已过 → 客户端 GET 之前的窗口。
    const sessionState = await page.context().storageState();
    const revoker = await playwright.request.newContext({ baseURL: BASE, storageState: sessionState });
    const csrf = (await (await revoker.get('/api/auth/csrf')).json()).csrfToken as string;
    const replayCtx = await playwright.request.newContext({ baseURL: BASE, storageState: sessionState });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(installAccountObserver);
    let navigationStatus = 0;
    let shellVisible = false;
    let signoutStatus = 0;
    let replayStatus = 0;
    let urlAfter = '';
    let clearedTextVisible = false;
    let frames: AccountFrame[] = [];
    let err: unknown = null;
    try {
      const nav = await page.goto(`${BASE}/admin/inquiries`, { waitUntil: 'domcontentloaded' });
      navigationStatus = nav ? nav.status() : 0;
      // SSR 响应已获得、壳 DOM 出现即尽早触发真实 signout（机会策略，不宣称请求被挂起）。
      await expect(page.getByTestId('admin-account')).toBeVisible({ timeout: 20_000 });
      shellVisible = true;
      const signout = await revoker.post('/api/auth/signout', { maxRedirects: 0, headers: { Origin: BASE }, form: { csrfToken: csrf, callbackUrl: `${BASE}/admin-login` } });
      signoutStatus = signout.status();
      // 复制旧 state 的真实受保护请求：确认服务端会话确已撤销。
      replayStatus = (await replayCtx.get(ACCOUNT)).status();

      try {
        await expect(page.getByRole('status').filter({ hasText: '会话已失效' })).toBeVisible({ timeout: 10_000 });
        clearedTextVisible = true;
      } catch { /* 未捕获：如实记 not-captured */ }
      // 同页 resize 到 1920 再采 cleared 帧（observer 按 state+viewport 管 seen，无需第二次登录/signout）。
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.waitForTimeout(300);
      frames = await readAccountFrames(page);
      urlAfter = page.url();
      await page.evaluate(() => (window as unknown as { __admObserverStop?: () => void }).__admObserverStop?.());
    } catch (e) { err = e; }
    page.off('request', watchRequest);
    page.off('response', watchResponse);
    page.off('requestfailed', watchFailed);
    await revoker.dispose();
    await replayCtx.dispose();

    const cleared = frames.filter((f) => f.state === 'cleared');
    const byViewport = ['1440x900', '1920x1080'].map((label) => ({ label, frames: cleared.filter((f) => f.viewport === label) }));
    const judged = byViewport.map((v) => ({
      viewport: v.label,
      frames: v.frames.map((f) => ({ panel: f.panel, content: f.content, d4: judgeAccountFrame(f).d4, d5: judgeAccountFrame(f).d5, metrics: judgeAccountFrame(f).metrics })),
    }));
    const clientAccount401 = accountEvents.some((e) => e.event === 'response' && e.path === ACCOUNT && e.status === 401);
    const signoutOk = signoutStatus === 200 || signoutStatus === 302;
    const replayOk = replayStatus === 401;
    const geomOk = byViewport.every((v) => v.frames.length > 0 && v.frames.every((f) => judgeAccountFrame(f).d4.pass && judgeAccountFrame(f).d5.pass));
    const captured = clearedTextVisible && clientAccount401 && signoutOk && replayOk && geomOk && !err;

    // 先落盘含真实判定的报告（try/finally 语义），再执行失败断言；失败也留 JSON。
    const report = {
      suite: 'M3-T7 admin-account 401-cleared density supplement (#529)',
      selector: '.adm-account / .adm-account-cleared',
      viewports: ['1440x900', '1920x1080'],
      clock: 'performance.now() 同源相对时间（Date.now()-t0）；只记浏览器可观测事件，不记服务端到达时刻',
      method: '导航前注册浏览器自身 GET account request/response/requestfailed；预建 revoker+CSRF；SSR 响应已获、壳出现后尽早发真实 Auth.js signout；复制旧 state 的真实请求确认 401；同页 resize 采两档 cleared 几何。无 CDP 延迟挂起假设、无 route.fulfill、无响应改写、无 DB 写入、无 src/DOM/CSS/React 改动、无存储注入。',
      realRequests: { navigationStatus, shellVisible, signoutStatus, replayAccountStatus: replayStatus, urlAfter },
      browserAccountEvents: accountEvents,
      clientAccount401, signoutOk, replayOk,
      result: captured ? 'captured' : 'not-captured',
      clearedTextVisible, clearedFrameCount: cleared.length,
      byViewport: judged.map((j) => ({ viewport: j.viewport, frameCount: j.frames.length })),
      frames: judged,
      thresholds: ACCOUNT_DENSITY, eps: EPS,
      error: err ? String(err) : null,
      note: captured
        ? '浏览器自身 GET account 实测 401 + 真实 signout/旧 cookie 401 + 两档桌面 cleared 几何 D4/D5 均通过。'
        : '本次未闭合：以上为真实事件时序与请求结果。not-captured / 客户端 GET 非 401 / 缺任一视口 cleared 几何 / 几何不通过 都记为未取得，不伪填 pass、不下「实现不可能 / 须改产品」结论。390 phone probe 未跑，仅复用既有 44px 触控与无横向溢出证据，不伪填手机 D1–D6；card 不适用、不新造页面。',
      pass: captured,
    };
    const reportPath = testInfo.outputPath('admin-account-cleared.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach('admin-account-cleared', { path: reportPath, contentType: 'application/json' });

    // 失败断言（报告已落盘）：缺帧 / not-captured 明确为未闭合。
    expect(err, `补证执行异常：${err ? String(err) : ''}`).toBeNull();
    expect(signoutOk, `真实 Auth.js signout 须成功（实际 ${signoutStatus}）`).toBe(true);
    expect(replayOk, `复制旧 state 的真实 GET account 须 401（实际 ${replayStatus}）`).toBe(true);
    expect(clientAccount401, '浏览器自身 GET account 须实测 401（与 cleared 关联）').toBe(true);
    expect(clearedTextVisible, '.adm-account-cleared 须真实可见').toBe(true);
    for (const v of byViewport) expect(v.frames.length, `${v.label} 须取得 CSS 已生效的 cleared 有效帧`).toBeGreaterThan(0);
    for (const j of judged) for (const f of j.frames) {
      expect(f.d4.pass, `${j.viewport} cleared D4 全项`).toBe(true);
      expect(f.d5.pass, `${j.viewport} cleared D5 全项`).toBe(true);
    }
  });
});
