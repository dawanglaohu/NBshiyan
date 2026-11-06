import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { authenticator } from 'otplib';
import { execFileSync } from 'node:child_process';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';
import { E2E_TOTP } from './shared-admin';
import { STATUS_LABEL } from '../src/lib/admin/types';

/**
 * M3-T21 旧询盘页视觉迁移：真实登录 → 真实合成询盘 → 原 GET 过滤/分页/详情/history
 * → 状态/分配/notes 持久 → 三尺寸 computed style / density_probe D1–D6 / overflow
 * → 真实触控 44px 矩形 / 六态 / JSON+PNG+video 同次来源证据。
 *
 * 登录：每角色各自独立管理员（create-admin.mjs + E2E_TOTP），整文件 ADMIN 只登录一次；
 * SALES 另建独立账号核他人 scope。不复用全局 E2E_ADMIN、不靠 test.skip 换绿。
 * 合成数据：真实 POST /api/inquiries，读响应 ref 在列表定位，不直插 DB、不改响应、不造 DOM。
 * 证据：test.use({ video:'on' }) 文件顶层一次；JSON/PNG 写到各用例 testInfo.outputPath
 * （同名重跑不覆盖项目其它证据），density probe 写 JSON 前按白名单投影，PNG 只截控件区不进数据行。
 */
const PASSWORD = 'e2e-inq-visual-Passw0rd!';
const ACCOUNT = '/api/admin/account';
const STATUS_KEYS = Object.keys(STATUS_LABEL);

/** 自建 context 的外部请求拦截：与 e2e/fixtures.ts 的 auto external fixture 同口径。
 *  本卡 page 来自 contextFor 自建 context，不经过默认 page 的 fixture route；CI 无外网时
 *  必须把 Turnstile 脚本替换成本地桩，否则 window.turnstile 不存在、awaitingCheck 挡住提交，
 *  真实建单链路第一步就会超时。只作用于本卡自建 context，不改共享 fixtures.ts。 */
const TURNSTILE_STUB = `(() => { let n = 0; const w = {};
  const issue = (id) => { const x = w[id]; if (!x) return; x.input.value = 'XXXX.DUMMY.TOKEN.' + (++n); x.opts.callback && x.opts.callback(x.input.value); };
  window.turnstile = {
    render(el, opts) { const id = 'w' + (++n); const i = document.createElement('input'); i.type = 'hidden'; i.name = 'cf-turnstile-response'; el.appendChild(i); w[id] = { el, opts, input: i }; issue(id); return id; },
    reset(id) { if (id) issue(id); else Object.keys(w).forEach(issue); },
    remove(id) { const x = w[id]; if (x) { x.input.remove(); delete w[id]; } }
  }; })();`;
const EXTERNAL = /^https?:\/\/(?!localhost|127\.0\.0\.1)/;

test.use({ video: 'on' });

type SessionState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** 独立建号 + 真实 Auth.js credentials 登录一次，返回 storageState，供各组 page/context 复用。 */
async function loginRole(browser: Browser, emailPrefix: string, role: string): Promise<{ state: SessionState; email: string }> {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  execFileSync('node', ['scripts/create-admin.mjs'], {
    stdio: 'pipe',
    env: { ...process.env, ADMIN_SEED_EMAIL: email, ADMIN_SEED_PASSWORD: PASSWORD, ADMIN_SEED_NAME: emailPrefix, ADMIN_SEED_ROLE: role, ADMIN_SEED_TOTP_SECRET: E2E_TOTP },
  });
  const ctx = await browser.newContext({ baseURL: BASE });
  const csrf = (await (await ctx.request.get('/api/auth/csrf')).json()).csrfToken as string;
  const ok = await ctx.request.post('/api/auth/callback/credentials', {
    headers: { Origin: BASE }, maxRedirects: 0,
    form: { csrfToken: csrf, email, password: PASSWORD, totp: authenticator.generate(E2E_TOTP) },
  });
  expect(ok.headers()['location'] ?? '').not.toContain('error');
  expect((await ctx.request.get(ACCOUNT)).status()).toBe(200);
  const state = await ctx.storageState();
  await ctx.close();
  return { state, email };
}

/** 用某角色的 storageState 建本用例自己的 context（继承 baseURL 与必要 video/locale）。
 *  自建 context 显式装外部拦截 + Turnstile 桩，补齐默认 page fixture 不覆盖本卡 context 的缺口。 */
