import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Tawk.to 客服的同意门控（#185）。同意状态存在 localStorage `pj-consent`（{v:1, analytics, chat, ts}），不是 cookie。
 * 所有 tawk.to 请求都被 mock，不发真实外部请求：embed 脚本返回一个最小桩，其余直接 abort（fixtures 的 external 也会兜底拦截）。
 */
const TAWK_RE = /^https?:\/\/([a-z0-9-]+\.)*tawk\.to(\/|$)/i;
const STUB = `window.Tawk_API = window.Tawk_API || {}; window.__tawkStubLoaded = true;
  ['hideWidget','showWidget','maximize','setAttributes'].forEach(k => { window.Tawk_API[k] = window.Tawk_API[k] || function(a, cb){ if (typeof cb === 'function') cb(); }; });
  setTimeout(() => window.Tawk_API.onLoad && window.Tawk_API.onLoad(), 0);`;
const configured = Boolean(process.env.NEXT_PUBLIC_TAWK_PROPERTY_ID && process.env.NEXT_PUBLIC_TAWK_WIDGET_ID);

async function mockTawk(page: Page) {
  const hits: string[] = [];
  await page.route(TAWK_RE, (route) => {
    const url = route.request().url();
    hits.push(url);
    if (url.startsWith('https://embed.tawk.to/')) return route.fulfill({ contentType: 'text/javascript', body: STUB });
    return route.abort();
  });
  return hits;
}
async function presetConsent(page: Page, c: { analytics: boolean; chat: boolean } | null) {
  await page.addInitScript((v) => {
    if (v) localStorage.setItem('pj-consent', JSON.stringify({ v: 2, ...v, ts: Date.now() }));
    else localStorage.removeItem('pj-consent');
  }, c);
}
/** useTawk 在交互或空闲（6s + idle）后才加载；交互一下并留足时间，确认它确实没有加载 */
async function armAndWait(page: Page, ms = 3500) {
  await page.mouse.move(200, 200); await page.keyboard.press('Tab'); await page.mouse.wheel(0, 500);
  await page.waitForTimeout(ms);
}
async function expectNoTawk(page: Page, hits: string[]) {
  expect(hits).toEqual([]);
  await expect(page.locator('script#tawk-js, script[src*="tawk.to"]')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean((window as unknown as { Tawk_API?: unknown }).Tawk_API))).toBe(false);
}

test('同意前：没有任何 tawk.to 请求或脚本', async ({ page }) => {
  const hits = await mockTawk(page);
  await presetConsent(page, null);
  await page.goto('/en');
  await armAndWait(page);
  await expectNoTawk(page, hits);
});

test('chat=false（即使 analytics=true）：不加载 Tawk.to', async ({ page }) => {
  const hits = await mockTawk(page);
  await presetConsent(page, { analytics: true, chat: false });
  for (const p of ['/en', '/ru']) { await page.goto(p); await armAndWait(page, 2000); }
  await expectNoTawk(page, hits);
});

test('同意值格式（v2）：v1、缺 ts、格式错误按未同意处理；合法 v2 才加载', async ({ page }) => {
  const hits = await mockTawk(page);
  await page.goto('/en');
  const bad = [
    { v: 1, analytics: true, chat: true, ts: Date.now() },
    { v: 2, analytics: true, chat: true },
    { v: 2, analytics: true, chat: 'true', ts: Date.now() },
    { v: 3, analytics: true, chat: true, ts: Date.now() },
    'not-json{',
  ];
  for (const val of bad) {
    await page.evaluate((x) => localStorage.setItem('pj-consent', typeof x === 'string' ? x : JSON.stringify(x)), val);
    await page.reload();
    await armAndWait(page, 1500);
    await expectNoTawk(page, hits);
  }
  if (!configured) return; // TODO(#185): 未配置 Tawk 测试 ID（构建期变量）时跳过“合法 v2 加载”部分
  await page.evaluate(() => localStorage.setItem('pj-consent', JSON.stringify({ v: 2, analytics: false, chat: true, ts: Date.now() })));
  await page.reload();
  await page.mouse.move(200, 200); await page.mouse.wheel(0, 300);
  await expect.poll(() => hits.length, { timeout: 12_000 }).toBeGreaterThan(0);
});

