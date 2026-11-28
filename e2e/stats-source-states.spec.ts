import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { shiftLocalDate } from '../src/lib/analytics/aggregate-plan';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { AnalyticsSettingsDTOSchema, AnalyticsSettingsUpdateDTOSchema } from '../src/lib/contracts/analytics';
import { OpsReportReceiptDTOSchema, StatsDTOSchema, type OpsReportRequestDTO, type StatsDTO, type StatsSource, type StatsSourceDTO } from '../src/lib/contracts/ops';
import { BASE } from './base-url';
import { expect, test } from './fixtures';
import { E2E_TOTP } from './shared-admin';

const viewports = [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 390, height: 844 }];
const statsPath = '/api/admin/stats';
const settingsPath = '/api/admin/settings/analytics';
const proofDirectory = process.env.M6T7_GIF_FRAMES;

function source(dto: StatsDTO, name: StatsSource): StatsSourceDTO {
  const item = dto.sources.find((entry) => entry.source === name);
  if (!item) throw new Error(`Missing stats source: ${name}`);
  return item;
}

async function observeStatsReads(page: Page) {
  const entries: { status: number; url: string; body: Buffer }[] = [];
  // Retain the real response before Chromium can evict its response-body buffer.
  await page.route((url) => url.pathname === statsPath, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.body();
    await route.fulfill({ response, body });
    entries.push({ status: response.status(), url: route.request().url(), body });
  });
  return async (action: () => Promise<void>): Promise<{ dto: StatsDTO; url: string }> => {
    const next = entries.length;
    await action();
    await expect.poll(() => entries.length).toBe(next + 1);
    const entry = entries[next]!;
    expect(entry.status).toBe(200);
    return { dto: StatsDTOSchema.parse(JSON.parse(entry.body.toString('utf8'))), url: entry.url };
  };
}

function retry(page: Page, name: StatsSource): Locator {
  return page.getByTestId(`stats-retry-${name}`);
}

async function assertReading(page: Page, item: StatsSourceDTO) {
  const card = page.getByTestId(`stats-source-${item.source}`);
  await expect(card).toHaveAttribute('data-source-state', item.state);
  await expect(card.getByRole('heading')).toBeVisible();
  for (const [name, timestamp] of Object.entries({
    '数据截止': item.dataThrough,
    '最近成功': item.lastSucceededAt,
    '查询时间': item.queriedAt,
  })) {
    const time = card.getByText(`${name}：`, { exact: true }).locator('..');
    if (timestamp === null) await expect(time).toContainText('未知');
    else await expect(time.locator('time')).toHaveAttribute('datetime', timestamp);
  }
  await expect(card).toContainText(`${item.timezone} (rev ${item.timezoneRevision})`);
}

