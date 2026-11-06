import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { request } from '@playwright/test';
import { loadRunAuth } from './run-auth';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
// 与 playwright.config.ts 的 `E2E_PORT ?? 3100` 一致；不 import 该 config，也不 import 会间接
// 加载它的 shared-admin，避免本机/收集时触发 standalone 产物前置（CI 仍由真实 config 的
// webServer 起同一端口的服务）；认证状态只由 run-auth 的正常登录初始化。
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;

import { STATUS_LABEL } from '../src/lib/admin/types';

/**
 * M3-T21 旧询盘页视觉迁移：真实登录 → 真实合成询盘 → 原 GET 过滤/分页/详情/history
 * → 状态/分配/notes 持久 → 三尺寸 computed style / density_probe D1–D6 / overflow
 * → 真实触控 44px 矩形 / 六态 / JSON+PNG+video 同次来源证据。
 *
 * 身份来自本 run 正常 Auth.js 登录的 content-admin / sales 会话；worker 只读，失败不补登录。
 * ADMIN/SALES 角色分别保留，不复用全局 E2E_ADMIN、不靠 test.skip 换绿。
 * 合成数据：真实 POST /api/inquiries，读响应 ref 在列表定位，不直插 DB、不改响应、不造 DOM。
 * 证据：test.use({ video:'on' }) 文件顶层一次；JSON/PNG 写到各用例 testInfo.outputPath
 * （同名重跑不覆盖项目其它证据），density probe 写 JSON 前按白名单投影，PNG 只截控件区不进数据行。
 */

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

/** Load the run's already authenticated positive role; no worker performs credentials login. */
async function loginRole(role: 'ADMIN' | 'SALES'): Promise<{ state: SessionState }> {
  return { state: await loadRunAuth(role === 'ADMIN' ? 'content-admin' : 'sales', BASE, request) };
}

/** 用某角色的 storageState 建本用例自己的 context（继承 baseURL 与必要 video/locale）。
 *  自建 context 显式装外部拦截 + Turnstile 桩，补齐默认 page fixture 不覆盖本卡 context 的缺口。
 *  opts 可指定真实触控配置（hasTouch/isMobile）与视口；触控是 context 级能力，setViewportSize 改不了。 */
async function contextFor(browser: Browser, state: SessionState, testInfo: TestInfo, opts?: { viewport?: { width: number; height: number }; hasTouch?: boolean; isMobile?: boolean; videoSize?: { width: number; height: number } }): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: BASE, storageState: state, locale: 'en-US',
    ...(opts?.viewport ? { viewport: opts.viewport } : {}),
    ...(opts?.hasTouch ? { hasTouch: true } : {}),
    ...(opts?.isMobile ? { isMobile: true } : {}),
    recordVideo: { dir: testInfo.outputPath('video'), size: opts?.videoSize ?? { width: 1280, height: 720 } },
  });
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

/** 真实键盘 Tab：只按 Tab 键循环到达指定 aria-label 控件，不用 .focus() 冒充；
 *  返回 activeElement 的真实矩形与 focus-visible computed outline。 */
async function tabTo(page: Page, ariaLabel: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate((wanted) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el.getAttribute('aria-label') !== wanted) return null;
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return { tag: el.tagName, label: el.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height),
        outlineWidth: s.outlineWidth, outlineOffset: s.outlineOffset, outlineColor: s.outlineColor, outlineStyle: s.outlineStyle, minHeight: s.minHeight };
    }, ariaLabel);
    if (hit) return hit;
  }
  return null;
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
test.beforeAll(async () => { adminState = (await loginRole('ADMIN')).state; });

