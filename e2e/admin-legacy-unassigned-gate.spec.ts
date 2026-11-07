import { test, expect } from './fixtures';
import { useSharedAdmin } from './shared-admin';

/**
 * M3-T22 / E-107：未归类邮件保持关闭门禁。
 * - 真实 ADMIN 会话（run 级 content-admin），真实查询 /api/admin/account 探针。
 * - 真实 ADMIN 从既有后台页经**可见侧栏「询盘」**进入询盘页（<768px 先开抽屉），
 *   导航实际渲染后再核侧栏无「未归类邮件」入口；直达 /admin/mail/unassigned 为真实 404。
 * - 网络记录不得出现 unassigned / assign-lookup / assign / ignore / attachments 这组 API。
 * - 三尺寸（1920×1080、1440×900、390×844）留截图；关闭页面不在 DOM，D1–D6/computed style
 *   一律记 gate-off/not-rendered，不能填通过。
 */
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${Number(process.env.E2E_PORT ?? 3100)}`;
// CLOSED_MAIL_API:begin
const CLOSED_MAIL_API: RegExp[] = [
  /\/api\/admin\/mail\/unassigned(?:\/[^/]+)?$/,
  /\/api\/admin\/mail\/assign-lookup$/,
  /\/api\/admin\/mail\/[^/]+\/(?:assign|ignore)$/,
  /\/api\/admin\/mail\/attachments(?:\/|$)/,
];
/** 关闭门禁下不允许出现的真实 API 路径（含 /mail/{id}/assign 与 /mail/{id}/ignore|unignore）。 */
export function isClosedMailApiPath(pathname: string): boolean {
  return CLOSED_MAIL_API.some((re) => re.test(pathname));
}
// CLOSED_MAIL_API:end

useSharedAdmin({ emailPrefix: 'e2e-unassigned', name: 'E2E unassigned gate', probe: '/api/admin/account', slot: 'content-admin' });

function watchClosedApi(page: import('@playwright/test').Page): string[] {
  const hits: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (isClosedMailApiPath(path)) hits.push(r.url());
  });
  return hits;
}

/**
 * 从既有后台页（/admin/specs）经可见侧栏「询盘」进入询盘页；<768px 先打开抽屉。
 * 断言「未归类邮件」入口缺失之前，必须先确认导航已实际渲染——不能用尚未加载的空白导航通过。
 * 路由切换会随 path 变化自动收起抽屉；状态帧必须在抽屉收起后采集，不能带遮罩。
 */
async function enterInquiriesViaNav(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/admin/specs`, { waitUntil: 'domcontentloaded' });
  const nav = page.getByRole('navigation', { name: '后台导航' });
  // 用 class 定位菜单按钮：展开时它的可访问名变成「关闭导航菜单」，按名字找会在开合两种状态间失效。
  const menu = page.locator('button.adm-menu');
  const shell = page.locator('.adm');
  const hasDrawer = () => menu.isVisible().catch(() => false); // 桌面端侧栏常驻、菜单按钮隐藏
  const openDrawer = async () => {
    if (!(await hasDrawer())) return;
    if ((await shell.getAttribute('data-nav')) !== 'open') await menu.click();
    await expect(nav).toBeVisible();
  };
  const closeDrawer = async () => {
    if (!(await hasDrawer())) return;
    if ((await shell.getAttribute('data-nav')) === 'open') await page.locator('.adm-nav-close').click();
    // data-nav=closed 且遮罩不在 DOM，才是「抽屉确实收起」；截图前必须成立。
    await expect(shell).toHaveAttribute('data-nav', 'closed');
    await expect(page.locator('.adm-scrim')).toHaveCount(0);
  };
  await openDrawer();
  await expect(nav).toBeVisible();
  const inquiries = nav.getByRole('link', { name: /^询盘/ });
  await expect(inquiries).toBeVisible();
  // 导航已渲染后再核门禁入口不存在，避免「未加载的空白导航」误判通过。
  await expect(nav.getByRole('link', { name: /未归类邮件/ })).toHaveCount(0);
  await inquiries.click();
  await page.waitForURL(/\/admin\/inquiries(\?|$)/, { timeout: 30_000 });
  // 换页后移动端抽屉自动收起（AdminShell 的 path effect）；等它真正 closed，而不是再点一次菜单按钮把它打开。
  await expect(shell).toHaveAttribute('data-nav', 'closed');
  // 换页后再核一次导航门禁入口；移动端重新展开（此时导航已渲染），随后显式收起。
  await openDrawer();
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: /未归类邮件/ })).toHaveCount(0);
  await closeDrawer();
}

test('ADMIN 侧栏无未归类入口，直达 404，零相关请求', async ({ page }) => {
  const hits = watchClosedApi(page);
  await enterInquiriesViaNav(page);
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
    await enterInquiriesViaNav(page);
    await expect(page.getByTestId('unassigned-nav-link')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /未归类邮件/ })).toHaveCount(0);
    // 有界就绪检查：加载标记消失且询盘表格/筛选真实可见（不靠帧数或 networkidle 代表 React 已提交）。
    await expect(page.getByText('加载中…')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('table.adm-inq-table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('group', { name: '状态' })).toBeVisible();
    // 导航补证状态帧：真实点击「询盘」进入后的询盘页（随后再直达关闭页留 404 帧）。
    await page.screenshot({ path: testInfo.outputPath(`unassigned-nav-inquiries-${view.label}.png`), fullPage: true });
    const resp = await page.goto(`${BASE}/admin/mail/unassigned`);
    expect(resp?.status()).toBe(404);
    expect(hits).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, '404 页面不得横向溢出').toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`unassigned-gate-${view.label}.png`), fullPage: true });
  });
}
