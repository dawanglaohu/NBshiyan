import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { authenticator } from 'otplib';
import type { TestInfo } from '@playwright/test';
import { test, expect, type Page } from './fixtures';

// trace / channel / launchOptions 会新开 worker，Playwright 1.64 不允许写在 describe 里。
// CI 不设 E2E_BROWSER_CHANNEL，仍用配置里的自带 Chromium。本机 Ubuntu 20.04 设为 chrome。
test.use({
  trace: 'on',
  ...(process.env.E2E_BROWSER_CHANNEL === 'chrome'
    ? { channel: 'chrome' as const, launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] } }
    : {}),
});

/**
 * M1-T1 主冒烟：真实构建后的服务上验 11 节 8 个核心 token 与既有路径。
 * 只拦外部服务（fixtures 的 auto route），本应用的页面/接口请求一律真实发出。
 * 不用 localStorage 写同意（17 节禁止伪造同意），一律点可见控件。
 */

/** 11 节 Tokens 表的 8 个核心取值（docs/PackJoyU-开发文档/02-设计/11-UI.md:98-161 与组件表 169/170 行） */
const PJ = {
  bg: 'rgb(255, 255, 255)',        // --pj-bg:#ffffff
  fg: 'rgb(0, 0, 0)',              // --pj-fg:#000000
  accent: 'rgb(180, 87, 0)',       // --pj-accent:#b45700（焦点颜色就是它）
  borderWidth: '2px',              // --pj-border-width:2px
  radius: '0px',                   // --pj-radius:0px
  bodySize: '16px',                // --pj-body-size:16px
  bodyLine: '24px',                // --pj-body-line:24px
  focusWidth: '2px',               // --pj-focus-width:2px
  focusOffset: '2px'               // --pj-focus-offset:2px
} as const;

async function css(page: Page, selector: string, prop: string) {
  return page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p).trim(), prop);
}

/** 让某个可见控件拿到 :focus-visible（键盘 Tab 才算），返回它的 computed outline */
async function keyboardFocusOutline(page: Page, selector: string) {
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate((sel) => {
      const el = document.activeElement as HTMLElement | null;
      return Boolean(el && el.matches(sel) && el.matches(':focus-visible'));
    }, selector);
    if (!hit) continue;
    return page.evaluate(() => {
      const s = getComputedStyle(document.activeElement as Element);
      return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor, offset: s.outlineOffset };
    });
  }
  throw new Error(`Tab 120 次仍未让 ${selector} 拿到 :focus-visible：焦点环断言不能落空`);
}

/**
 * 服务进程 stdout 落盘在 .next/standalone-server.log（路径与 playwright.config.ts 的 SERVER_LOG 一致）。
 * 这里只读不写，也不 import 配置文件——导入会让整份 config 再执行一次。
 */
const SERVER_LOG = path.join('.next', 'standalone-server.log');
function rumLogLines(): string[] {
  if (!existsSync(SERVER_LOG)) return [];
  return readFileSync(SERVER_LOG, 'utf8').split('\n').filter((l) => l.startsWith('{"type":"rum"'));
}

