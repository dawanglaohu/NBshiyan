import { test, expect } from './fixtures';
import { useSharedAdmin } from './shared-admin';

/**
 * M3-T22 / E-107：未归类邮件保持关闭门禁。
 * - 真实 ADMIN 会话（run 级 content-admin），真实查询 /api/admin/account 探针。
 * - 侧栏无「未归类邮件」入口；直达 /admin/mail/unassigned 为真实 404。
 * - 网络记录不得出现 unassigned / assign-lookup / assign / ignore / attachments 这组 API。
 * - 三尺寸（1920×1080、1440×900、390×844）留截图；关闭页面不在 DOM，D1–D6/computed style
 *   一律记 gate-off/not-rendered，不能填通过。
 */
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${Number(process.env.E2E_PORT ?? 3100)}`;
const CLOSED_API = /\/api\/admin\/mail\/(?:unassigned|assign-lookup|assign|ignore|attachments)\b/;

useSharedAdmin({ emailPrefix: 'e2e-unassigned', name: 'E2E unassigned gate', probe: '/api/admin/account', slot: 'content-admin' });

function watchClosedApi(page: import('@playwright/test').Page): string[] {
  const hits: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (CLOSED_API.test(path)) hits.push(r.url());
  });
  return hits;
}

test('ADMIN 侧栏无未归类入口，直达 404，零相关请求', async ({ page }) => {
  const hits = watchClosedApi(page);
  await page.goto(`${BASE}/admin/inquiries`);
  await expect(page.getByTestId('unassigned-nav-link')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /未归类邮件/ })).toHaveCount(0);
  const resp = await page.goto(`${BASE}/admin/mail/unassigned`);
  expect(resp?.status()).toBe(404);
  // 真实 404 页面：未归类组件不在 DOM（gate-off / not-rendered），不以骨架/空态冒充渲染。
  expect(await page.getByTestId('unassigned-inbox').count()).toBe(0);
  await page.waitForTimeout(300);
  expect(hits).toEqual([]);
});

for (const view of [
  { label: '1920x1080', width: 1920, height: 1080 },
  { label: '1440x900', width: 1440, height: 900 },
  { label: '390x844', width: 390, height: 844 },
]) {
  test(`三尺寸 ${view.label}：导航到受门禁拒绝页，零请求并留截图`, async ({ page }, testInfo) => {
    const hits = watchClosedApi(page);
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.goto(`${BASE}/admin/inquiries`);
    await expect(page.getByTestId('unassigned-nav-link')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /未归类邮件/ })).toHaveCount(0);
    const resp = await page.goto(`${BASE}/admin/mail/unassigned`);
    expect(resp?.status()).toBe(404);
    expect(hits).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, '404 页面不得横向溢出').toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`unassigned-gate-${view.label}.png`), fullPage: true });
  });
}