test('chat=true：交互后只从 embed.tawk.to 加载脚本（mock）', async ({ page }) => {
  // TODO(#185): 测试构建需带 NEXT_PUBLIC_TAWK_PROPERTY_ID / NEXT_PUBLIC_TAWK_WIDGET_ID（构建期注入），否则 useTawk 整体关闭
  test.skip(!configured, 'TODO(#185): 未配置 Tawk 测试 ID（构建期变量），跳过同意后加载检查');
  const hits = await mockTawk(page);
  await presetConsent(page, { analytics: false, chat: true });
  await page.goto('/en');
  await page.mouse.move(200, 200); await page.mouse.wheel(0, 300);
  await expect.poll(() => hits.length, { timeout: 12_000 }).toBeGreaterThan(0);
  expect(hits[0]).toMatch(/^https:\/\/embed\.tawk\.to\/[A-Za-z0-9]{1,40}\/[A-Za-z0-9]{1,40}$/);
  await expect(page.locator('script#tawk-js')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __tawkStubLoaded?: boolean }).__tawkStubLoaded === true)).toBe(true);
});

test('先拒绝、再在页面内同意聊天：之后才加载', async ({ page }) => {
  test.skip(!configured, 'TODO(#185): 未配置 Tawk 测试 ID（构建期变量）');
  const hits = await mockTawk(page);
  await presetConsent(page, { analytics: false, chat: false });
  await page.goto('/en');
  await armAndWait(page, 1500);
  expect(hits).toEqual([]);
  await page.evaluate(() => {
    localStorage.setItem('pj-consent', JSON.stringify({ v: 2, analytics: false, chat: true, ts: Date.now() }));
    window.dispatchEvent(new CustomEvent('pj:consent', { detail: { v: 2, analytics: false, chat: true, ts: Date.now() } }));
  });
  await expect.poll(() => hits.length, { timeout: 12_000 }).toBeGreaterThan(0);
});

test('写入 v1 同意记录（chat=true）：不加载 Tawk.to', async ({ page }) => {
  const hits = await mockTawk(page);
  await page.addInitScript(() => localStorage.setItem('pj-consent', JSON.stringify({ v: 1, analytics: true, chat: true, ts: Date.now() })));
  await page.goto('/en');
  await armAndWait(page);
  await expectNoTawk(page, hits);
});

test('CSP：tawk 只放行 *.tawk.to，脚本/连接/框架没有通配 https:', async ({ request }) => {
  const res = await request.get('/en');
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).not.toBe('');
  const dir = (name: string) => (csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' ')) ?? '').split(/\s+/).slice(1);
  const allowedTawk = new Set(['https://embed.tawk.to', 'https://*.tawk.to', 'wss://*.tawk.to']);
  for (const d of ['script-src', 'style-src', 'font-src', 'connect-src', 'frame-src']) {
    const srcs = dir(d);
    const tawk = srcs.filter((s) => /tawk/i.test(s));
    for (const s of tawk) expect(allowedTawk.has(s), `${d}: ${s}`).toBe(true);
    expect(srcs, d).not.toContain('https:');
    expect(srcs, d).not.toContain('*');
    expect(srcs.some((s) => /^(https?|wss?):\/\/\*\.to$|tawk\.to\.|\*tawk/i.test(s)), d).toBe(false);
  }
  expect(dir('script-src').filter((s) => /^https?:\/\//.test(s)).sort()).toEqual(['https://*.tawk.to', 'https://challenges.cloudflare.com', 'https://embed.tawk.to']);
  expect(dir('connect-src')).toContain('wss://*.tawk.to');
  expect(dir('frame-src')).toContain('https://*.tawk.to');
});

test('/admin：即使已同意聊天，也不加载 Tawk.to', async ({ page }) => {
  const hits = await mockTawk(page);
  await presetConsent(page, { analytics: true, chat: true });
  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  await armAndWait(page);
  await page.goto('/admin/inquiries', { waitUntil: 'domcontentloaded' });
  await armAndWait(page, 2000);
  expect(hits).toEqual([]);
  await expect(page.locator('script[src*="tawk.to"]')).toHaveCount(0);
});