/** 真实点一次 Cookie 同意（不写 localStorage），并等横幅消失 */
async function acceptAnalytics(page: Page) {
  const bar = page.getByRole('region', { name: 'Cookie consent' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Accept all' }).click();
  await expect(bar).toBeHidden();
}

test('8 个核心 token 在首页与产品页的 computed style 等于 11 节取值；目录走 SSR，不额外请求 /api/models', async ({ page, request }) => {
  // 产品页不应自己再发一次目录请求：记录页面实际发出的所有请求
  const pageRequests: string[] = [];
  page.on('request', (r) => pageRequests.push(`${r.method()} ${new URL(r.url()).pathname}`));

  await page.goto('/en');
  await expect(page).toHaveURL(/\/en$/);
  // 真实 CSS 到位才断言（styles 里 --pj-bg 是唯一视觉源）
  const declared = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pj-bg').trim());
  expect(declared).toBe('#ffffff');

  // ① 背景 ② 前景 ⑥ 基础字号 ⑦ 正文行高
  expect(await css(page, 'body', 'background-color')).toBe(PJ.bg);
  expect(await css(page, 'body', 'color')).toBe(PJ.fg);
  expect(await css(page, 'body', 'font-size')).toBe(PJ.bodySize);
  expect(await css(page, 'body', 'line-height')).toBe(PJ.bodyLine);
  // 首页首屏不能再有暖色渐变/阴影（11 节 Avoid）
  expect(await css(page, '.hero', 'background-image')).toBe('none');
  expect(await css(page, '.hero', 'background-color')).toBe(PJ.bg);

  // ③ 强调色 token 本值 + ④ 边界宽度 + ⑤ 圆角（主控件）
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pj-accent').trim())).toBe('#b45700');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pj-radius').trim())).toBe('0px');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pj-border-width').trim())).toBe('2px');
  expect(await css(page, '.hero .btn', 'border-top-width')).toBe(PJ.borderWidth);
  expect(await css(page, '.hero .btn', 'border-radius')).toBe(PJ.radius);
  expect(await css(page, '.hero .btn', 'box-shadow')).toBe('none');
  // 首页产品入口卡同样是 2px 黑边、0 圆角
  expect(await css(page, '.entry a', 'border-top-width')).toBe(PJ.borderWidth);
  expect(await css(page, '.entry a', 'border-radius')).toBe(PJ.radius);
  // 礼盒/酒盒入口带 theme-premium，黑边落在深底上看不见，边和焦点环用 --pj-bg
  expect(await css(page, '.entry a.theme-premium', 'border-top-width')).toBe(PJ.borderWidth);
  expect(await css(page, '.entry a.theme-premium', 'border-top-color')).toBe(PJ.bg);
  expect(await css(page, '.entry a.theme-premium', 'border-radius')).toBe(PJ.radius);
  expect(await css(page, '.entry a.theme-premium', 'box-shadow')).toBe('none');

  // ⑧ 焦点颜色：键盘聚焦后 outline 为 2px 强调色 + 2px offset
  const outline = await keyboardFocusOutline(page, '.btn');
  expect(outline.color).toBe(PJ.accent);
  expect(outline.width).toBe(PJ.focusWidth);
  expect(outline.style).toBe('solid');
  expect(outline.offset).toBe(PJ.focusOffset);

  // 从 header 产品链接进入产品页，点的是可见控件。App Router 的客户端跳转不产生 document 响应，
  // 等 navigation response 会超时；用 URL 变化判定跳转完成。
  const productLink = page.locator('header.site nav.nav-desktop a[href="/en/products"]');
  await expect(productLink).toBeVisible();
  await productLink.click();
  await expect(page).toHaveURL(/\/en\/products$/);

  // 目录由 loadCatalog(listPublishedModels) 在服务端渲染：产品卡必须出现在该路由的首字节 HTML 里。
  // 客户端另拉 /api/models 填充的实现会让下面的 0 次请求断言失败。
  const ssr = await request.get('/en/products');
  expect(ssr.status()).toBe(200);
  const html = await ssr.text();
  expect(html).toContain('Our products in 3D');
  // 按 <article ... class="card 计数：产品卡有宽窄两种 class 组合，写死 class="card" 只能数到 10 张
  expect((html.match(/<article[^>]*class="card/g) ?? []).length).toBeGreaterThanOrEqual(12);
  const cards = page.locator('main.container article.card');
  await expect(cards.first()).toBeVisible();
  const cardCount = await cards.count();
  expect(cardCount).toBeGreaterThan(0);
  expect(await cards.first().locator('h2').innerText()).not.toHaveLength(0);
  // 进入产品页后，正文 token 与卡片的边宽、圆角、阴影仍等于 11 节
  expect(await css(page, 'body', 'background-color')).toBe(PJ.bg);
  expect(await css(page, 'body', 'color')).toBe(PJ.fg);
  expect(await css(page, 'body', 'font-size')).toBe(PJ.bodySize);
  expect(await css(page, 'body', 'line-height')).toBe(PJ.bodyLine);
  expect(await css(page, 'article.card:not(.theme-premium)', 'border-top-width')).toBe(PJ.borderWidth);
  expect(await css(page, 'article.card:not(.theme-premium)', 'border-top-color')).toBe(PJ.fg);
  expect(await css(page, 'article.card:not(.theme-premium)', 'border-radius')).toBe(PJ.radius);
  expect(await css(page, 'article.card:not(.theme-premium)', 'box-shadow')).toBe('none');
  expect(await css(page, 'article.card.theme-premium', 'border-top-width')).toBe(PJ.borderWidth);
  expect(await css(page, 'article.card.theme-premium', 'border-top-color')).toBe(PJ.bg);
  expect(await css(page, 'article.card.theme-premium', 'border-radius')).toBe(PJ.radius);
  expect(await css(page, 'article.card.theme-premium', 'box-shadow')).toBe('none');
  // 产品页自己有 0 次 /api/models 请求（目录走 SSR；3D 模型走 /api/models/<id>/<variant>）
  expect(pageRequests.filter((r) => r === 'GET /api/models')).toEqual([]);

});

/**
 * GET /api/models 的既有信封：200 + items 数组 + 60 秒缓存。
 * 该端点查库：服务进程连的是 DATABASE_URL 指向的测试库，e2e 跑之前库必须已就位（CI 用 postgres service）。
 * 数据库缺失时该断言直接红，不按环境跳过——跳过会让「200」这条验收在 CI 之外无人核过。
 */
test('GET /api/models 兼容信封：200 + items 数组 + 60 秒缓存', async ({ request }) => {
  const api = await request.get('/api/models');
  expect(api.status()).toBe(200);
  expect(api.headers()['cache-control']).toContain('max-age=60');
  const body = (await api.json()) as { items: unknown };
  expect(Array.isArray(body.items)).toBe(true);
});

test('真实首页 WebVitals 在同意后 POST /api/rum 返回 204，同次服务的 stdout 只留白名单字段', async ({ page }) => {
  // navigator.sendBeacon 的 Blob 请求体在 Playwright 侧读不到（postData 与 postDataBuffer 都是 null），
  // 所以载荷内容由服务端 stdout 核对：/api/rum 在写日志之前按 RumBody 白名单解析。
  const hits: { method: string; path: string; status: number }[] = [];
  page.on('response', (res) => {
    const u = new URL(res.url());
    if (u.pathname !== '/api/rum') return;
    hits.push({ method: res.request().method(), path: u.pathname, status: res.status() });
  });
  const logBefore = rumLogLines().length;

  await page.goto('/en');
  // 真实点可见的同意控件（不写 localStorage）
  await acceptAnalytics(page);

  // web-vitals 只在文档卸载时把缓冲区里的指标发出去；App Router 的站内跳转不卸载文档，
  // 所以这里走一次真实的浏览器导航，让 pagehide/visibilitychange 自然发生。
  await page.goto('/en/products');
  await expect(page).toHaveURL(/\/en\/products$/);

  await expect.poll(() => hits.length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(hits[0].method).toBe('POST');
  expect(hits[0].path).toBe('/api/rum');
  expect(hits[0].status).toBe(204);
  // 同一页面不重复上报同一个 metric id（web-vitals 只报一次）
  expect(hits.filter((h) => h.status !== 204)).toEqual([]);

  // 同一次服务运行的 stdout：新增的每一行都得是白名单字段，且不带任何个人信息
  const ALLOWED = ['type', 'name', 'value', 'rating', 'id', 'path', 'nav', 'device'];
  await expect.poll(() => rumLogLines().length, { timeout: 20_000 }).toBeGreaterThan(logBefore);
  const fresh = rumLogLines().slice(logBefore);
  for (const line of fresh) {
    expect(line).not.toContain('@');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).filter((k) => !ALLOWED.includes(k))).toEqual([]);
    expect(parsed.type).toBe('rum');
    expect(typeof parsed.path).toBe('string');
    expect((parsed.path as string).startsWith('/')).toBe(true);
  }
});

/**
 * 深色区（礼盒/酒盒 band 与强调底 band）上按钮是白底黑字，强调色 outline 落在深底上看不见，
 * 焦点环必须反白：--pj-bg 的白色 2px + 2px offset。浅色区仍用强调色，见上面 test ① 的 ⑧。
 */
test('深色区按钮的键盘焦点环反白为白色 2px + 2px offset，浅色区仍是强调色', async ({ page }) => {
  await page.goto('/en');

  for (const selector of ['.premium-band .btn', '.premium-band .btn.ghost', '.cta-band .btn']) {
    const outline = await keyboardFocusOutline(page, selector);
    expect(outline.color, selector).toBe(PJ.bg);
    expect(outline.width, selector).toBe(PJ.focusWidth);
    expect(outline.style, selector).toBe('solid');
    expect(outline.offset, selector).toBe(PJ.focusOffset);
  }

  // 浅色区对照：同一套 offset，颜色回到强调色
  const light = await keyboardFocusOutline(page, '.hero .btn');
  expect(light.color).toBe(PJ.accent);
  expect(light.offset).toBe(PJ.focusOffset);
});

test('RUM 端点拒绝带个人信息的载荷，脱敏白名单由同一 route 强制', async ({ request }) => {
  // 脱敏走真实 HTTP：额外字段在写日志之前被 400 拒绝
  const withEmail = await request.post('/api/rum', {
    data: { name: 'LCP', value: 1200, rating: 'good', id: 'smoke-1', path: '/en', email: 'someone@example.com' },
    headers: { 'content-type': 'application/json', origin: test.info().project.use.baseURL as string }
  });
  expect(withEmail.status()).toBe(400);

  const ok = await request.post('/api/rum', {
    data: { name: 'LCP', value: 1200, rating: 'good', id: 'smoke-2', path: '/en', nav: 'navigate', device: 'desktop' },
    headers: { 'content-type': 'application/json', origin: test.info().project.use.baseURL as string }
  });
  expect(ok.status()).toBe(204);
  expect((await ok.text())).toBe('');
});

/**
 * 同一条真实 standalone 服务上的主冒烟。
 * fixtures 只拦截非本机外部主机；这里不调用 page.route，不写 localStorage / sessionStorage。
 * 后台没有登录页，会话只来自 Auth.js credentials 的 Set-Cookie。密度只量已有工作面。
 */
const SMOKE_ORIGIN = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
const SMOKE_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const SMOKE_PASSWORD = 'e2e-only-Passw0rd!';
const PROBE_JS = readFileSync(path.join('docs', 'PackJoyU-开发文档', '_run', 'density_probe.js'), 'utf8');
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
] as const;

type Hit = { method: string; path: string; status: number };
type ProbeSlim = {
  surface: string;
  type: 'work' | 'form';
  viewport: string;
  pass: boolean;
  D1: string; D2: string; D3: string; D4: string; D5: string; D6: string;
  overflow: string;
  fill: number;
  leftGap: number;
  note?: string;
};

test.describe('standalone 主冒烟', () => {
  test('首页导航、目录、同意、RUM 与已有后台工作面', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const hits: Hit[] = [];
    page.on('response', (res) => {
      const url = new URL(res.url());
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return;
      hits.push({ method: res.request().method(), path: url.pathname, status: res.status() });
    });

    await page.goto('/en');
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.locator('header.site nav.nav-desktop a[href="/en/products"]')).toBeVisible();
    await shot(page, testInfo, '00-home.png');

    const bar = page.getByRole('region', { name: 'Cookie consent' });
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: 'Accept all' }).click();
    await expect(bar).toBeHidden();

    await page.locator('header.site nav.nav-desktop a[href="/en/products"]').click();
    await expect(page).toHaveURL(/\/en\/products$/);
    await expect(page.locator('main.container article.card').first()).toBeVisible();
    expect(hits.filter((h) => h.method === 'GET' && h.path === '/api/models')).toEqual([]);
    await shot(page, testInfo, '01-catalog.png');
    // 站内点击不卸载文档，Web Vitals 要等一次整页导航才发出。
    await page.goto('/en');
    await expect.poll(() => hits.some((h) => h.method === 'POST' && h.path === '/api/rum' && h.status === 204), { timeout: 20_000 }).toBe(true);

    await loginSmokeAdmin(page);
    await page.goto('/admin/inquiries');
    await expect(page.getByRole('heading', { level: 1, name: /询盘管理/ })).toBeVisible();
    await expect.poll(() => hits.some((h) => h.method === 'GET' && h.path === '/api/admin/inquiries' && h.status === 200), { timeout: 20_000 }).toBe(true);
    await shot(page, testInfo, '02-admin-inquiries.png');

    const nav = page.getByRole('navigation', { name: '后台导航' });
    for (const label of ['样品申请', '内容', '数据看板']) {
      await expect(nav.getByRole('link', { name: label })).toHaveAttribute('aria-disabled', 'true');
    }
    const closed = await page.request.get('/admin/mail/unassigned');
    expect(closed.status(), '未归类邮件入口仍关闭').toBe(404);
    for (const missing of ['/admin/samples', '/admin/content', '/admin/stats']) {
      expect((await page.request.get(missing)).status(), missing).toBe(404);
    }

    const probes: ProbeSlim[] = [];
    probes.push(...await measure(page, '询盘', 'work', /询盘管理/));
    await nav.getByRole('link', { name: '账号权限' }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    probes.push(...await measure(page, '账号权限', 'work', '账号权限'));
    await nav.getByRole('link', { name: '产品规格' }).click();
    await expect(page).toHaveURL(/\/admin\/specs$/);
    probes.push(...await measure(page, '产品规格', 'work', '产品规格'));
    await page.getByRole('link', { name: 'custom corrugated boxes' }).click();
    await expect(page).toHaveURL(/\/admin\/specs\/corrugated-boxes$/);
    probes.push(...await measure(page, '规格编辑', 'form', /产品规格/));
    await nav.getByRole('link', { name: '站点设置' }).click();
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shot(page, testInfo, '03-admin-settings.png');
    probes.push(...await measure(page, '站点设置', 'form', { level: 1 }));
    await page.getByRole('navigation', { name: '站点设置分区' }).getByRole('link', { name: '组织信息' }).click();
    await expect(page).toHaveURL(/\/admin\/settings\?section=org$/);
    probes.push(...await measure(page, '组织信息', 'form', { level: 1 }));
    await nav.getByRole('link', { name: '3D 模型' }).click();
    await expect(page).toHaveURL(/\/admin\/models\/new$/);
    probes.push(...await measure(page, '3D 模型', 'form', '上传新模型'));

    const densityFailed = probes.filter((p) => !p.pass);
    const report = {
      transport: 'standalone',
      origin: SMOKE_ORIGIN,
      notClaimed: ['/admin/samples', '/admin/content', '/admin/stats', '/admin/mail/unassigned'],
      requests: hits.filter((h) => h.path.startsWith('/api/') || h.path.startsWith('/admin') || h.path.startsWith('/en')),
      probes,
      densityFailed,
    };
    const reportPath = testInfo.outputPath('standalone-smoke.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach('standalone-smoke', { path: reportPath, contentType: 'application/json' });
    // 十四次测量都要做完，并且 D1–D6 与 overflow 全部通过。阈值仍在 density_probe.js。
    expect(probes).toHaveLength(14);
    expect(densityFailed).toEqual([]);
  });
});

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const target = testInfo.outputPath(name);
  await page.screenshot({ path: target, animations: 'disabled' });
  const dir = process.env.STANDALONE_SMOKE_FRAMES;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name), animations: 'disabled' });
}

