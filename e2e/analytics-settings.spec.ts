import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import { useSharedAdmin } from './shared-admin';
import { loadRunAuth } from './run-auth';
import type { Page, Request } from '@playwright/test';

// M5-T10 /admin/settings?section=analytics：真实页面 + 真实 GET/PATCH（M5-T4 接口），仅 E2E 测试库。
// 覆盖：分区入口、GET 四字段、PATCH 带 expectedVersion、非法 IANA 字段错且不清原值（E-59）、
// 非 ADMIN 直接接口 403 / 页面 404、两种浏览器时区同值、三尺寸 form D1–D6 与 overflow。
const BASE = `http://localhost:${Number(process.env.E2E_PORT ?? 3100)}`;
const API = '/api/admin/settings/analytics';
const PROBE_SRC = readFileSync('docs/PackJoyU-开发文档/_run/density_probe.js', 'utf8');

async function density(page: Page, opts: { type: 'form'; density: number; gutter: number; gap: number; pad: number; main: string }) {
  await page.addScriptTag({ content: PROBE_SRC });
  return page.evaluate((o) => {
    const probe = (window as unknown as { densityProbe?: (x: typeof o) => Record<string, unknown> }).densityProbe;
    if (!probe) throw new Error('densityProbe 未注入');
    return probe(o);
  }, opts);
}

