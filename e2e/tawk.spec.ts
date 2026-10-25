import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { isThirdPartyChatUrl, thirdPartyChatDomSelector } from './third-party-chat';

/**
 * 任何同意状态下都不加载第三方聊天。CSP 不再点名旧的聊天域名。
 */

async function presetConsent(page: Page, c: { analytics: boolean; chat: boolean } | null) {
  await page.addInitScript((v) => {
    if (v) localStorage.setItem('pj-consent', JSON.stringify({ v: 2, ...v, ts: Date.now() }));
    else localStorage.removeItem('pj-consent');
  }, c);
}

async function armAndWait(page: Page, ms = 1500) {
  await page.mouse.move(200, 200);
  await page.keyboard.press('Tab');
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(ms);
}

async function expectNoTawk(page: Page, hits: string[]) {
  expect(hits.filter(isThirdPartyChatUrl)).toEqual([]);
  await expect(page.locator(thirdPartyChatDomSelector())).toHaveCount(0);
  expect(await page.evaluate(() => Boolean((window as unknown as { Tawk_API?: unknown }).Tawk_API))).toBe(false);
}

test('同意前：没有任何 tawk.to 请求或脚本', async ({ page, external }) => {
  await presetConsent(page, null);
  await page.goto('/en');
  await armAndWait(page);
  await expectNoTawk(page, external.urls);
});

test('chat=false（即使 analytics=true）：不加载第三方聊天', async ({ page, external }) => {
  await presetConsent(page, { analytics: true, chat: false });
  for (const p of ['/en', '/ru']) {
    await page.goto(p);
    await armAndWait(page, 800);
  }
  await expectNoTawk(page, external.urls);
});

test('旧同意值和 chat=true 都不加载第三方聊天', async ({ page, external }) => {
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
    await armAndWait(page, 600);
    await expectNoTawk(page, external.urls);
  }
  await page.evaluate(() => localStorage.setItem('pj-consent', JSON.stringify({ v: 2, analytics: false, chat: true, ts: Date.now() })));
  await page.reload();
  await armAndWait(page);
  await expectNoTawk(page, external.urls);
});

test('chat=true：交互后仍不请求 tawk.to', async ({ page, external }) => {
  await presetConsent(page, { analytics: false, chat: true });
  await page.goto('/en');
  await armAndWait(page);
  await expectNoTawk(page, external.urls);
});

test('页面内把旧 chat 位改成 true：仍不加载第三方聊天', async ({ page, external }) => {
  await presetConsent(page, { analytics: false, chat: false });
  await page.goto('/en');
  await armAndWait(page, 600);
  await page.evaluate(() => {
    localStorage.setItem('pj-consent', JSON.stringify({ v: 2, analytics: false, chat: true, ts: Date.now() }));
    window.dispatchEvent(new CustomEvent('pj:consent', { detail: { v: 2, analytics: false, chat: true, ts: Date.now() } }));
  });
  await armAndWait(page, 800);
  await expectNoTawk(page, external.urls);
});

test('写入 v1 同意记录（chat=true）：不加载第三方聊天', async ({ page, external }) => {
  await page.addInitScript(() => localStorage.setItem('pj-consent', JSON.stringify({ v: 1, analytics: true, chat: true, ts: Date.now() })));
  await page.goto('/en');
  await armAndWait(page);
  await expectNoTawk(page, external.urls);
});

test('CSP 不含 tawk.to，脚本源只有 Cloudflare，没有通配 https:', async ({ request }) => {
  const res = await request.get('/en');
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).not.toBe('');
  expect(csp.toLowerCase()).not.toContain('tawk.to');
  const dir = (name: string) => (csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' ')) ?? '').split(/\s+/).slice(1);
  for (const d of ['script-src', 'style-src', 'font-src', 'connect-src', 'frame-src']) {
    const srcs = dir(d);
    expect(srcs, d).not.toContain('https:');
    expect(srcs, d).not.toContain('*');
  }
  expect(dir('script-src').filter((s) => /^https?:\/\//.test(s)).sort()).toEqual(['https://challenges.cloudflare.com', 'https://static.cloudflareinsights.com']);
});

test('/admin：即使已同意聊天，也不加载第三方聊天', async ({ page, external }) => {
  await presetConsent(page, { analytics: true, chat: true });
  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  await armAndWait(page);
  await page.goto('/admin/inquiries', { waitUntil: 'domcontentloaded' });
  await armAndWait(page, 800);
  await expectNoTawk(page, external.urls);
});