async function loginSmokeAdmin(page: Page) {
  const email = `r3-standalone-${Date.now()}@example.test`;
  execFileSync('node', ['scripts/create-admin.mjs'], {
    stdio: 'pipe',
    env: {
      ...process.env,
      ADMIN_SEED_EMAIL: email,
      ADMIN_SEED_PASSWORD: SMOKE_PASSWORD,
      ADMIN_SEED_NAME: 'R3 Standalone',
      ADMIN_SEED_ROLE: 'ADMIN',
      ADMIN_SEED_TOTP_SECRET: SMOKE_TOTP,
    },
  });
  const csrf = (await (await page.request.get('/api/auth/csrf')).json()).csrfToken as string;
  const ok = await page.request.post('/api/auth/callback/credentials', {
    headers: { Origin: SMOKE_ORIGIN },
    form: { csrfToken: csrf, email, password: SMOKE_PASSWORD, totp: authenticator.generate(SMOKE_TOTP) },
    maxRedirects: 0,
  });
  expect(ok.headers().location ?? '').not.toContain('error');
}

async function measure(page: Page, surface: string, type: 'work' | 'form', heading: string | RegExp | { level: 1 }): Promise<ProbeSlim[]> {
  const out: ProbeSlim[] = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const title = typeof heading === 'string' || heading instanceof RegExp
      ? page.getByRole('heading', { level: 1, name: heading })
      : page.getByRole('heading', heading);
    await expect(title).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => page.locator('main.adm-main').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(800);
    const raw = await page.evaluate(({ src, opts }) => {
      (0, eval)(src);
      const fn = (globalThis as { densityProbe?: (o: unknown) => {
        fill: number; leftGap: number;
        verdict: { pass: boolean; D1: string; D2: string; D3: string; D4: string; D5: string; D6: string; overflow: string; note?: string };
      } }).densityProbe;
      if (!fn) throw new Error('densityProbe missing');
      return fn(opts);
    }, {
      src: PROBE_JS,
      opts: { type, density: 7, gutter: 16, gap: 16, pad: 16, main: 'main.adm-main' },
    });
    out.push({
      surface, type, viewport: `${viewport.width}x${viewport.height}`, pass: raw.verdict.pass,
      D1: raw.verdict.D1, D2: raw.verdict.D2, D3: raw.verdict.D3, D4: raw.verdict.D4, D5: raw.verdict.D5, D6: raw.verdict.D6,
      overflow: raw.verdict.overflow, fill: raw.fill, leftGap: raw.leftGap, note: raw.verdict.note,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  return out;
}

/**
 * 1920 上 1240px 上限还在时，首页外壳 max-width 是 1240px，本测试失败。
 * 修复后 ≥1489px 的外壳等于视口减去两侧 24px。1440 仍是居中的 1240px 上限。
 * 铺满宽度下入口卡片固定 6 列，单卡不窄于 190px。不登录后台。
 * /about 未发布时是 404，同一条 .sx 上限改在 /solutions 与 /factory 上量。
 */
const HOME_FILL_MIN = 1489;
const HOME_CARD_MIN = 190;

function near(actual: number, expected: number, tolerance = 1) {
  expect(Math.abs(actual - expected), `expected ${actual} within ${tolerance} of ${expected}`).toBeLessThanOrEqual(tolerance);
}

async function shellBox(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const padL = parseFloat(style.paddingLeft);
    const padR = parseFloat(style.paddingRight);
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      contentWidth: rect.width - padL - padR,
      padL,
      padR,
      left: rect.left,
      maxWidth: style.maxWidth,
    };
  });
}

