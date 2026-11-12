import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import { useSharedAdmin } from './shared-admin';
import { loadRunAuth } from './run-auth';
import type { Page } from '@playwright/test';

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

  const ctx = await browser.newContext({ storageState: state });
  const page = await ctx.newPage();
  const res = await page.goto('/admin/settings?section=analytics');
  expect(res!.status()).toBe(404);
  await ctx.close();
});

test.describe('已登录的 ADMIN', () => {
  useSharedAdmin({ emailPrefix: 'e2e-analytics-settings', name: 'E2E analytics settings', probe: API, slot: 'content-admin' });

  test('分区入口 → GET 四字段 → PATCH expectedVersion → 非法 IANA 字段错保留输入（E-59）', async ({ page }) => {
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

    // 非法 IANA：服务端 400 invalid + fieldErrors.timezone；输入保留、服务端值不变
    const bad = 'Mars/Olympus';
    await page.getByTestId('analytics-settings-input').fill(bad);
    const badResponse = page.waitForResponse((r) => new URL(r.url()).pathname === API && r.request().method() === 'PATCH');
    await page.getByTestId('analytics-settings-save').click();
    const badRes = await badResponse;
    expect(badRes.status()).toBe(400);
    const body = (await badRes.json()) as { error: string; fieldErrors?: { timezone?: string } };
    expect(body.error).toBe('invalid');
    expect(body.fieldErrors?.timezone).toBeTruthy();
    await expect(page.getByTestId('analytics-settings-input')).toHaveValue(bad);
    await expect(page.getByTestId('analytics-settings-field-error')).toBeVisible();
    await expect(tzCell).toHaveText(target);
  });

  test('两种浏览器时区读到同一站点设置；三尺寸 form D1–D6 与 overflow', async ({ page, browser }) => {
    test.setTimeout(180_000);
    await page.goto('/admin/settings?section=analytics');
    await expect(page.getByTestId('analytics-settings-timezone')).toBeVisible();
    const shown = await page.getByTestId('analytics-settings-timezone').innerText();

    const state = await page.context().storageState();
    for (const timezoneId of ['America/New_York', 'Asia/Tokyo']) {
      const ctx = await browser.newContext({ storageState: state, timezoneId });
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
});