test.describe('M3-T21 询盘/邮件视觉迁移（ADMIN 整组一次登录）', () => {
  let ctx: BrowserContext;
  let page: Page;
  // 每用例独立安全报告：在 beforeEach 最开头就按用例名初始化（而不是主体末尾），
  // 主体只往 activeReport.payload 累积白名单字段；前段任何一步失败，afterEach 仍写出
  // 已取得的安全诊断（complete=false）。不采证的负控用例不初始化，避免空报告。
  const REPORT_BY_TEST: Record<string, string> = {
    '真实合成询盘 → 列表 GET 过滤/分页/日期/状态/负责人 → 详情 PATCH/分配/notes 持久': 'admin-legacy-inquiries.json',
    '三尺寸真实页：wrapper 几何 / density_probe D1–D6 / computed style / overflow / 键盘 36/44 触控': 'admin-legacy-inquiries-visual.json',
    '详情适用 form 区 density_probe 与三尺寸动作': 'admin-legacy-inquiries-form.json',
    '六态采集：loading / empty / error / success / disabled / focus 的真实控件判定': 'admin-legacy-inquiries-states.json',
    'SALES 真实身份：他人询盘详情 GET 404、改派 PATCH 403（不降为匿名）': 'admin-legacy-inquiries-sales.json',
    'E1 真实 400：搜索 101 字符 / 备注 5001 字符错误与纠正恢复': 'admin-legacy-inquiries-error.json',
    'A1 仅本用例合成询盘：原 privacy/export+delete 匿名化、PII 消失、只读与 409、history 保留': 'admin-legacy-inquiries-anon.json',
    '三尺寸完整流程：列表→详情→状态/分配/备注写动作→刷新持久（1920/1440/390 真触控 tap，原生帧）': 'admin-legacy-inquiries-flow.json',
  };
  let activeReport: { testInfo: TestInfo; name: string; payload: Record<string, unknown> } | null = null;
  const report = () => activeReport!.payload;
  const stage = (s: string) => { if (activeReport) activeReport.payload.stage = s; };
  const finishReport = () => { if (activeReport) activeReport.payload.complete = true; };
  test.beforeEach(async ({ browser }) => {
    const testInfo = test.info();
    const name = REPORT_BY_TEST[testInfo.title];
    activeReport = name ? { testInfo, name, payload: { runSource: 'admin-legacy-inquiries-visual.spec.ts', complete: false, stage: 'setup' } } : null;
    ctx = await contextFor(browser, adminState, testInfo);
    page = await ctx.newPage();
    stage('context-ready');
  });
  // 清理失败不能让成功主体假绿：afterEach 拿不到主体错误，所以把「证据写出」与「context 关闭」
  // 都做成显式抛错（Playwright 把 afterEach 的 error 计入用例失败）。主体已失败时这个 hook 抛出的
  // 错误会并列记录，不吞原错、也不把 complete=true 写成无条件成功。额外 ADMIN/SALES context 由各用例 finally 关。
  test.afterEach(async () => {
    const pending = activeReport;
    let failure: string | null = null;
    if (pending) {
      try { await writeJson(pending.testInfo, pending.name, pending.payload); }
      catch (e) { failure = `证据 JSON 写出失败：${String((e as Error).message ?? e)}`; }
    }
    try { if (ctx) await ctx.close(); }
    catch (e) { failure = `${failure ? failure + '；' : ''}context 关闭失败：${String((e as Error).message ?? e)}`; }
    activeReport = null;
    if (failure) throw new Error(`[M3-T21 teardown] ${failure}`);
  });

  test('真实合成询盘 → 列表 GET 过滤/分页/日期/状态/负责人 → 详情 PATCH/分配/notes 持久', async () => {
    const testInfo = test.info();
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

    // 逐项触发既有 GET /api/admin/inquiries 的真实查询参数（不是只做 q 搜索、标题却写满）。
    const awaitParam = async (key: string, value: string | null) => {
      await expect.poll(() => gets.some((u) => new URL(u).searchParams.get(key) === value), `${key}=${value} 的 GET 参数`).toBe(true);
    };
    // q 搜索
    await page.getByLabel('搜索').fill(ref);
    await page.getByRole('button', { name: '搜索' }).click();
    await awaitParam('q', ref);
    // 日期 from/to：打开 DateRange 弹层，取「今天」预设（真实 onChange → router.replace → GET）
    await page.locator('.inq-list .drp>button').click();
    await expect(page.locator('.inq-list .drp-pop')).toBeVisible();
    const today = new Date().toISOString().slice(0, 10);
    await page.locator('.inq-list .drp-pop .presets button').first().click();
    await awaitParam('from', today);
    await awaitParam('to', today);
    // 状态 tab：点「跟进中」，触发 status=FOLLOWING 的 GET
    await page.locator('.inq-list .adm-tabs button', { hasText: '跟进中' }).click();
    await awaitParam('status', 'FOLLOWING');
    // 负责人：选「未分配」，触发 assignee=none 的 GET
    await page.locator('.inq-list select[aria-label="负责人"]').selectOption('none');
    await awaitParam('assignee', 'none');
    // 分页：清空筛选后点下一页，触发 page=2 的 GET（列表数据足够时才可点）
    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect.poll(() => gets.some((u) => new URL(u).searchParams.get('q') === null)).toBe(true);
    const next = page.getByRole('button', { name: '下一页' });
    if (await next.isEnabled()) { await next.click(); await awaitParam('page', '2'); }
    r.listGetParamsObserved = { q: true, fromTo: true, status: true, assignee: true, page: await next.isEnabled() };
    // 回到 q 过滤，精确定位本用例合成记录（不是任意首行）。
    await page.getByLabel('搜索').fill(ref);
    await page.getByRole('button', { name: '搜索' }).click();
    await expect.poll(() => gets.some((u) => new URL(u).searchParams.get('q') === ref)).toBe(true);
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

    // 负责人分配：必须有真实合法用户可选（不静默跳过），点击前配对本次真实 PATCH 响应，
    // 核响应 assigneeId 等于所选值，刷新后下拉框仍选中该值。
    const assignSelect = page.locator('.inq-detail select[aria-label="负责人"]');
    const optionValues = await assignSelect.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    const target = optionValues.find((v) => v && v !== '');
    expect(target, '分配下拉框必须有真实用户可选').toBeTruthy();
    const assignRespPromise = page.waitForResponse((res) => res.request().method() === 'PATCH' && /\/api\/admin\/inquiries\/[^/]+$/.test(new URL(res.url()).pathname) && (res.request().postData() ?? '').includes('assigneeId'));
    await assignSelect.selectOption(target!);
    const assignResp = await assignRespPromise;
    expect(assignResp.status(), '分配 PATCH 须 200').toBe(200);
    const assignJson = (await assignResp.json()) as { assigneeId?: string | null };
    expect(assignJson.assigneeId, '响应 assigneeId 必须等于所选真实用户').toBe(target);
    r.assigneeIdPersistedInResponse = assignJson.assigneeId === target;
    // 内部备注 POST notes，核真实 body。
    const noteBox = page.locator('.inq-detail textarea[aria-label="内部备注"]');
    await noteBox.fill(`M3-T21 note ${tag}`);
    await page.getByRole('button', { name: '添加备注' }).click();
    await expect.poll(() => mutations.some((m) => m.method === 'POST' && m.path.endsWith('/notes') && m.body.includes(tag))).toBe(true);
    await expect(page.locator('.inq-detail').getByText(`M3-T21 note ${tag}`)).toBeVisible();

    // 刷新后持久一致：状态、分配值、备注都还在（分配不再只搜请求 body 字符串）。
    await page.reload();
    await expect(page.getByTestId('status-badge')).toHaveText(STATUS_LABEL.FOLLOWING);
    await expect(page.locator('.inq-detail select[aria-label="负责人"]')).toHaveValue(target!);
    await expect(page.locator('.inq-detail').getByText(`M3-T21 note ${tag}`)).toBeVisible();
    r.assigneePersistedAfterReload = true;

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

  test('三尺寸真实页：wrapper 几何 / density_probe D1–D6 / computed style / overflow / 键盘 36/44 触控', async ({ browser }) => {
    test.setTimeout(180_000);
    const out = report();
    out.viewports = [];
    // 触控是 context 级能力：每个视口用独立 context，手机档显式 hasTouch+isMobile，
    // 桌面两档明确非触控。不用 setViewportSize 冒充真实粗指针。
    await ctx.close();
    ctx = await contextFor(browser, adminState, test.info(), { viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    let viewCtx: BrowserContext | null = null;
    try {
    for (const view of [{ width: 1920, height: 1080, label: '1920x1080', touch: false }, { width: 1440, height: 900, label: '1440x900', touch: false }, { width: 390, height: 844, label: '390x844', touch: true }]) {
      stage(`viewport:${view.label}`);
      if (viewCtx) { await viewCtx.close(); viewCtx = null; }
      viewCtx = await contextFor(browser, adminState, test.info(), { viewport: { width: view.width, height: view.height }, hasTouch: view.touch, isMobile: view.touch });
      page = await viewCtx.newPage();
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
        const inputEl = document.querySelector('.inq-list .adm-filters input') as HTMLElement | null;
        const inputRect = inputEl ? inputEl.getBoundingClientRect() : null;
        const th = document.querySelector('.inq-list .adm-inq-table th') as HTMLElement | null;
        const tabBtn = document.querySelector('.inq-list .adm-tabs button') as HTMLElement | null;
        const tabRect = tabBtn ? tabBtn.getBoundingClientRect() : null;
        const drpBtn = document.querySelector('.inq-list .drp>button') as HTMLElement | null;
        return {
          wrapperDisplay: wcs?.display ?? null,
          wrapperBox: wr ? { w: Math.round(wr.width * 100) / 100, h: Math.round(wr.height * 100) / 100 } : null,
          h1: off('.inq-list > h1'), tabs: off('.inq-list > .adm-tabs'), card: off('.inq-list > .adm-card'),
          cardBorder: card?.borderTopWidth ?? null, cardRadius: card?.borderTopLeftRadius ?? null, cardShadow: card?.boxShadow ?? null,
          cardSides: { top: card?.borderTopColor, right: card?.borderRightColor, bottom: card?.borderBottomColor, left: card?.borderLeftColor },
          cornerRadius: { tl: card?.borderTopLeftRadius, tr: card?.borderTopRightRadius, br: card?.borderBottomRightRadius, bl: card?.borderBottomLeftRadius },
          cardBgImage: card?.backgroundImage ?? null,
          inputBorder: input?.borderTopWidth ?? null, inputMinHeight: input?.minHeight ?? null, inputFont: input?.fontSize ?? null,
          inputRect: inputRect ? { w: Math.round(inputRect.width), h: Math.round(inputRect.height) } : null,
          tabMinHeight: tabBtn ? getComputedStyle(tabBtn).minHeight : null,
          tabRect: tabRect ? { w: Math.round(tabRect.width), h: Math.round(tabRect.height) } : null,
          tableTh: th ? { font: getComputedStyle(th).fontSize, line: getComputedStyle(th).lineHeight } : null,
          drpPresent: !!drpBtn,
          touchMatches: matchMedia('(pointer:coarse),(max-width:767px)').matches,
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
      expect(m.inputFont, `${view.label} 单行输入 16px`).toBe('16px');
      // 11 节口径：普通桌面单行 36px、触控 ≥44；不是所有尺寸一律 44。
      const targetH = view.touch ? 44 : 36;
      expect(parseFloat(m.inputMinHeight ?? '0'), `${view.label} 输入 min-height`).toBeGreaterThanOrEqual(targetH);
      expect(m.inputRect!.h, `${view.label} 输入真实矩形高`).toBeGreaterThanOrEqual(targetH);
      expect(m.touchMatches, `${view.label} 触控 media 应与 context 一致`).toBe(view.touch);
      expect(m.tableTh!.font, `${view.label} 表头 14px`).toBe('14px');
      expect(m.tableTh!.line, `${view.label} 表头行高 20px`).toBe('20px');
      expect(m.drpPresent, `${view.label} 日期弹层控件须存在`).toBe(true);
      if (view.touch) {
        expect(m.tabRect!.h, `${view.label} tabs 触控高 ≥44`).toBeGreaterThanOrEqual(44);
        expect(m.tabRect!.w, `${view.label} tabs 触控宽 ≥44`).toBeGreaterThanOrEqual(44);
      }
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
      // 真实键盘：只按 Tab 到命名控件「搜索」，核 focus-visible 完整 outline 与真实矩形。
      const focus = await tabTo(page, '搜索');
      expect(focus, `${view.label} 搜索框须真实 Tab 可达`).not.toBeNull();
      expect(focus!.h, `${view.label} 焦点控件真实高度`).toBeGreaterThanOrEqual(targetH);
      expect(focus!.outlineStyle, `${view.label} focus-visible outline 存在`).not.toBe('none');
      expect(focus!.outlineWidth, `${view.label} focus outline 2px`).toBe('2px');
      expect(focus!.outlineOffset, `${view.label} focus outline offset 2px`).toBe('2px');
      expect(focus!.outlineColor, `${view.label} focus outline 强调色`).toBe('rgb(180, 87, 0)');
      (out.viewports as unknown[]).push({ label: view.label, touch: view.touch, wrapper: m.wrapperBox, card: m.card,
        densityWork: safeDensity(work), overflow: m.noHorizontalOverflow, inputFont: m.inputFont,
        inputRect: m.inputRect, tableTh: m.tableTh, tabRect: m.tabRect, focusOutline: { width: focus!.outlineWidth, offset: focus!.outlineOffset, color: focus!.outlineColor } });
    }
    } finally {
      if (viewCtx) await viewCtx.close();
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
    for (const view of [{ width: 1920, height: 1080, label: '1920x1080', touch: false }, { width: 1440, height: 900, label: '1440x900', touch: false }, { width: 390, height: 844, label: '390x844', touch: true }]) {
      stage(`viewport:${view.label}`);
      // 该用例沿用 beforeEach 的桌面 context 只做 setViewportSize：CSS 的 (max-width:767px)
      // 会让 390 档进 44px 触控口径，桌面两档是 36px。真实 hasTouch/coarse 由上面的三尺寸用例
      // 用独立 context 覆盖，这里不冒充粗指针设备能力。
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
        // 精确量真实按钮：优先 .adm-btn.sq（旧 10px 圆角来源），否则取第一个详情按钮。
        const btn = (document.querySelector('.inq-detail button.adm-btn.sq') || document.querySelector('.inq-detail button')) as HTMLElement | null;
        const bs = btn ? getComputedStyle(btn) : null;
        const r = btn ? btn.getBoundingClientRect() : null;
        return {
          border: cs?.borderTopWidth, radius: cs?.borderTopLeftRadius, shadow: cs?.boxShadow,
          btnSelector: btn ? btn.className : null,
          btnRadius: bs?.borderTopLeftRadius ?? null, btnMinHeight: bs?.minHeight ?? null,
          btnH: r ? Math.round(r.height) : 0, btnW: r ? Math.round(r.width) : 0,
          btnFont: bs?.fontSize ?? null,
        };
      });
      expect(s.border).toBe('2px');
      expect(s.radius).toBe('0px');
      expect(s.shadow).toBe('none');
      // 旧 .adm-btn.sq 的 10px 圆角必须被本卡命名域覆盖掉（Chief 首轮独审阻断）。
      expect(s.btnRadius, `${view.label} 真实按钮圆角须为 0px，不得残留 10px`).toBe('0px');
      expect(s.btnFont, `${view.label} 按钮字号 16px`).toBe('16px');
      const targetH = view.touch ? 44 : 36;
      expect(parseFloat(s.btnMinHeight ?? '0'), `${view.label} 按钮 min-height`).toBeGreaterThanOrEqual(targetH);
      expect(s.btnH, `${view.label} 按钮真实高`).toBeGreaterThanOrEqual(targetH);
      if (view.touch) expect(s.btnW, `${view.label} 按钮触控宽 ≥44`).toBeGreaterThanOrEqual(44);
      (out.viewports as unknown[]).push({ label: view.label, touch: view.touch, densityForm: safeDensity(form), sectionBorder: s.border, sectionRadius: s.radius, sectionShadow: s.shadow, buttonSelector: s.btnSelector, buttonRadius: s.btnRadius, buttonMinHeight: s.btnMinHeight, buttonRectHeight: s.btnH, buttonRectWidth: s.btnW });
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
    // 这些不是「等 CI 就自动补」：需真实隔离 PG/SMTP、真实匿名化数据与不改产品响应/权限的
    // 错误分支，本卡授权范围内无法安全构造，按事实标为未取得、不会被成功 card 或旧路径冒充。
    r.gaps = [
      'error UI：需真实错误响应分支；本文件未触发，同头具名证据未取得，保持未通过',
      '匿名化只读 UI：需真实已匿名化询盘数据；本文件不造 DB/响应，未取得同头具名证据',
      '邮件 gate 开启/关闭不发信与旧回退：需隔离 PG/SMTP 与真实 mail config；本文件不造后端状态，未取得同头具名证据',
    ];
    r.sixStatesComplete = false;
    r.gapsNotAutoFilledByCi = true;
    // 逐态按真实执行结果累积，不在状态发生前预写 verified 列表。
    r.verifiedInThisSpec = [];
    const verified = r.verifiedInThisSpec as string[];
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
    if (loadingRowSeen) verified.push('loading(采样)'); // loadingSeen=false 时不列 verified
    stage('empty-state');
    // empty：用一个不可能命中的 q，真实 GET 返回空集。
    await page.getByLabel('搜索').fill('zzz-no-such-ref-zzz');
    await page.getByRole('button', { name: '搜索' }).click();
    await expect(page.locator('.inq-list tbody').getByText('没有符合条件的询盘')).toBeVisible();
    verified.push('empty');
    // disabled：空结果时「上一页」禁用，computed style 为虚线边框、不透明。
    const prev = page.getByRole('button', { name: '上一页' });
    await expect(prev).toBeDisabled();
    const disabled = await prev.evaluate((el) => { const s = getComputedStyle(el); return { opacity: s.opacity, borderStyle: s.borderTopStyle, cursor: s.cursor }; });
    expect(disabled.opacity).toBe('1');
    expect(disabled.borderStyle).toBe('dashed');
    verified.push('disabled');
    // focus：只用真实 Tab 到达命名控件「搜索」，不用 .focus() 冒充，核完整 outline。
    const focus = await tabTo(page, '搜索');
    expect(focus, 'focus 态须真实 Tab 可达').not.toBeNull();
    expect(focus!.outlineStyle).not.toBe('none');
    expect(focus!.outlineWidth).toBe('2px');
    expect(focus!.outlineOffset).toBe('2px');
    expect(focus!.outlineColor).toBe('rgb(180, 87, 0)');
    verified.push('focus');
    // success：清空筛选后不只看始终存在的 .adm-card，而要真实 GET 后数据行出现（行/编号）。
    stage('success-state');
    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(page.locator('.inq-list tbody tr.row').first()).toBeVisible({ timeout: 15_000 });
    verified.push('success');
    // 六态字段逐步累积到 beforeEach 已初始化的报告；error 如实标本文件未触发，不冒充同头具名证据。
    r.states = {
      emptyTextSeen: true, disabledOpacity: disabled.opacity, disabledBorder: disabled.borderStyle,
      focusLabel: focus?.label ?? null, focusOutline: { width: focus!.outlineWidth, offset: focus!.outlineOffset, color: focus!.outlineColor },
      successRowVisible: true, errorTriggeredInThisSpec: false,
    };
    finishReport();
  });

  test('SALES 真实身份：他人询盘详情 GET 404、改派 PATCH 403（不降为匿名）', async ({ browser }) => {
    const testInfo = test.info();
    test.setTimeout(150_000);
    const r = report();
    // ADMIN 侧真实建一条合成询盘；用它自己的 ref 精确过滤定位该记录 id，不点任意首行，
    // 录屏/open 详情前就确定是本用例的 fixture。
    stage('admin-create-synthetic');
    const adminCtx = await contextFor(browser, adminState, testInfo);
    let salesCtx: BrowserContext | null = null;
    let adminClosed = false;
    try {
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
      await adminCtx.close(); adminClosed = true;

      // 读取本 run 的独立 SALES 会话；GET /api/admin/account 仍确证当前身份确为 SALES。
      stage('sales-login');
      const sales = await loginRole('SALES');
      salesCtx = await browser.newContext({ baseURL: BASE, storageState: sales.state });
      const acct = await salesCtx.request.get(ACCOUNT);
      expect(acct.status()).toBe(200);
      const acctBody = (await acct.json()) as { role?: string };
      expect(acctBody.role, 'SALES 身份确认（不是匿名/降权）').toBe('SALES');
      r.salesRoleConfirmed = acctBody.role === 'SALES';

      // SALES 本人可见列表：列表页 200、.inq-list 渲染、本人 scope 的 GET 成功（不造数据）。
      stage('sales-own-list');
      const salesPage = await salesCtx.newPage();
      const listResp = await salesPage.goto(`${BASE}/admin/inquiries`);
      expect(listResp, 'SALES 本人列表页须有真实响应').not.toBeNull();
      expect(listResp!.status(), 'SALES 列表页须 200').toBe(200);
      await expect(salesPage.locator('.inq-list > .adm-card')).toBeVisible();
      const salesList = await salesCtx.request.get('/api/admin/inquiries');
      expect(salesList.status(), 'SALES 本人 scope 列表 GET 须 200').toBe(200);
      r.salesOwnListOk = true;
      await salesPage.close();

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

      r.role = 'SALES';
      r.detailStatus = detail.status();
      r.patchStatus = patch.status();
      r.patchError = patchBody.error ?? null;
      r.targetIsSyntheticRecord = true;
    } finally {
      // 任何中途失败都关闭这两个自建 context；关闭异常不覆盖主体原错，但也不让资源泄漏。
      try { if (!adminClosed) await adminCtx.close(); } catch { /* 不覆盖主体原错 */ }
      try { if (salesCtx) await salesCtx.close(); } catch { /* 不覆盖主体原错 */ }
    }
    finishReport();
  });

  test('E1 真实 400：搜索 101 字符 / 备注 5001 字符错误与纠正恢复', async () => {
    test.setTimeout(180_000);
    const testInfo = test.info();
    const r = report();
    const shot = async (name: string) => {
      const path = testInfo.outputPath(name);
      await page.screenshot({ path });
      expect(readFileSync(path).length).toBeGreaterThan(0);
      return name;
    };
    const tag = `m3t21-err-${Date.now()}`;
    const ref = await createSyntheticInquiry(page, tag);
    // createSyntheticInquiry 结束时仍在 /en/contact 成功页：先真实进入后台列表再操作。
    await page.goto(`${BASE}/admin/inquiries`);
    await expect(page.locator('.inq-list > .adm-card')).toBeVisible();
    await expect(page.locator('.inq-list > h1')).toBeVisible();

    // 只统计“目标业务接口”的写请求；activity/RUM/account/users 不计入。
    const biz: Array<{ method: string; path: string; body: string }> = [];
    const isTargetBiz = (u: URL) => u.pathname === '/api/admin/inquiries' || u.pathname.startsWith('/api/admin/inquiries/');
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (['PATCH', 'POST', 'PUT', 'DELETE'].includes(req.method()) && isTargetBiz(u)) {
        biz.push({ method: req.method(), path: u.pathname, body: req.postData() ?? '' });
      }
    });

    // 搜索 101：真实 400 + 本域 alert 的实际 computed style（旧 .warn 色必须被覆盖）。
    const q101 = 'a'.repeat(101);
    const badQ = page.waitForResponse((res) => res.request().method() === 'GET'
      && new URL(res.url()).pathname === '/api/admin/inquiries'
      && new URL(res.url()).searchParams.get('q') === q101);
    await page.getByLabel('搜索').fill(q101);
    await page.getByRole('button', { name: '搜索' }).click();
    expect((await badQ).status()).toBe(400);
    const qAlert = page.locator('.inq-list td[role="alert"]');
    await expect(qAlert).toBeVisible();
    await expect(qAlert).toHaveText('参数不正确，请检查后重试。');
    await expect(page.getByLabel('搜索')).toHaveValue(q101);
    expect(biz, '搜索阶段不得有目标业务写请求').toHaveLength(0);
    const qStyle = await qAlert.evaluate((el) => {
      const s = getComputedStyle(el); const b = el.getBoundingClientRect();
      return { color: s.color, fontWeight: s.fontWeight, fontSize: s.fontSize, lineHeight: s.lineHeight, w: Math.round(b.width), h: Math.round(b.height) };
    });
    expect(qStyle).toMatchObject({ color: 'rgb(180, 87, 0)', fontSize: '14px', lineHeight: '20px' });
    expect(qStyle.color, '旧 .warn 色不得作为验收值').not.toBe('rgb(180, 68, 31)');
    expect(qStyle.w).toBeGreaterThan(0); expect(qStyle.h).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('alert');
    const frames: string[] = [await shot('inquiry-visual-1440x900-error-search.png')];
    r.qStatus = 400; r.qComputed = qStyle; r.qBizMutations = 0; r.qValueRetained = true;

    // 纠正恢复：按本次 ref 精确搜索。
    const okList = page.waitForResponse((res) => res.request().method() === 'GET'
      && new URL(res.url()).pathname === '/api/admin/inquiries'
      && new URL(res.url()).searchParams.get('q') === ref);
    await page.getByLabel('搜索').fill(ref);
    await page.getByRole('button', { name: '搜索' }).click();
    expect((await okList).status()).toBe(200);
    const row = page.locator('.inq-list tbody tr.row').filter({ has: page.locator(`a:has-text("${ref}")`) });
    await expect(row).toHaveCount(1);
    const href = await row.locator('a').first().getAttribute('href');
    expect(href).toMatch(/\/admin\/inquiries\//);
    const id = href!.split('/').pop()!;
    r.searchRecovered = true;

    // 备注 5001：400 是“尝试写入但未持久化”，不是无写请求。
    const notesBefore = (await (await ctx.request.get(`${BASE}/api/admin/inquiries/${id}`)).json()) as { notes: unknown[] };
    await row.locator('a').first().click();
    await expect(page.locator('.inq-detail > .adm-crumb')).toBeVisible();
    const note501 = 'b'.repeat(5001);
    const noteBox = page.locator('.inq-detail textarea[aria-label="内部备注"]');
    await noteBox.fill(note501);
    expect((await noteBox.inputValue()).length).toBe(5001);
    const isBody = (res: { request: () => { postData: () => string | null } }, want: string) => {
      try { return JSON.parse(res.request().postData() ?? '{}').body === want; } catch { return false; }
    };
    const badNote = page.waitForResponse((res) => res.request().method() === 'POST'
      && new URL(res.url()).pathname === `/api/admin/inquiries/${id}/notes` && isBody(res, note501));
    await page.getByRole('button', { name: '添加备注' }).click();
    expect((await badNote).status()).toBe(400);
    const nAlert = page.locator('.inq-detail > p[role="alert"]');
    await expect(nAlert).toHaveText('参数不正确，请检查后重试。');
    await expect(noteBox).toHaveValue(note501);
    const nStyle = await nAlert.evaluate((el) => {
      const s = getComputedStyle(el); const b = el.getBoundingClientRect();
      return { color: s.color, fontWeight: s.fontWeight, fontSize: s.fontSize, lineHeight: s.lineHeight, w: Math.round(b.width), h: Math.round(b.height) };
    });
    expect(nStyle).toMatchObject({ color: 'rgb(180, 87, 0)', fontSize: '14px', lineHeight: '20px' });
    expect(nStyle.color).not.toBe('rgb(180, 68, 31)');
    expect(nStyle.w).toBeGreaterThan(0); expect(nStyle.h).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('alert');
    frames.push(await shot('inquiry-visual-1440x900-error-note.png'));
    const notesAfter = (await (await ctx.request.get(`${BASE}/api/admin/inquiries/${id}`)).json()) as { notes: unknown[] };
    expect(notesAfter.notes.length, '5001 备注不得持久化').toBe(notesBefore.notes.length);
    expect(biz.filter((m) => m.path === `/api/admin/inquiries/${id}/notes`)).toHaveLength(1);
    r.noteAttempt = { method: 'POST', status: 400, persisted: false };
    r.noteValueRetained = true;

    // 纠正恢复：合法备注 201，刷新后仍在。
    const ok = `M3-T21 recover ${tag}`;
    await noteBox.fill(ok);
    const okNote = page.waitForResponse((res) => res.request().method() === 'POST'
      && new URL(res.url()).pathname === `/api/admin/inquiries/${id}/notes` && isBody(res, ok));
    await page.getByRole('button', { name: '添加备注' }).click();
    expect((await okNote).status()).toBe(201);
    await expect(page.locator('.inq-detail').getByText(ok)).toBeVisible();
    const reloadGet = page.waitForResponse((res) => res.request().method() === 'GET'
      && new URL(res.url()).pathname === `/api/admin/inquiries/${id}`);
    await page.reload();
    const reloadResp = await reloadGet;
    expect(reloadResp.status()).toBe(200);
    expect(((await reloadResp.json()) as { ref?: string }).ref).toBe(ref);
    await expect(page.locator('.inq-detail').getByText(ok)).toBeVisible();
    r.noteRecovered = true; r.frames = frames;
    finishReport();
  });

  test('A1 仅本用例合成询盘：原 privacy/export+delete 匿名化、PII 消失、只读与 409、history 保留', async () => {
    test.setTimeout(240_000);
    const testInfo = test.info();
    const r = report();
    const shot = async (name: string) => {
      const path = testInfo.outputPath(name);
      await page.screenshot({ path });
      expect(readFileSync(path).length).toBeGreaterThan(0);
      return name;
    };
    const urlOf = (s?: string) => { if (!s) return null; try { return new URL(s); } catch { return null; } };
    const db = urlOf(process.env.DATABASE_URL);
    const app = urlOf(BASE);
    const preflight = {
      githubActions: process.env.GITHUB_ACTIONS === 'true',
      ci: process.env.CI === 'true',
      loopbackOrigin: !!app && ['localhost', '127.0.0.1'].includes(app.hostname)
        && app.port === (process.env.E2E_PORT ?? '3100'),
      dbLoopback: !!db && ['localhost', '127.0.0.1'].includes(db.hostname) && db.port === '5432',
      dbNameE2e: !!db && db.pathname.replace(/^\//, '') === 'e2e',
      privacySecretPresent: !!process.env.PRIVACY_HASH_SECRET,
    };
    expect(preflight, 'A1 必须在 GitHub Actions 隔离 e2e 环境执行；不符则在删除前失败').toEqual({
      githubActions: true, ci: true, loopbackOrigin: true, dbLoopback: true, dbNameE2e: true, privacySecretPresent: true,
    });
    r.preflight = preflight;

    const idByRef = async (ref: string) => {
      await page.goto(`${BASE}/admin/inquiries?q=${encodeURIComponent(ref)}`);
      await expect(page.locator('.inq-list > .adm-card')).toBeVisible();
      const row = page.locator('.inq-list tbody tr.row').filter({ has: page.locator(`a:has-text("${ref}")`) });
      await expect(row).toHaveCount(1);
      const href = await row.locator('a').first().getAttribute('href');
      expect(href).toMatch(/\/admin\/inquiries\//);
      return href!.split('/').pop()!;
    };
    const tag = `m3t21-anon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const refA = await createSyntheticInquiry(page, tag);
    const tagB = `m3t21-anon-ctl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const refB = await createSyntheticInquiry(page, tagB);
    const emailA = `qa-${tag}@acme-test.com`;
    const emailB = `qa-${tagB}@acme-test.com`;
    const idA = await idByRef(refA);
    const idB = await idByRef(refB);

    const origin = { Origin: BASE, 'Content-Type': 'application/json' };
    const exportResp = await ctx.request.post(`${BASE}/api/admin/privacy/export`, { headers: origin, data: { email: emailA } });
    expect(exportResp.status(), 'privacy/export 目标范围须 200').toBe(200);
    const exp = (await exportResp.json()) as {
      contacts: Array<{ email: string }>;
      inquiries: Array<{ ref: string; logoUploads: unknown[] }>;
      quoteLists: unknown[]; samples: unknown[];
    };
    expect(exp.contacts).toHaveLength(1);
    expect(exp.contacts[0].email.toLowerCase()).toBe(emailA.toLowerCase());
    expect(exp.inquiries.filter((i) => i.ref === refA)).toHaveLength(1);
    expect(exp.inquiries, '同一 normalizedEmail 范围不得有其它询盘').toHaveLength(1);
    expect(exp.quoteLists).toHaveLength(0);
    expect(exp.samples).toHaveLength(0);
    expect(exp.inquiries[0].logoUploads).toHaveLength(0);

    const detailAResp = await ctx.request.get(`${BASE}/api/admin/inquiries/${idA}`);
    expect(detailAResp.status(), '目标详情须 200').toBe(200);
    const detailA = (await detailAResp.json()) as { ref: string; contact: { email: string }; logoUploadId: string | null; anonymizedAt: string | null };
    expect(detailA.ref).toBe(refA);
    expect(detailA.contact.email.toLowerCase()).toBe(emailA.toLowerCase());
    expect(detailA.logoUploadId).toBeNull();
    expect(detailA.anonymizedAt).toBeNull();

    const exportBResp = await ctx.request.post(`${BASE}/api/admin/privacy/export`, { headers: origin, data: { email: emailB } });
    expect(exportBResp.status(), 'control export 须 200').toBe(200);
    const expB = (await exportBResp.json()) as { inquiries: Array<{ ref: string }> };
    expect(expB.inquiries.map((i) => i.ref)).toEqual([refB]);
    const detailBResp = await ctx.request.get(`${BASE}/api/admin/inquiries/${idB}`);
    expect(detailBResp.status(), 'control 详情须 200').toBe(200);
    const detailB = (await detailBResp.json()) as { contact: { email: string }; anonymizedAt: string | null };
    expect(detailB.anonymizedAt).toBeNull();
    expect(detailB.contact.email.toLowerCase()).toBe(emailB.toLowerCase());

    // 预置一条真实备注，供匿名化后核“内容已删除 / 只读 / [deleted]”。
    await page.goto(`${BASE}/admin/inquiries/${idA}`);
    const preText = `M3-T21 anon pre ${tag}`;
    await page.locator('.inq-detail textarea[aria-label="内部备注"]').fill(preText);
    const preNote = page.waitForResponse((res) => res.request().method() === 'POST'
      && new URL(res.url()).pathname === `/api/admin/inquiries/${idA}/notes`);
    await page.getByRole('button', { name: '添加备注' }).click();
    expect((await preNote).status()).toBe(201);

    // 单次删除：仅本次合成目标；counts 只作结果复核，不替代上面 export 前验。
    const delResp = await ctx.request.post(`${BASE}/api/admin/privacy/delete`, {
      headers: origin, data: { email: emailA, confirmEmail: emailA },
    });
    expect(delResp.status(), 'privacy/delete 须 200').toBe(200);
    const counts = (await delResp.json()) as { ok: boolean; contacts: number; inquiries: number; logos: number };
    expect(counts).toMatchObject({ ok: true, contacts: 1, inquiries: 1, logos: 0 });
    r.counts = { contacts: counts.contacts, inquiries: counts.inquiries, logos: counts.logos };

    const afterResp = await ctx.request.get(`${BASE}/api/admin/inquiries/${idA}`);
    expect(afterResp.status()).toBe(200);
    const after = (await afterResp.json()) as {
      ref: string; anonymizedAt: string | null; message: string | null; logoUploadId: string | null;
      contact: { name: string; email: string; company: string | null; phone: string | null };
      notes: Array<{ body: string }>;
    };
    expect(after.anonymizedAt, '目标须已匿名化').toBeTruthy();
    expect(after.ref).toBe(refA);
    expect(after.contact.name).toBe('[deleted]');
    expect(after.contact.email).toMatch(/^deleted\+[0-9a-f]{16}@invalid\.invalid$/);
    expect(after.contact.company).toBeNull();
    expect(after.contact.phone).toBeNull();
    expect(after.message).toBeNull();
    expect(after.notes.length).toBeGreaterThan(0);
    expect(after.notes.every((n) => n.body === '[deleted]')).toBe(true);
    expect(after.logoUploadId).toBeNull();

    const controlAfter = (await (await ctx.request.get(`${BASE}/api/admin/inquiries/${idB}`)).json()) as { contact: { email: string }; anonymizedAt: string | null };
    expect(controlAfter.anonymizedAt).toBeNull();
    expect(controlAfter.contact.email.toLowerCase()).toBe(emailB.toLowerCase());

    const listDefault = (await (await ctx.request.get(`${BASE}/api/admin/inquiries?q=${encodeURIComponent(refA)}`)).json()) as { items: Array<{ ref: string }> };
    expect(listDefault.items.filter((i) => i.ref === refA)).toHaveLength(0);
    const listAnon = (await (await ctx.request.get(`${BASE}/api/admin/inquiries?q=${encodeURIComponent(refA)}&includeAnonymized=true`)).json()) as { items: Array<{ ref: string; anonymizedAt?: string | null }> };
    expect(listAnon.items.filter((i) => i.ref === refA && i.anonymizedAt)).toHaveLength(1);

    // UI 只读：默认列表隐藏，anon=1 可见；详情无状态/负责人 select、无备注表单、无信任卡片。
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/admin/inquiries?q=${encodeURIComponent(refA)}&anon=1`);
    await expect(page.locator('.inq-list > .adm-card')).toBeVisible();
    const anonRow = page.locator('.inq-list tbody tr.row').filter({ has: page.locator(`a:has-text("${refA}")`) });
    await expect(anonRow).toHaveCount(1);
    await expect(anonRow.getByTestId('deleted-tag')).toBeVisible();
    const frames: string[] = [await shot('inquiry-visual-1440x900-anon-list.png')];
    await anonRow.locator('a').first().click();
    await expect(page.getByTestId('anon-notice')).toBeVisible();
    await expect(page.locator('.inq-detail').getByText('已匿名化').first()).toBeVisible();
    await expect(page.getByTestId('deleted-body').first()).toBeVisible();
    await expect(page.getByTestId('status-locked')).toBeVisible();
    await expect(page.locator('.inq-detail select[aria-label="状态"]')).toHaveCount(0);
    await expect(page.locator('.inq-detail select[aria-label="负责人"]')).toHaveCount(0);
    await expect(page.locator('.inq-detail textarea[aria-label="内部备注"]')).toHaveCount(0);
    await expect(page.getByTestId('trust-score')).toHaveCount(0);
    await expect(page.locator('.inq-detail').getByText('只读').first()).toBeVisible();
    await expect(page.locator('.inq-detail').getByText(preText)).toHaveCount(0);
    frames.push(await shot('inquiry-visual-1440x900-anon-detail.png'));

    const patchResp = await ctx.request.patch(`${BASE}/api/admin/inquiries/${idA}`, {
      headers: origin, data: { status: 'FOLLOWING' },
    });
    expect(patchResp.status(), '匿名化后改状态须 409').toBe(409);
    expect(((await patchResp.json()) as { error?: string }).error).toBe('anonymized');
    const notesResp = await ctx.request.post(`${BASE}/api/admin/inquiries/${idA}/notes`, {
      headers: origin, data: { body: 'should not persist' },
    });
    expect(notesResp.status(), '匿名化后备注须 409').toBe(409);
    expect(((await notesResp.json()) as { error?: string }).error).toBe('anonymized');

    const histResp = await ctx.request.get(`${BASE}/api/admin/inquiries/${idA}/history`);
    expect(histResp.status()).toBe(200);
    const histText = JSON.stringify(await histResp.json());
    expect(histText).not.toContain(emailA);
    expect((JSON.parse(histText) as { items?: unknown[] }).items?.length ?? 0).toBeGreaterThan(0);

    r.post = { piiDeleted: true, messageNull: true, notesDeleted: true, companyPhoneNull: true };
    r.list = { defaultHidden: true, includeShown: true };
    r.ui = { anonNotice: true, readonly: true, deletedBody: true, noSelects: true, noNoteForm: true, noTrust: true };
    r.api = { patch409: 'anonymized', notes409: 'anonymized' };
    r.history = { items: ((JSON.parse(histText) as { items?: unknown[] }).items?.length ?? 0), emailAbsent: true };
    r.controlUntouched = true;
    r.pre = { preNoteAdded: true, uniqueTarget: true, anonymizedAtNull: true, logoNull: true };
    r.frames = frames;
    finishReport();
  });

  test('三尺寸完整流程：列表→详情→状态/分配/备注写动作→刷新持久（1920/1440/390 真触控 tap，原生帧）', async ({ browser }) => {
    test.setTimeout(300_000);
    const r = report();
    const viewsOut: Array<Record<string, unknown>> = [];
    r.viewports = viewsOut;
    const views = [
      { width: 1920, height: 1080, label: '1920x1080', touch: false, status: 'FOLLOWING' as const },
      { width: 1440, height: 900, label: '1440x900', touch: false, status: 'QUOTED' as const },
      { width: 390, height: 844, label: '390x844', touch: true, status: 'WON' as const },
    ];
    for (const v of views) {
      await ctx.close();
      ctx = await contextFor(browser, adminState, test.info(), {
        viewport: { width: v.width, height: v.height },
        hasTouch: v.touch, isMobile: v.touch,
        videoSize: { width: v.width, height: v.height },
      });
      page = await ctx.newPage();
      const testInfo = test.info();
      const shot = async (name: string) => {
        const path = testInfo.outputPath(name);
        await page.screenshot({ path });
        expect(readFileSync(path).length).toBeGreaterThan(0);
        return name;
      };
      // 每个视口各自新建本视口自己的目标，避免复用同一记录导致“选当前值不发 PATCH”。
      const tag = `m3t21-flow-${v.label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ref = await createSyntheticInquiry(page, tag);
      await page.goto(`${BASE}/admin/inquiries?q=${encodeURIComponent(ref)}`);
      await expect(page.locator('.inq-list > .adm-card')).toBeVisible();
      const row = page.locator('.inq-list tbody tr.row').filter({ has: page.locator(`a:has-text("${ref}")`) });
      await expect(row).toHaveCount(1);
      const href = await row.locator('a').first().getAttribute('href');
      expect(href).toMatch(/\/admin\/inquiries\//);
      const id = href!.split('/').pop()!;
      const frames: string[] = [await shot(`inquiry-visual-${v.label}-01-list.png`)];

      if (v.touch) await row.locator('a').tap(); else await row.locator('a').first().click();
      await expect(page.locator('.inq-detail > .adm-crumb')).toBeVisible();
      frames.push(await shot(`inquiry-visual-${v.label}-02-detail.png`));

      const patchStatus = page.waitForResponse((res) => res.request().method() === 'PATCH'
        && new URL(res.url()).pathname === `/api/admin/inquiries/${id}`
        && (() => { try { return JSON.parse(res.request().postData() ?? '{}').status === v.status; } catch { return false; } })());
      await page.locator('.inq-detail select[aria-label="状态"]').selectOption(v.status);
      const statusResp = await patchStatus;
      expect(statusResp.status()).toBe(200);
      expect(((await statusResp.json()) as { status?: string }).status).toBe(v.status);
      await expect(page.getByTestId('status-badge')).toHaveText(STATUS_LABEL[v.status]);

      const assignSel = page.locator('.inq-detail select[aria-label="负责人"]');
      const users = ((await (await ctx.request.get(`${BASE}/api/admin/users`)).json()) as { items: Array<{ id: string; role: string }> }).items
        .filter((u) => u.role !== 'EDITOR');
      const optionValues = await assignSel.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      const current = await assignSel.inputValue();
      const target = users.map((u) => u.id).find((uid) => uid !== current && optionValues.includes(uid));
      expect(target, '必须有不同于当前值的合法非 EDITOR 负责人').toBeTruthy();
      const patchAssign = page.waitForResponse((res) => res.request().method() === 'PATCH'
        && new URL(res.url()).pathname === `/api/admin/inquiries/${id}`
        && (() => { try { return JSON.parse(res.request().postData() ?? '{}').assigneeId === target; } catch { return false; } })());
      await assignSel.selectOption(target!);
      const assignResp = await patchAssign;
      expect(assignResp.status()).toBe(200);
      expect(((await assignResp.json()) as { assigneeId?: string | null }).assigneeId).toBe(target);
      frames.push(await shot(`inquiry-visual-${v.label}-03-action.png`));

      const noteText = `M3-T21 flow ${v.label} ${tag}`;
      await page.locator('.inq-detail textarea[aria-label="内部备注"]').fill(noteText);
      const postNote = page.waitForResponse((res) => res.request().method() === 'POST'
        && new URL(res.url()).pathname === `/api/admin/inquiries/${id}/notes`
        && (() => { try { return JSON.parse(res.request().postData() ?? '{}').body === noteText; } catch { return false; } })());
      if (v.touch) await page.getByRole('button', { name: '添加备注' }).tap();
      else await page.getByRole('button', { name: '添加备注' }).click();
      expect((await postNote).status()).toBe(201);
      await page.locator('.inq-detail section', { hasText: '内部备注' }).scrollIntoViewIfNeeded();
      await expect(page.locator('.inq-detail').getByText(noteText)).toBeVisible();
      frames.push(await shot(`inquiry-visual-${v.label}-04-note.png`));

      const reloadGet = page.waitForResponse((res) => res.request().method() === 'GET'
        && new URL(res.url()).pathname === `/api/admin/inquiries/${id}`);
      await page.reload();
      const reloadResp = await reloadGet;
      expect(reloadResp.status()).toBe(200);
      expect(((await reloadResp.json()) as { ref?: string }).ref).toBe(ref);
      await expect(page.getByTestId('status-badge')).toHaveText(STATUS_LABEL[v.status]);
      await expect(page.locator('.inq-detail select[aria-label="负责人"]')).toHaveValue(target!);
      await expect(page.locator('.inq-detail').getByText(noteText)).toBeVisible();
      const persistedList = page.waitForResponse((res) => res.request().method() === 'GET'
        && new URL(res.url()).pathname === '/api/admin/inquiries'
        && new URL(res.url()).searchParams.get('q') === ref);
      await page.goto(`${BASE}/admin/inquiries?q=${encodeURIComponent(ref)}`);
      expect((await persistedList).status()).toBe(200);
      await expect(page.locator('.inq-list tbody tr.row').filter({ has: page.locator(`a:has-text("${ref}")`) })).toHaveCount(1);
      frames.push(await shot(`inquiry-visual-${v.label}-05-persisted.png`));

      viewsOut.push({ label: v.label, touch: v.touch, status: v.status, statusPatch200: true,
        assigneePatch200: true, notePost201: true, persistedAfterReload: true, frames, video: 'native' });
    }
    finishReport();
  });
});