async function entryRow(page: Page) {
  return page.locator('.entry').evaluate((grid) => {
    const cards = [...grid.querySelectorAll<HTMLElement>(':scope > a')];
    const firstTop = Math.round(cards[0].getBoundingClientRect().top);
    const columns = cards.filter((el) => Math.round(el.getBoundingClientRect().top) === firstTop).length;
    return {
      columns,
      widths: cards.map((el) => el.getBoundingClientRect().width),
      pad: parseFloat(getComputedStyle(cards[0]).paddingTop),
    };
  });
}

async function expectPublicContainerCap(page: Page) {
  const box = await page.locator('main.container').evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      maxWidth: style.maxWidth,
      width: el.getBoundingClientRect().width,
      token: getComputedStyle(document.documentElement).getPropertyValue('--container').trim(),
    };
  });
  expect(box.token).toBe('1240px');
  expect(box.maxWidth).toBe('1240px');
  near(box.width, 1240);
}

async function expectPublicSxCap(page: Page) {
  const box = await page.locator('main .sx').first().evaluate((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      maxWidth: style.maxWidth,
      contentWidth: rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      token: getComputedStyle(document.documentElement).getPropertyValue('--container').trim(),
    };
  });
  expect(box.token).toBe('1240px');
  expect(box.maxWidth).toBe('1240px');
  near(box.contentWidth, 1240);
}