async function contextFor(browser: Browser, state: SessionState, testInfo: TestInfo): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: BASE, storageState: state, locale: 'en-US', recordVideo: { dir: testInfo.outputPath('video'), size: { width: 1280, height: 720 } } });
  await context.route(EXTERNAL, (route) => {
    if (route.request().url().startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js')) {
      return route.fulfill({ contentType: 'text/javascript', body: TURNSTILE_STUB });
    }
    return route.abort();
  });
  return context;
}

/** 通过前台三步表单真实 POST /api/inquiries，读取真实响应里的 ref。 */
async function createSyntheticInquiry(page: Page, tag: string): Promise<string> {
  await page.goto(`${BASE}/en/contact`);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel(/^Name/).fill(`QA ${tag}`);
  await page.getByLabel(/Business email|Email/).fill(`qa-${tag}@acme-test.com`);
  await page.getByLabel(/Company/).fill(`Acme ${tag}`);
  await page.getByLabel(/Country/).selectOption('DE');
  await page.getByRole('checkbox', { name: /agree|consent|privacy/i }).check();
  const wait = page.waitForResponse((r) => r.url().endsWith('/api/inquiries') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send request' }).click();
  const resp = await wait;
  expect(resp.status()).toBeLessThan(300);
  const body = await resp.json() as { ref?: string };
  expect(body.ref, 'POST 响应必须给出真实编号').toMatch(/^PJ-/);
  await expect(page.getByRole('heading', { name: /Thank you/ })).toBeVisible();
  return body.ref!;
}

/** 把白名单结果写到本测试独立 outputPath 并 attach（不含 cookie/token/请求正文/PII/异常字符串）。
 *  目录按用例隔离，同名重跑不覆盖项目其它证据；CI 既有 admin-legacy-inquiries*.json glob 不变。 */
async function writeJson(testInfo: TestInfo, name: string, payload: unknown): Promise<string> {
  const path = testInfo.outputPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await testInfo.attach(name.replace(/\.json$/, ''), { path, contentType: 'application/json' });
  return path;
}

/** density probe 安全投影：只保留 verdict 与数值/计数 metric；
 *  丢弃 url（可含查询串）、sparseBlocks 文案片段、选择器 path、main/rail path 等可能含敏感内容的字段。 */
function safeDensity(probe: Record<string, unknown>): Record<string, unknown> {
  const v = (probe.verdict ?? {}) as Record<string, unknown>;
  const verdict: Record<string, unknown> = {};
  for (const k of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'overflow', 'pass']) verdict[k] = v[k] ?? null;
  const out: Record<string, unknown> = { verdict };
  for (const k of ['avail', 'interiorBand', 'contentFound', 'fill', 'leftGap', 'rightGap', 'gapOffenders', 'padOffenders', 'emptyTracks']) {
    const val = probe[k];
    if (val === undefined) continue;
    if (Array.isArray(val)) out[k] = val.length;
    else if (val && typeof val === 'object') out[k] = Object.fromEntries(Object.entries(val as Record<string, unknown>).filter(([, x]) => typeof x === 'number' || typeof x === 'boolean'));
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = val;
  }
  return out;
}

/** 密度探针源码（真实文件，不改源/阈值）。 */
const PROBE_SRC = readFileSync('docs/PackJoyU-开发文档/_run/density_probe.js', 'utf8');

/** 用 addScriptTag 注入探针源码（源码里是全局 var densityProbe），再调用真实 probe，不改源/阈值。 */
async function density(page: Page, opts: { type: 'work' | 'form'; density: number; main?: string; gutter?: number; gap?: number; pad?: number }) {
  await page.addScriptTag({ content: PROBE_SRC });
  return page.evaluate((o) => {
    const probe = (window as unknown as { densityProbe?: (x: typeof o) => Record<string, unknown> }).densityProbe;
    if (!probe) throw new Error('densityProbe 未注入');
    return probe(o);
  }, opts);
}

/** 负控：故意把 D2 或 D5 改成 fail，确认验收函数明确失败，不是只判字段存在。 */
function assertDesktopDensity(probe: Record<string, unknown>, label: string) {
  const v = probe.verdict as Record<string, string> | undefined;
  expect(v, `${label} 必须有 verdict`).toBeTruthy();
  for (const k of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'overflow']) {
    expect(v![k], `${label} ${k}`).toBe('pass');
  }
  expect(v!.pass, `${label} verdict.pass`).toBe(true);
  // 原始 metric 必须保留在返回对象顶层（不只是布尔）。
  for (const k of ['avail', 'contentFound', 'fill', 'leftGap', 'gapOffenders', 'padOffenders', 'emptyTracks']) {
    expect(probe[k] !== undefined, `${label} metric.${k}`).toBe(true);
  }
}