test('未登录：直接读接口 401，页面跳登录', async ({ request }) => {
  expect((await request.get(API)).status()).toBe(401);
  const r = await request.get('/admin/settings?section=analytics', { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(r.status());
});

test('非 ADMIN：直接接口 403，页面 404（E-59 权限侧）', async ({ browser, playwright }) => {
  const state = await loadRunAuth('sales', BASE, playwright.request);
  const api = await playwright.request.newContext({ baseURL: BASE, storageState: state });
  expect((await api.get(API)).status()).toBe(403);
  expect((await api.patch(API, { headers: { Origin: BASE }, data: { timezone: 'UTC', expectedVersion: 0 } })).status()).toBe(403);
  await api.dispose();

  const ctx = await browser.newContext({ baseURL: BASE, storageState: state });
  const page = await ctx.newPage();
  const res = await page.goto('/admin/settings?section=analytics');
  expect(res!.status()).toBe(404);
  await ctx.close();
});

test.describe('已登录的 ADMIN', () => {
  useSharedAdmin({ emailPrefix: 'e2e-analytics-settings', name: 'E2E analytics settings', probe: API, slot: 'content-admin' });

  test('分区入口 → GET 四字段 → PATCH expectedVersion → 非法 IANA 本地拦截与服务端 400（E-59）', async ({ page, playwright }) => {
    test.setTimeout(120_000);
    await page.goto('/admin/settings');
    const nav = page.getByRole('navigation', { name: '站点设置分区' });
    await expect(nav.getByRole('link', { name: '统计时区' })).toBeVisible();

    const getResponse = page.waitForResponse((r) => new URL(r.url()).pathname === API && r.request().method() === 'GET');
    await nav.getByRole('link', { name: '统计时区' }).click();
    await expect(page).toHaveURL(/section=analytics/);
    await expect(page.getByRole('heading', { level: 1, name: '统计时区' })).toBeVisible();
    await expect(nav.getByRole('link', { name: '统计时区' })).toHaveAttribute('aria-current', 'page');

    const got = await getResponse;
    expect(got.status()).toBe(200);
    const initial = (await got.json()) as { version: number; timezone: string; timezoneRevision: number; recomputableFrom: string | null };
    expect(Object.keys(initial).sort()).toEqual(['recomputableFrom', 'timezone', 'timezoneRevision', 'version']);

    const tzCell = page.getByTestId('analytics-settings-timezone');
    await expect(tzCell).toHaveText(initial.timezone);
    await expect(page.getByTestId('analytics-settings-revision')).toHaveText(String(initial.timezoneRevision));
    await expect(page.getByTestId('analytics-settings-recomputable')).toBeVisible();

    // 目标时区避开当前值，保证 PATCH 真的改变 revision；本地预检 + 服务端权威校验
    const target = initial.timezone === 'Asia/Tokyo' ? 'Europe/Berlin' : 'Asia/Tokyo';
    await page.getByTestId('analytics-settings-input').fill(target);
    const patchResponse = page.waitForResponse((r) => new URL(r.url()).pathname === API && r.request().method() === 'PATCH');
    const patchRequest = page.waitForRequest((r) => new URL(r.url()).pathname === API && r.request().method() === 'PATCH');
    await page.getByTestId('analytics-settings-save').click();
    const req = await patchRequest;
    expect(req.postDataJSON()).toEqual({ timezone: target, expectedVersion: initial.version });
    const patched = await patchResponse;
    expect(patched.status()).toBe(200);
    const next = (await patched.json()) as { version: number; timezone: string; timezoneRevision: number; rebuildScheduled: boolean };
    expect(next.timezone).toBe(target);
    expect(next.version).toBe(initial.version + 1);
    expect(next.timezoneRevision).toBeGreaterThan(initial.timezoneRevision);
    expect(next.rebuildScheduled).toBe(true);
    await expect(tzCell).toHaveText(target);
    await expect(page.getByTestId('analytics-settings-revision')).toHaveText(String(next.timezoneRevision));
    await expect(page.getByTestId('analytics-settings-rebuild')).toBeVisible();
    await expect(page.getByTestId('analytics-settings-status')).toContainText('已保存');

    // 非法 IANA ①：客户端预检直接拦下，不发 PATCH；字段错出现、输入保留、右栏仍是服务端上一有效值
    const bad = 'Mars/Olympus';
    let uiPatches = 0;
    const countPatch = (r: Request) => {
      if (new URL(r.url()).pathname === API && r.method() === 'PATCH') uiPatches += 1;
    };
    page.on('request', countPatch);
    await page.getByTestId('analytics-settings-input').fill(bad);
    await page.getByTestId('analytics-settings-save').click();
    await expect(page.getByTestId('analytics-settings-field-error')).toBeVisible();
    await expect(page.getByTestId('analytics-settings-input')).toHaveValue(bad);
    await expect(tzCell).toHaveText(target);
    await expect(page.getByTestId('analytics-settings-revision')).toHaveText(String(next.timezoneRevision));
    await page.waitForTimeout(600);
    expect(uiPatches, '本地预检不应发出 PATCH').toBe(0);
    page.off('request', countPatch);

    // 非法 IANA ②：服务端权威校验仍是真实 400（不因客户端预检而放宽 API），配置未被写
    const state = await page.context().storageState();
    const admin = await playwright.request.newContext({ baseURL: BASE, storageState: state });
    try {
      const rejected = await admin.patch(API, {
        headers: { Origin: BASE },
        data: { timezone: bad, expectedVersion: next.version },
      });
      expect(rejected.status()).toBe(400);
      const rejectedBody = (await rejected.json()) as { error: string; fieldErrors?: { timezone?: string } };
      expect(rejectedBody.error).toBe('invalid');
      expect(rejectedBody.fieldErrors?.timezone).toBeTruthy();

      const reread = await admin.get(API);
      expect(reread.status()).toBe(200);
      const after = (await reread.json()) as { version: number; timezone: string; timezoneRevision: number };
      expect(after.timezone).toBe(target);
      expect(after.version).toBe(next.version);
      expect(after.timezoneRevision).toBe(next.timezoneRevision);
    } finally {
      await admin.dispose();
    }
  });

  test('两种浏览器时区读到同一站点设置；三尺寸 form D1–D6 与 overflow', async ({ page, browser }) => {
    test.setTimeout(180_000);
    await page.goto('/admin/settings?section=analytics');
    await expect(page.getByTestId('analytics-settings-timezone')).toBeVisible();
    const shown = await page.getByTestId('analytics-settings-timezone').innerText();

    const state = await page.context().storageState();
    for (const timezoneId of ['America/New_York', 'Asia/Tokyo']) {
      const ctx = await browser.newContext({ baseURL: BASE, storageState: state, timezoneId });
      const other = await ctx.newPage();
      await other.goto('/admin/settings?section=analytics');
      await expect(other.getByTestId('analytics-settings-timezone')).toHaveText(shown);
      await ctx.close();
    }

    for (const vp of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(vp);
      await page.goto('/admin/settings?section=analytics');
      await expect(page.getByTestId('analytics-settings-input')).toBeVisible();
      const probe = (await density(page, { type: 'form', density: 7, gutter: 16, gap: 16, pad: 16, main: '.st-page' })) as {
        verdict: Record<string, string | boolean>;
        fill?: number;
        leftGap?: number;
        overflowX?: number;
      };
      expect(probe.verdict.overflow, `${vp.width} overflow`).toBe('pass');
      if (vp.width >= 1024) {
        for (const k of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']) expect(probe.verdict[k], `${vp.width} ${k}`).toBe('pass');
        expect(probe.verdict.pass, `${vp.width} verdict.pass`).toBe(true);
        expect(probe.fill ?? 0, `${vp.width} fill`).toBeGreaterThanOrEqual(0.55);
        expect(probe.leftGap ?? 999, `${vp.width} leftGap`).toBeLessThanOrEqual(16 + 24);
      }
    }
  });

  test('版本冲突：他处 ADMIN 推进 version 后旧保存获 409，显式读取最新才更新', async ({ page, playwright }) => {
    test.setTimeout(120_000);
    const initialResponse = page.waitForResponse((r) => new URL(r.url()).pathname === API && r.request().method() === 'GET');
    await page.goto('/admin/settings?section=analytics');
    const initialRes = await initialResponse;
    expect(initialRes.status()).toBe(200);
    const before = (await initialRes.json()) as { version: number; timezone: string; timezoneRevision: number };
    const tzCell = page.getByTestId('analytics-settings-timezone');
    await expect(tzCell).toHaveText(before.timezone);

    const candidates = ['Asia/Tokyo', 'Europe/Berlin', 'UTC', 'America/New_York'].filter((tz) => tz !== before.timezone);
    const elsewhere = candidates[0];
    const mine = candidates[1];

    // 另一个真实认证的 ADMIN 会话推进版本：不是页面自己那条保存请求
    const otherState = await loadRunAuth('imageB', BASE, playwright.request);
    const other = await playwright.request.newContext({ baseURL: BASE, storageState: otherState });
    try {
      const advanced = await other.patch(API, {
        headers: { Origin: BASE },
        data: { timezone: elsewhere, expectedVersion: before.version },
      });
      expect(advanced.status()).toBe(200);
      const advancedBody = (await advanced.json()) as { version: number; timezone: string };
      expect(advancedBody.timezone).toBe(elsewhere);
      expect(advancedBody.version).toBe(before.version + 1);
    } finally {
      await other.dispose();
    }

    let patches = 0;
    const countPatch = (r: Request) => {
      if (new URL(r.url()).pathname === API && r.method() === 'PATCH') patches += 1;
    };
    page.on('request', countPatch);
    await page.getByTestId('analytics-settings-input').fill(mine);
    const conflictResponse = page.waitForResponse((r) => new URL(r.url()).pathname === API && r.request().method() === 'PATCH');
    await page.getByTestId('analytics-settings-save').click();
    const conflictRes = await conflictResponse;
    expect(conflictRes.status()).toBe(409);
    expect(((await conflictRes.json()) as { error: string }).error).toBe('version_conflict');

    // 旧 UI 不自动接受新版本：输入与右栏都保留旧值，保存停用，且没有自动重试
    await expect(page.getByTestId('analytics-settings-alert')).toContainText('配置已被其他会话修改');
    await expect(page.getByTestId('analytics-settings-input')).toHaveValue(mine);
    await expect(tzCell).toHaveText(before.timezone);
    await expect(page.getByTestId('analytics-settings-save')).toBeDisabled();
    await page.waitForTimeout(600);
    expect(patches, '409 后不应自动重试 PATCH').toBe(1);
    page.off('request', countPatch);

    // 用户显式读取最新：右侧版本与站点时区才更新，输入仍保留
    const reloadResponse = page.waitForResponse((r) => new URL(r.url()).pathname === API && r.request().method() === 'GET');
    await page.getByRole('button', { name: '读取最新配置' }).click();
    const reloadRes = await reloadResponse;
    expect(reloadRes.status()).toBe(200);
    const latest = (await reloadRes.json()) as { version: number; timezone: string };
    expect(latest.timezone).toBe(elsewhere);
    expect(latest.version).toBe(before.version + 1);
    await expect(tzCell).toHaveText(elsewhere);
    await expect(page.getByTestId('analytics-settings-status')).toContainText(`version ${latest.version}`);
    await expect(page.getByTestId('analytics-settings-input')).toHaveValue(mine);
    await expect(page.getByTestId('analytics-settings-save')).toBeEnabled();
  });
});