test('首页外壳铺满 publicBrand 边距，产品页与 .sx 公开页仍是 1240 上限', async ({ page }) => {
  test.setTimeout(180_000);
  const desktop = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
  ] as const;
  const shells = ['.hero > .container', '[data-testid="brand-scene"]', 'section.container:has(.entry)'];
  const columns: Record<number, number> = {};

  await page.setViewportSize(desktop[0]);
  await page.goto('/en');
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.locator('.hero h1')).toBeVisible();

  for (const viewport of desktop) {
    await page.setViewportSize(viewport);
    await expect(page.locator('.hero h1')).toBeVisible();
    for (const selector of shells) {
      const box = await shellBox(page, selector);
      expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
      if (viewport.width >= HOME_FILL_MIN) {
        expect(box.maxWidth, selector).toBe('none');
        expect(box.contentWidth, selector).toBeGreaterThan(1240);
        near(box.contentWidth, box.clientWidth - 48);
        near(box.padL, 24);
        near(box.padR, 24);
        near(box.left, 0);
      } else {
        expect(box.maxWidth, selector).toBe('1240px');
        near(box.contentWidth + box.padL + box.padR, 1240);
        expect(box.contentWidth, selector).toBeLessThanOrEqual(1240);
        near(box.padL, 20);
        near(box.padR, 20);
        near(box.left, (box.clientWidth - 1240) / 2);
      }
    }
    const copy = await page.locator('.hero').evaluate((hero) => {
      const h1 = hero.querySelector('h1') as HTMLElement;
      const paragraph = hero.querySelector('p') as HTMLElement;
      const h1Style = getComputedStyle(h1);
      const pStyle = getComputedStyle(paragraph);
      return {
        h1: h1.getBoundingClientRect().width,
        h1Max: parseFloat(h1Style.maxWidth),
        p: paragraph.getBoundingClientRect().width,
        pMax: parseFloat(pStyle.maxWidth),
      };
    });
    expect(copy.h1Max).toBeLessThanOrEqual(960);
    expect(copy.h1).toBeLessThanOrEqual(960);
    expect(copy.pMax).toBeLessThanOrEqual(720);
    expect(copy.p).toBeLessThanOrEqual(720);
    near(copy.pMax, 640);
    if (viewport.width === 1440) {
      expect(copy.h1).toBeLessThanOrEqual(638);
      expect(copy.p).toBeLessThanOrEqual(638);
    }
    const row = await entryRow(page);
    columns[viewport.width] = row.columns;
    expect(row.columns).toBe(6);
    if (viewport.width >= HOME_FILL_MIN) {
      for (const width of row.widths) expect(width, 'entry card').toBeGreaterThanOrEqual(HOME_CARD_MIN);
    } else {
      for (const width of row.widths) near(width, HOME_CARD_MIN);
    }
    near(row.pad, 12);
    expect(await css(page, 'section.block', 'padding-top')).toBe('64px');
    expect(await css(page, ':root', '--pj-admin-gutter')).toBe('16px');
  }

  expect(columns[1920]).toBe(6);
  expect(columns[1440]).toBe(6);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.locator('header.site nav.nav-desktop a[href="/en/products"]').click();
  await expect(page).toHaveURL(/\/en\/products$/);
  await expect(page.locator('main.container')).toBeVisible();
  await expectPublicContainerCap(page);

  await page.locator('header.site nav.nav-desktop a[href="/en/contact"]:not(.btn)').click();
  await expect(page).toHaveURL(/\/en\/contact$/);
  await expect(page.locator('main.container')).toBeVisible();
  await expectPublicContainerCap(page);

  // 窄屏从仍有页头的联系页点字标回首页。未发布关于页的 404 文档不含 header.site。
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('header.site a.logo').click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.locator('.hero h1')).toBeVisible();
  const phone = await shellBox(page, '.hero > .container');
  expect(phone.maxWidth).toBe('1240px');
  near(phone.padL, 20);
  near(phone.padR, 20);
  expect(phone.scrollWidth).toBeLessThanOrEqual(phone.clientWidth + 1);
  const phoneRow = await entryRow(page);
  expect(phoneRow.columns).toBe(2);

  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const path of ['/en/solutions', '/en/factory']) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator('main .sx').first()).toBeVisible();
    await expectPublicSxCap(page);
  }

  const about = await page.goto('/en/about');
  if (about?.status() === 200) {
    await expect(page.locator('main .sx').first()).toBeVisible();
    await expectPublicSxCap(page);
  } else {
    expect(about?.status()).toBe(404);
  }
});