let adminState: SessionState;
test.beforeAll(async ({ browser }) => { adminState = (await loginRole(browser, 'e2e-inq-visual', 'ADMIN')).state; });

test.describe('M3-T21 询盘/邮件视觉迁移（ADMIN 整组一次登录）', () => {
  let ctx: BrowserContext;
  let page: Page;
  // 每用例独立安全报告：在 beforeEach 最开头就按用例名初始化（而不是主体末尾），
  // 主体只往 activeReport.payload 累积白名单字段；前段任何一步失败，afterEach 仍写出
  // 已取得的安全诊断（complete=false）。不采证的负控用例不初始化，避免空报告。
  const REPORT_BY_TEST: Record<string, string> = {
    '真实合成询盘 → 列表 GET 过滤/分页/日期/状态/负责人 → 详情 PATCH/分配/notes 持久': 'admin-legacy-inquiries.json',
    '三尺寸真实页：wrapper 几何 / density_probe D1–D6 / computed style / overflow / 键盘 44px 触控': 'admin-legacy-inquiries-visual.json',
    '详情适用 form 区 density_probe 与三尺寸动作': 'admin-legacy-inquiries-form.json',
    '六态采集：loading / empty / error / success / disabled / focus 的真实控件判定': 'admin-legacy-inquiries-states.json',
    'SALES 真实身份：他人询盘详情 GET 404、改派 PATCH 403（不降为匿名）': 'admin-legacy-inquiries-sales.json',
  };
  let activeReport: { testInfo: TestInfo; name: string; payload: Record<string, unknown> } | null = null;
  const report = () => activeReport!.payload;
  const stage = (s: string) => { if (activeReport) activeReport.payload.stage = s; };
  const finishReport = () => { if (activeReport) activeReport.payload.complete = true; };
  test.beforeEach(async ({ browser }, testInfo) => {
    const name = REPORT_BY_TEST[testInfo.title];
    activeReport = name ? { testInfo, name, payload: { runSource: 'admin-legacy-inquiries-visual.spec.ts', complete: false, stage: 'setup' } } : null;
    ctx = await contextFor(browser, adminState, testInfo);
    page = await ctx.newPage();
    stage('context-ready');
  });
  test.afterEach(async () => {
    const pending = activeReport;
    // 报告写出与 context 清理各自兜底：任一清理失败都不覆盖测试主体已抛出的原错误。
    try { if (pending) await writeJson(pending.testInfo, pending.name, pending.payload); } catch { /* 不覆盖原错误 */ }
    try { if (ctx) await ctx.close(); } catch { /* 不覆盖原错误 */ }
    activeReport = null;
  });

  test('真实合成询盘 → 列表 GET 过滤/分页/日期/状态/负责人 → 详情 PATCH/分配/notes 持久', async (_fixtures, testInfo) => {
    test.setTimeout(180_000);
    const tag = `m3t21-${Date.now()}`;
    const r = report();
    r.refTag = tag;
    stage('create-synthetic');
    const ref = await createSyntheticInquiry(page, tag);
    r.refPattern = /^PJ-/.test(ref);
    stage('list-filters');
    const gets: string[] = [];
    const mutations: Array<{ method: string; path: string; body: string }> = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (r.method() === 'GET' && u.pathname === '/api/admin/inquiries') gets.push(r.url());
      if (r.method() === 'GET' && u.pathname === '/api/admin/users') gets.push(r.url());
      if (r.method() === 'GET' && u.pathname.startsWith('/api/admin/inquiries/')) gets.push(r.url());
      if (['PATCH', 'POST', 'PUT'].includes(r.method()) && u.pathname.startsWith('/api/admin/inquiries/')) {
        mutations.push({ method: r.method(), path: u.pathname, body: r.postData() ?? '' });
      }
    });
    await page.goto(`${BASE}/admin/inquiries`);
    // display:contents wrapper 用真实子节点判定 ready，不对零 bbox 的 wrapper 用 toBeVisible。
    await expect(page.locator('.inq-list > h1')).toBeVisible();
    await expect(page.locator('.inq-list > .adm-card')).toBeVisible();
    await expect.poll(() => gets.some((u) => u.includes('/api/admin/inquiries'))).toBe(true);
    await expect.poll(() => gets.some((u) => u.includes('/api/admin/users'))).toBe(true);

    // 搜索：q 参数；日期 from/to；状态 tab；负责人；分页 page —— 都触发既有 GET。
    await page.getByLabel('搜索').fill(ref);
    await page.getByRole('button', { name: '搜索' }).click();
    await expect.poll(() => gets.some((u) => new URL(u).searchParams.get('q') === ref)).toBe(true);
    // 在列表里定位该真实编号（不是任意首行）。
    const row = page.locator('.inq-list tbody tr.row').filter({ has: page.locator(`a:has-text("${ref}")`) });
    await expect(row).toHaveCount(1);
    await row.locator('a').first().click();

    // 详情 GET + history 保持原 scope。
    await expect(page.locator('.inq-detail > .adm-crumb')).toBeVisible();
    await expect.poll(() => gets.some((u) => /\/history/.test(new URL(u).pathname))).toBe(true);
    await expect(page.getByTestId('status-badge')).toBeVisible();
    await expect(page.getByTestId('trust-score')).toHaveAttribute('aria-label', /可信度 \d+/);

    // 状态 PATCH：选 FOLLOWING，核真实 request body + 持久（刷新后 status-badge 文本）。
    const statusSelect = page.locator('.inq-detail select[aria-label="状态"]');
    await expect(statusSelect).toBeEnabled();
    await statusSelect.selectOption('FOLLOWING');
    await expect.poll(() => mutations.some((m) => m.method === 'PATCH' && m.body.includes('FOLLOWING'))).toBe(true);
    await expect.poll(async () => (await page.getByTestId('status-badge').textContent())?.trim()).toBe(STATUS_LABEL.FOLLOWING);

    // 负责人分配：选第一个真实用户，核 PATCH body 含 assigneeId。
    const assignSelect = page.locator('.inq-detail select[aria-label="负责人"]');
    const optionValues = await assignSelect.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    const target = optionValues.find((v) => v && v !== '');
    if (target) {
      await assignSelect.selectOption(target);
      await expect.poll(() => mutations.some((m) => m.method === 'PATCH' && m.body.includes('assigneeId'))).toBe(true);
    }
    // 内部备注 POST notes，核真实 body。
    const noteBox = page.locator('.inq-detail textarea[aria-label="内部备注"]');
    await noteBox.fill(`M3-T21 note ${tag}`);
    await page.getByRole('button', { name: '添加备注' }).click();
    await expect.poll(() => mutations.some((m) => m.method === 'POST' && m.path.endsWith('/notes') && m.body.includes(tag))).toBe(true);
    await expect(page.locator('.inq-detail').getByText(`M3-T21 note ${tag}`)).toBeVisible();

    // 刷新后持久一致。
    await page.reload();
    await expect(page.getByTestId('status-badge')).toHaveText(STATUS_LABEL.FOLLOWING);
    await expect(page.locator('.inq-detail').getByText(`M3-T21 note ${tag}`)).toBeVisible();

    // 报告自 beforeEach 起已初始化；这里把最终判定的白名单字段并入，失败时前面各阶段字段仍在。
    r.statusBadgeText = STATUS_LABEL.FOLLOWING;
    r.statusLegal = STATUS_KEYS.includes('FOLLOWING');
    r.trustScoreAria = await page.getByTestId('trust-score').getAttribute('aria-label');
    r.statusPatchObserved = mutations.some((m) => m.method === 'PATCH' && m.body.includes('FOLLOWING'));
    r.assignPatchObserved = mutations.some((m) => m.method === 'PATCH' && m.body.includes('assigneeId'));
    r.notesPostObserved = mutations.some((m) => m.method === 'POST' && m.path.endsWith('/notes'));
    r.persistedAfterReload = true;
    stage('screenshot');
    // 真实截图限定 .inq-list .adm-filters 控件区：搜索框 / 日期 / 两个折叠 select / 按钮 / 开关，
    // 不含表格数据行、用户姓名、邮箱正文；select 折叠时只显示静态「全部」文案。
    // 断言通过后才截；失败由 afterEach 留诊断、不写假路径，不改 DOM 内容来遮。
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/admin/inquiries`);
    const filters = page.locator('.inq-list .adm-filters');
    await expect(filters).toBeVisible();
    const pngPath = testInfo.outputPath(`inquiry-visual-${Date.now()}.png`);
    await filters.screenshot({ path: pngPath });
    expect(readFileSync(pngPath).length).toBeGreaterThan(0);
    r.screenshotTarget = '.inq-list .adm-filters';
    r.screenshotContainsTableRows = false;
    r.pngBytes = readFileSync(pngPath).length;
    finishReport();
  });

  test('三尺寸真实页：wrapper 几何 / density_probe D1–D6 / computed style / overflow / 键盘 44px 触控', async () => {
    test.setTimeout(180_000);
    const out = report();
    out.viewports = [];
    for (const view of [{ width: 1920, height: 1080, label: '1920x1080' }, { width: 1440, height: 900, label: '1440x900' }, { width: 390, height: 844, label: '390x844' }]) {
      stage(`viewport:${view.label}`);
      await page.setViewportSize(view);
      await page.goto(`${BASE}/admin/inquiries`);
      await expect(page.locator('.inq-list > .adm-card')).toBeVisible();
      const m = await page.evaluate(() => {
        const cs = (s: string) => { const el = document.querySelector(s); return el ? getComputedStyle(el) : null; };
        const wrapper = document.querySelector('.inq-list');
        const wcs = wrapper ? getComputedStyle(wrapper) : null;
        const wr = wrapper ? wrapper.getBoundingClientRect() : null;
        const main = document.querySelector('.adm-main');
        const mr = main ? main.getBoundingClientRect() : null;
        const off = (s: string) => { const el = document.querySelector(s); if (!el || !mr) return null; const r = el.getBoundingClientRect(); return { dx: Math.round((r.x - mr.x) * 100) / 100, dy: Math.round((r.y - mr.y) * 100) / 100, w: Math.round(r.width), h: Math.round(r.height) }; };
        const card = cs('.inq-list > .adm-card');
        const input = cs('.inq-list .adm-filters input');
        return {
          wrapperDisplay: wcs?.display ?? null,
          wrapperBox: wr ? { w: Math.round(wr.width * 100) / 100, h: Math.round(wr.height * 100) / 100 } : null,
          h1: off('.inq-list > h1'), tabs: off('.inq-list > .adm-tabs'), card: off('.inq-list > .adm-card'),
          cardBorder: card?.borderTopWidth ?? null, cardRadius: card?.borderTopLeftRadius ?? null, cardShadow: card?.boxShadow ?? null,
          cardSides: { top: card?.borderTopColor, right: card?.borderRightColor, bottom: card?.borderBottomColor, left: card?.borderLeftColor },
          cornerRadius: { tl: card?.borderTopLeftRadius, tr: card?.borderTopRightRadius, br: card?.borderBottomRightRadius, bl: card?.borderBottomLeftRadius },
          cardBgImage: card?.backgroundImage ?? null,
          inputBorder: input?.borderTopWidth ?? null, inputMinHeight: input?.minHeight ?? null,
          accent: getComputedStyle(document.documentElement).getPropertyValue('--pj-accent').trim(),
          noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        };
      });
      expect(m.wrapperDisplay, `${view.label} wrapper display`).toBe('contents');
      expect(m.wrapperBox!.w, `${view.label} wrapper 无宽度`).toBeLessThanOrEqual(1);
      expect(m.wrapperBox!.h, `${view.label} wrapper 无高度`).toBeLessThanOrEqual(1);
      expect(m.h1!.w, `${view.label} h1 几何`).toBeGreaterThan(0);
      expect(m.card!.w, `${view.label} card 几何`).toBeGreaterThan(0);
      expect(m.cardBorder).toBe('2px');
      expect(m.cardRadius).toBe('0px');
      expect(m.cardShadow).toBe('none');
      for (const side of Object.values(m.cardSides)) expect(side).toBe('rgb(0, 0, 0)');
      for (const r of Object.values(m.cornerRadius)) expect(r).toBe('0px');
      expect(m.cardBgImage).toBe('none');
      expect(m.inputBorder).toBe('2px');
      expect(parseFloat(m.inputMinHeight ?? '0')).toBeGreaterThanOrEqual(44);
      expect(m.accent).toBe('#b45700');
      expect(m.noHorizontalOverflow).toBe(true);

      // 真实 density_probe：桌面两尺寸逐项 pass，手机只按适用项/overflow。
      const work = await density(page, { type: 'work', density: 7, main: '.adm-main', gutter: 16, gap: 16, pad: 16 });
      if (view.width >= 1024) assertDesktopDensity(work, `${view.label} work`);
      else {
        const v = work.verdict as Record<string, string>;
        expect(v.overflow).toBe('pass');
        expect(['pass', 'n/a']).toContain(v.D3);
      }
      // 真实键盘：Tab 到命名本卡控件（搜索框），核 focus-visible 与真实 44px 矩形。
      await page.getByLabel('搜索').focus();
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return { tag: el.tagName, name: el.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height), outline: s.outlineStyle, minHeight: s.minHeight };
      });
      expect(focus, `${view.label} 焦点必须落到真实控件`).not.toBeNull();
      expect(focus!.h, `${view.label} 焦点控件真实高度`).toBeGreaterThanOrEqual(44);
      expect(parseFloat(focus!.minHeight)).toBeGreaterThanOrEqual(44);
      expect(focus!.outline).not.toBe('none');
      (out.viewports as unknown[]).push({ label: view.label, wrapper: m.wrapperBox, card: m.card, densityWork: safeDensity(work), overflow: m.noHorizontalOverflow });
    }
    finishReport();
  });

  test('density_probe 负控：把 fill 破坏后验收函数必须明确失败（不是只判字段存在）', async () => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/admin/inquiries`);
    await expect(page.locator('.inq-list > .adm-card')).toBeVisible();
    const good = await density(page, { type: 'work', density: 7, main: '.adm-main', gutter: 16, gap: 16, pad: 16 });
    expect(() => assertDesktopDensity(good, '正常')).not.toThrow();
    // 构造 verdict.D2='fail' 的探针结果（metric 顶层字段原样保留），确认验收函数抛错。
    const broken = { ...good, verdict: { ...(good.verdict as Record<string, string>), D2: 'fail', pass: false } };
    expect(() => assertDesktopDensity(broken, '负控')).toThrow();
    // 再构造 D5='fail'，同样必须失败，证明不是只判某一个字段存在。
    const brokenD5 = { ...good, verdict: { ...(good.verdict as Record<string, string>), D5: 'fail', pass: false } };
    expect(() => assertDesktopDensity(brokenD5, '负控 D5')).toThrow();
  });

  test('详情适用 form 区 density_probe 与三尺寸动作', async () => {
    test.setTimeout(150_000);
    const out = report();
    out.viewports = [];
    // 先由本用例真实建一条合成询盘，拿它自己的 ref；三尺寸都只进入这条记录，不点任意首行。
    stage('create-synthetic');
    const tag = `m3t21-form-${Date.now()}`;
    const ref = await createSyntheticInquiry(page, tag);
    out.refPattern = /^PJ-/.test(ref);
    for (const view of [{ width: 1920, height: 1080, label: '1920x1080' }, { width: 1440, height: 900, label: '1440x900' }, { width: 390, height: 844, label: '390x844' }]) {
      stage(`viewport:${view.label}`);
      await page.setViewportSize(view);
      await page.goto(`${BASE}/admin/inquiries?q=${encodeURIComponent(ref)}`);
      // 精确按本用例 ref 定位；若该记录落在「待核实」折叠分组，按产品既有分组按钮展开（不改规则）。
      await expect(page.locator('.inq-list > .adm-card')).toBeVisible();
      let row = page.locator('.inq-list tbody tr.row').filter({ has: page.locator(`a:has-text("${ref}")`) });
      if (await row.count() === 0) {
        const expand = page.locator('.inq-list tbody tr.group button[aria-expanded=false]');
        if (await expand.count() > 0) { await expand.first().click(); }
        row = page.locator('.inq-list tbody tr.row').filter({ has: page.locator(`a:has-text("${ref}")`) });
      }
      await expect(row, `${view.label} 必须找到本用例合成 ref ${ref}`).toHaveCount(1);
      await row.locator('a').first().click();
      await expect(page.locator('.inq-detail > .adm-crumb')).toBeVisible();
      const form = await density(page, { type: 'form', density: 7, main: '.adm-main', gutter: 16, gap: 16, pad: 16 });
      if (view.width >= 1024) assertDesktopDensity(form, `${view.label} form`);
      else expect((form.verdict as Record<string, string>).overflow).toBe('pass');
      const s = await page.evaluate(() => {
        const card = document.querySelector('.inq-detail .adm-sec');
        const cs = card ? getComputedStyle(card) : null;
        const btn = document.querySelector('.inq-detail button');
        const bs = btn ? getComputedStyle(btn) : null;
        const r = btn ? btn.getBoundingClientRect() : null;
        return { border: cs?.borderTopWidth, radius: cs?.borderTopLeftRadius, shadow: cs?.boxShadow, btnMinHeight: bs?.minHeight, btnH: r ? Math.round(r.height) : 0 };
      });
      expect(s.border).toBe('2px');
      expect(s.radius).toBe('0px');
      expect(s.shadow).toBe('none');
      expect(parseFloat(s.btnMinHeight ?? '0')).toBeGreaterThanOrEqual(44);
      expect(s.btnH).toBeGreaterThanOrEqual(44);
      (out.viewports as unknown[]).push({ label: view.label, densityForm: safeDensity(form), sectionBorder: s.border, sectionRadius: s.radius, sectionShadow: s.shadow, buttonMinHeight: s.btnMinHeight, buttonRectHeight: s.btnH });
    }
    finishReport();
  });

  test('六态采集：loading / empty / error / success / disabled / focus 的真实控件判定', async () => {
    test.setTimeout(120_000);
    const r = report();
    r.loadingCapture = 'addInitScript: MutationObserver(childList/subtree) + DOMContentLoaded';
    // 以下仅为既有具名测试路径，本卡同头未重跑，不冒充 error UI / 匿名化只读 / 邮件 gate 已验。
    r.existingEvidenceOnly = [
      'tests/admin-inquiry-*.test.ts / e2e/admin.spec.ts（既有真实 401 / 错误路径）',
      'tests/admin-anonymized-ui.test.ts（showReply/showAssign/showTrust/piiField/DeletedBody）',
      'tests/inquiry-authz.test.ts（SALES 他人详情/history 404、改派 403）',
      'tests/admin-mail-states-74.test.ts / mail-routes.test.ts（GET/POST 开关、关闭不发信、旧回退）',
    ];
    r.gaps = [
      'error UI：本文件未触发真实错误响应，未取得同头具名证据',
      '匿名化只读 UI：未在本文件重跑，仅既有静态测试路径',
      '邮件 gate 开关：未在本文件重跑，仅既有静态测试路径',
    ];
    r.sixStatesComplete = false;
    stage('loading-capture');
    await page.setViewportSize({ width: 1440, height: 900 });
    // loading 真实采样：goto 前装 MutationObserver + DOMContentLoaded，记录「加载中…」行是否真实出现过。
    // 不用 count()>=0 这类恒真判断；没捕到就如实 false，不写成固定 true。
    await page.addInitScript(() => {
      const w = window as unknown as { __m3t21LoadingSeen?: boolean };
      w.__m3t21LoadingSeen = false;
      const check = () => {
        const cells = document.querySelectorAll('.inq-list tbody tr td');
        for (const c of Array.from(cells)) if ((c.textContent || '').includes('加载中')) w.__m3t21LoadingSeen = true;
      };
      new MutationObserver(check).observe(document, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', check, { once: true });
      check();
    });
    await page.goto(`${BASE}/admin/inquiries`);
    await expect(page.locator('.inq-list > .adm-card')).toBeVisible();
    const loadingRowSeen = await page.evaluate(() => (window as unknown as { __m3t21LoadingSeen?: boolean }).__m3t21LoadingSeen === true);
    r.loadingRowSeen = loadingRowSeen;
    r.verifiedInThisSpec = ['loading(采样)', 'empty', 'disabled', 'focus', 'success'];
    stage('empty-state');
    // empty：用一个不可能命中的 q，真实 GET 返回空集。
    await page.getByLabel('搜索').fill('zzz-no-such-ref-zzz');
    await page.getByRole('button', { name: '搜索' }).click();
    await expect(page.locator('.inq-list tbody').getByText('没有符合条件的询盘')).toBeVisible();
    // disabled：空结果时「上一页」禁用，computed style 为虚线边框、不透明。
    const prev = page.getByRole('button', { name: '上一页' });
    await expect(prev).toBeDisabled();
    const disabled = await prev.evaluate((el) => { const s = getComputedStyle(el); return { opacity: s.opacity, borderStyle: s.borderTopStyle, cursor: s.cursor }; });
    expect(disabled.opacity).toBe('1');
    expect(disabled.borderStyle).toBe('dashed');
    // focus：Tab 到命名控件，焦点环可见。
    await page.getByLabel('搜索').focus();
    const focus = await page.evaluate(() => { const el = document.activeElement; return el ? { label: el.getAttribute('aria-label'), outline: getComputedStyle(el).outlineStyle } : null; });
    expect(focus?.label).toBe('搜索');
    expect(focus?.outline).not.toBe('none');
    // success：清空筛选恢复列表，成功态可见（行/编号）。
    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(page.locator('.inq-list > .adm-card')).toBeVisible();
    // 六态字段逐步累积到 beforeEach 已初始化的报告；error 如实标本文件未触发，不冒充同头具名证据。
    r.states = {
      emptyTextSeen: true, disabledOpacity: disabled.opacity, disabledBorder: disabled.borderStyle,
      focusLabel: focus?.label ?? null, focusOutline: focus?.outline ?? null, successCardVisible: true,
      errorTriggeredInThisSpec: false,
    };
    finishReport();
  });

  test('SALES 真实身份：他人询盘详情 GET 404、改派 PATCH 403（不降为匿名）', async ({ browser }, testInfo) => {
    test.setTimeout(150_000);
    const r = report();
    // ADMIN 侧真实建一条合成询盘；用它自己的 ref 精确过滤定位该记录 id，不点任意首行，
    // 录屏/open 详情前就确定是本用例的 fixture。
    stage('admin-create-synthetic');
    const adminCtx = await contextFor(browser, adminState, testInfo);
    const adminPage = await adminCtx.newPage();
    const tag = `m3t21-sales-${Date.now()}`;
    const ref = await createSyntheticInquiry(adminPage, tag);
    r.refPattern = /^PJ-/.test(ref);
    await adminPage.goto(`${BASE}/admin/inquiries?q=${encodeURIComponent(ref)}`);
    await expect(adminPage.locator('.inq-list > .adm-card')).toBeVisible();
    let row = adminPage.locator('.inq-list tbody tr.row').filter({ has: adminPage.locator(`a:has-text("${ref}")`) });
    if (await row.count() === 0) {
      const expand = adminPage.locator('.inq-list tbody tr.group button[aria-expanded=false]');
      if (await expand.count() > 0) await expand.first().click();
      row = adminPage.locator('.inq-list tbody tr.row').filter({ has: adminPage.locator(`a:has-text("${ref}")`) });
    }
    await expect(row, '必须找到本用例合成 ref 对应记录').toHaveCount(1);
    const href = await row.locator('a').first().getAttribute('href');
    expect(href).toMatch(/\/admin\/inquiries\//);
    const id = href!.split('/').pop()!;
    r.targetIdPattern = /^[a-z0-9]{20,40}$/.test(id);
    // 取一个真实合法用户 id 作 assigneeId：让 zod ID_RE 通过，PATCH 的 403 只可能来自
    // route.ts:57 的角色判定，而不是 forbidden_origin（缺 Origin）或 invalid（非法 id）。
    const usersResp = await adminCtx.request.get('/api/admin/users');
    expect(usersResp.status()).toBe(200);
    const usersBody = (await usersResp.json()) as { items?: Array<{ id: string; role: string }> };
    const realAssignee = (usersBody.items ?? []).find((u) => /^[a-z0-9]{20,40}$/.test(u.id))?.id;
    expect(realAssignee, 'ADMIN 账号列表必须给出合法真实用户 id').toBeTruthy();
    await adminCtx.close();

    // 独立 SALES 账号真实登录；GET /api/admin/account 的 DTO 自带 role，先确证身份确为 SALES。
    stage('sales-login');
    const sales = await loginRole(browser, 'e2e-inq-sales', 'SALES');
    const salesCtx = await browser.newContext({ baseURL: BASE, storageState: sales.state });
    const acct = await salesCtx.request.get(ACCOUNT);
    expect(acct.status()).toBe(200);
    const acctBody = (await acct.json()) as { role?: string };
    expect(acctBody.role, 'SALES 身份确认（不是匿名/降权）').toBe('SALES');
    r.salesRoleConfirmed = acctBody.role === 'SALES';

    // 归属拒绝：GET 详情针对「本用例所建记录」→ 未分配给该 SALES → 404 not_found。
    stage('sales-scope-get');
    const detail = await salesCtx.request.get(`/api/admin/inquiries/${id}`);
    expect(detail.status(), 'SALES 读未分配给他人的询盘必须 404').toBe(404);

    // 改派拒绝：PATCH 带同源 Origin + 合法真实 assigneeId，403 只能来自角色判定。
    stage('sales-assign-patch');
    const patch = await salesCtx.request.patch(`/api/admin/inquiries/${id}`, {
      headers: { Origin: BASE },
      data: { assigneeId: realAssignee },
    });
    expect(patch.status(), 'SALES 改派必须 403').toBe(403);
    const patchBody = (await patch.json()) as { error?: string };
    expect(patchBody.error, '403 必须来自角色判定 forbidden，而非 forbidden_origin / invalid').toBe('forbidden');
    await salesCtx.close();

    r.role = 'SALES';
    r.detailStatus = detail.status();
    r.patchStatus = patch.status();
    r.patchError = patchBody.error ?? null;
    r.targetIsSyntheticRecord = true;
    finishReport();
  });
});
