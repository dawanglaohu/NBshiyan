import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from './fixtures';

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
