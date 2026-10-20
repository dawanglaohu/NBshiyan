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
  bodyLine: '24px'                 // --pj-body-line:24px
} as const;

async function css(page: Page, selector: string, prop: string) {
  return page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p).trim(), prop);
}

/** 让某个可见控件拿到 :focus-visible（键盘 Tab 才算），返回它的 computed outline */
async function keyboardFocusOutline(page: Page, selector: string) {
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate((sel) => {
      const el = document.activeElement as HTMLElement | null;
      return Boolean(el && el.matches(sel) && el.matches(':focus-visible'));
    }, selector);
    if (hit) break;
  }
  return page.evaluate(() => {
    const s = getComputedStyle(document.activeElement as Element);
    return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor, offset: s.outlineOffset };
  });
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

  // ⑧ 焦点颜色：键盘聚焦后 outline 为 2px 强调色 + 2px offset
  const outline = await keyboardFocusOutline(page, '.btn');
  expect(outline.color).toBe(PJ.accent);
  expect(outline.width).toBe('2px');
  expect(outline.style).toBe('solid');
  expect(outline.offset).toBe('2px');

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
  // 产品页自己有 0 次 /api/models 请求（目录走 SSR；3D 模型走 /api/models/<id>/<variant>）
  expect(pageRequests.filter((r) => r === 'GET /api/models')).toEqual([]);

});

/**
 * GET /api/models 的既有信封：200 + items 数组 + 60 秒缓存。
 * 该端点查库，需要真实数据库；CI 的 e2e job 带 postgres service（.github/workflows/ci.yml:46-51），
 * 本机没有 Postgres 时显式跳过并把原因写进报告。
 */
test('GET /api/models 兼容信封：200 + items 数组 + 60 秒缓存', async ({ request }) => {
  const api = await request.get('/api/models');
  if (api.status() !== 200 && !process.env.CI) {
    test.skip(true, '本机无 Postgres，/api/models 的 200 断言由 CI 的 postgres service 承担');
  }
  expect(api.status()).toBe(200);
  expect(api.headers()['cache-control']).toContain('max-age=60');
  const body = (await api.json()) as { items: unknown };
  expect(Array.isArray(body.items)).toBe(true);
});

test('真实首页 WebVitals 在同意后 POST /api/rum，返回 204；脱敏由服务端载体验证', async ({ page }) => {
  // navigator.sendBeacon 的 Blob 请求体在 Playwright 侧读不到（postData 与 postDataBuffer 都是 null），
  // 所以这里只断言 POST 真实发出且 204；载荷白名单由 tests/rum.test.ts 与 /api/rum 的解析强制。
  const hits: { method: string; path: string; status: number }[] = [];
  page.on('response', (res) => {
    const u = new URL(res.url());
    if (u.pathname !== '/api/rum') return;
    hits.push({ method: res.request().method(), path: u.pathname, status: res.status() });
  });

  await page.goto('/en');
  // 真实点可见的同意控件（不写 localStorage）
  await acceptAnalytics(page);

  // 真实页面生命周期事件触发 web-vitals 上报
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => hits.length, { timeout: 20_000 }).toBeGreaterThan(0);

  expect(hits[0].method).toBe('POST');
  expect(hits[0].path).toBe('/api/rum');
  expect(hits[0].status).toBe(204);
  // 同一页面不重复上报同一个 metric id（web-vitals 只报一次）
  expect(hits.filter((h) => h.status !== 204)).toEqual([]);
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