async function verifyDensity(page: Page, item: StatsSourceDTO, attach: (name: string, json: unknown) => Promise<void>) {
  const probe = readFileSync('docs/PackJoyU-开发文档/_run/density_probe.js', 'utf8');
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await assertReading(page, item);
    const report = await page.evaluate((script) => {
      (0, eval)(script);
      const { densityProbe } = globalThis as unknown as {
        densityProbe(options: Record<string, string | number>): { contentFound: boolean; verdict: Record<string, string | boolean> };
      };
      return densityProbe({ type: 'work', density: 7, gutter: 16, gap: 16, pad: 16, main: 'main.adm-main' });
    }, probe);
    const control = retry(page, item.source);
    await control.focus();
    const styles = await control.evaluate((button) => {
      const style = getComputedStyle(button);
      const card = button.closest('article')!;
      const time = card.querySelector('time')!;
      return {
        focused: button.matches(':focus-visible'),
        height: button.getBoundingClientRect().height,
        outline: style.outlineStyle,
        labelSize: getComputedStyle(card.querySelector('h3')!).fontSize,
        timeSize: getComputedStyle(time).fontSize,
        bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    await attach(`density-${viewport.width}x${viewport.height}`, { viewport, report, styles });
    expect(report.contentFound).toBe(true);
    expect(report.verdict).toMatchObject(viewport.width === 390
      ? { D1: 'n/a', D2: 'n/a', D3: 'pass', D4: 'n/a', D5: 'n/a', D6: 'n/a', overflow: 'pass' }
      : { D1: 'pass', D2: 'pass', D3: 'pass', D4: 'pass', D5: 'pass', D6: 'pass', overflow: 'pass' });
    expect(styles).toMatchObject({ focused: true, outline: 'solid', labelSize: '14px', timeSize: '14px' });
    expect(styles.height).toBeGreaterThanOrEqual(viewport.width === 390 ? 44 : 36);
    expect(styles.bodyOverflow).toBeLessThanOrEqual(1);
  }
}

// Run explicitly on a fresh isolated database. The existing A3 gate pins its collection and needs a contract update to take ownership of this spec.
if (process.env.M6T7_SOURCE_STATES_E2E === '1') {
  test.describe.configure({ timeout: 180_000 });
  test.use({ locale: 'zh-CN' });

  test('M6-T7: real dashboard reads, per-source failures, recovery and density', async ({ page, request }, testInfo) => {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) throw new Error('The isolated e2e app requires CRON_SECRET.');
    const email = `e2e-m6t7-${Date.now()}@example.test`;
    const password = 'e2e-only-M6T7-Passw0rd!';
    execFileSync('node', ['scripts/create-admin.mjs'], {
      stdio: 'ignore',
      env: {
        ...process.env,
        ADMIN_SEED_EMAIL: email,
        ADMIN_SEED_PASSWORD: password,
        ADMIN_SEED_NAME: 'E2E M6-T7',
        ADMIN_SEED_ROLE: 'ADMIN',
        ADMIN_SEED_TOTP_SECRET: E2E_TOTP,
      },
    });
    const report = async (data: OpsReportRequestDTO) => {
      const response = await request.post('/api/internal/ops-report', {
        headers: { authorization: `Bearer ${cronSecret}` },
        data,
      });
      expect(response.status()).toBe(200);
      expect(OpsReportReceiptDTOSchema.parse(await response.json()).accepted).toBe(true);
    };
    const capture = async (name: string) => {
      if (proofDirectory) {
        mkdirSync(proofDirectory, { recursive: true });
        await page.screenshot({ path: path.join(proofDirectory, `${name}.png`), animations: 'disabled' });
      }
    };

    await page.setViewportSize(viewports[1]!);
    const readStatsAfter = await observeStatsReads(page);
    await page.goto('/admin-login');
    await page.getByLabel('邮箱').fill(email);
    await page.getByLabel('密码', { exact: true }).fill(password);
    const signIn = page.getByRole('button', { name: '登录', exact: true });
    await signIn.click();
    await page.getByLabel('验证码').fill(authenticator.generate(E2E_TOTP));
    await signIn.click();

    const statsLink = page.getByRole('navigation', { name: '后台导航' }).getByTestId('stats-link');
    const { dto: initial } = await readStatsAfter(() => statsLink.click());
    await expect(page).toHaveURL(/\/admin\/stats$/);
    expect(source(initial, 'inquiries')).toMatchObject({ state: 'zero', value: 0 });
    expect(source(initial, 'visitors')).toMatchObject({ state: 'no_data', value: null });
    expect(source(initial, 'storage')).toMatchObject({ state: 'not_connected', value: null });
    await expect(page.getByTestId('stats-value-inquiries')).toHaveText('0');
    await expect(page.getByTestId('stats-value-visitors')).toHaveText('No data yet');
    await expect(page.getByTestId('stats-value-storage')).toContainText('Not connected');
    await assertReading(page, source(initial, 'inquiries'));
    await expect(page.getByTestId('stats-ingestion-status')).toContainText('事件接收链路状态未知');
    await expect(page.getByTestId('stats-ingestion-status')).toContainText('最近接收时间未知');
    await expect(page.getByTestId('stats-section-core')).not.toContainText(/Healthy|全链路正常|正常（OK）/);

    const statRefresh = page.getByTestId('stats-refresh');
    const start = Date.now() - 3_000;
    const attempt = (offset: number) => new Date(start + offset).toISOString();
    await report({ source: 'BACKUP', status: 'FAILED', measuredAt: attempt(0), safeErrorCode: 'service_unavailable' });
    await report({ source: 'STORAGE', status: 'OK', measuredAt: attempt(1), values: { bytesUsed: 0, bytesFree: 4096 } });
    const { dto: before } = await readStatsAfter(() => statRefresh.click());
    const storageZero = source(before, 'storage');
    expect(storageZero).toMatchObject({ state: 'zero', value: 0 });
    expect(source(before, 'backup')).toMatchObject({ state: 'query_failed', value: null, lastSucceededAt: null });
    await assertReading(page, storageZero);
    await assertReading(page, source(before, 'backup'));
    await expect(page.getByTestId('stats-value-backup')).toHaveText('查询失败（无快照）');
    await expect(retry(page, 'backup')).toBeVisible();
    await page.getByTestId('stats-source-backup').scrollIntoViewIfNeeded();
    await capture('00-independent-source-failure');

    await report({ source: 'STORAGE', status: 'FAILED', measuredAt: attempt(2), safeErrorCode: 'service_unavailable' });
    const requests: string[] = [];
    const trackStatsActions = (event: import('@playwright/test').Request) => {
      const { pathname } = new URL(event.url());
      if (pathname.startsWith('/api/') && pathname !== '/api/admin/account/session/activity') {
        requests.push(`${event.method()} ${pathname}`);
      }
    };
    page.on('request', trackStatsActions);
    const { dto: after, url } = await readStatsAfter(() => retry(page, 'backup').press('Enter'));
    expect(requests).toEqual([`GET ${statsPath}`]);
    page.off('request', trackStatsActions);
    expect(new URL(url).searchParams.get('from')).toBe(await page.getByTestId('stats-filter-from').inputValue());
    const oldStorage = source(after, 'storage');
    expect(oldStorage).toMatchObject({
      state: 'stale', value: storageZero.value,
      dataThrough: storageZero.dataThrough, lastSucceededAt: storageZero.lastSucceededAt,
    });
    expect(oldStorage.queriedAt > storageZero.queriedAt).toBe(true);
    expect(source(after, 'inquiries')).toMatchObject({ state: 'zero', value: 0, queriedAt: oldStorage.queriedAt });
    await assertReading(page, oldStorage);
    await expect(page.getByTestId('stats-source-storage')).toContainText('旧值');
    await expect(page.getByTestId('stats-value-storage')).toHaveText('0 B');
    await expect(page.getByTestId('stats-row-storage')).toContainText('旧值');
    await capture('01-old-value-and-times');
    await verifyDensity(page, oldStorage, (name, json) => testInfo.attach(name, {
      body: JSON.stringify(json, null, 2), contentType: 'application/json',
    }));
    await page.setViewportSize(viewports[1]!);

    await report({ source: 'STORAGE', status: 'OK', measuredAt: attempt(3), values: { bytesUsed: 2048, bytesFree: 4096 } });
    const { dto: restored } = await readStatsAfter(() => retry(page, 'storage').press('Enter'));
    expect(source(restored, 'storage')).toMatchObject({ state: 'ok', value: 2048, lastSucceededAt: attempt(3) });
    await assertReading(page, source(restored, 'storage'));
    await expect(page.getByTestId('stats-state-storage')).toContainText('查询成功');
    await expect(page.getByTestId('stats-value-storage')).toContainText('2.0 KiB');
    await capture('02-recovered');

    const settingsResponse = await page.request.get(settingsPath);
    expect(settingsResponse.ok()).toBe(true);
    const settings = AnalyticsSettingsDTOSchema.parse(await settingsResponse.json());
    const changed = await page.request.patch(settingsPath, {
      headers: { origin: BASE },
      data: { expectedVersion: settings.version, timezone: settings.timezone === 'Asia/Tokyo' ? 'UTC' : 'Asia/Tokyo' },
    });
    expect(changed.ok()).toBe(true);
    const change = AnalyticsSettingsUpdateDTOSchema.parse(await changed.json());
    expect(change.recomputableFrom).not.toBeNull();
    const { dto: pending } = await readStatsAfter(() => statRefresh.click());
    expect(pending.recomputableFrom).toBe(change.recomputableFrom);
    await expect(page.getByTestId('stats-recomputable')).toContainText(change.recomputableFrom!);

    const job = await request.post('/api/admin/cron/operations', {
      headers: { authorization: `Bearer ${cronSecret}` },
      data: { jobKey: 'analytics-aggregate' },
    });
    expect(job.ok()).toBe(true);
    expect(await job.json()).toMatchObject({ status: 'SUCCEEDED' });
    const { dto: aggregated } = await readStatsAfter(() => statRefresh.click());
    const aggregateVisitors = source(aggregated, 'visitors');
    expect(aggregateVisitors).toMatchObject({ coverage: 'full', state: 'zero', value: 0 });
    await expect(page.getByTestId('stats-value-visitors')).toHaveText('0');
    await expect(page.getByTestId('stats-ingestion-status')).toContainText('最近接收时间未知');
    const siteToday = siteLocalDate(new Date(aggregateVisitors.queriedAt), aggregateVisitors.timezone);
    const { dto: partial } = await readStatsAfter(() =>
      page.getByTestId('stats-filter-to').fill(shiftLocalDate(siteToday, 1)));
    expect(source(partial, 'visitors')).toMatchObject({ coverage: 'partial', state: 'no_data', value: null });
    await expect(page.getByTestId('stats-source-visitors')).toContainText('部分覆盖');
    await expect(page.getByTestId('stats-trend-coverage')).toContainText('部分覆盖');
    await expect(page.getByTestId('stats-row-visitors')).toContainText('部分覆盖');
    if (proofDirectory) {
      await page.getByTestId('stats-trend-coverage').scrollIntoViewIfNeeded();
      await capture('03-partial-coverage');
    }
  });
}
