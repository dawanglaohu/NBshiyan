import { expect, test } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { BASE } from './base-url';
import { loadRunAuth } from './run-auth';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';
import {
  AnalyticsSettingsDTOSchema,
  AnalyticsSettingsUpdateDTOSchema,
} from '../src/lib/contracts/analytics';
import { StatsDTOSchema, type StatsDTO, type StatsSource } from '../src/lib/contracts/ops';

test.use({
  ...(process.env.E2E_BROWSER_CHANNEL === 'chrome'
    ? { channel: 'chrome' as const, launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] } }
    : {}),
});

type CapturedEvent = { kind: string; productSlug?: string };

const EDITOR_ONLY_SOURCES: readonly StatsSource[] = [
  'page_views',
  'visitors',
  'product_views',
  'model_starts',
  'model_successes',
  'model_failures',
  'mean_load_duration_ms',
];

const SALES_FORBIDDEN_SOURCES: readonly StatsSource[] = [
  'api_requests',
  'api_errors',
  'mail',
  'storage',
  'backup',
];

function findSource(dto: StatsDTO, source: StatsSource) {
  const item = dto.sources.find((entry) => entry.source === source);
  if (!item) throw new Error(`Missing source ${source} in stats DTO`);
  return item;
}

async function runAggregateJob(adminReq: APIRequestContext, cronSecret: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await adminReq.post('/api/admin/cron/operations', {
      headers: { authorization: `Bearer ${cronSecret}` },
      data: { jobKey: 'analytics-aggregate' },
    });
    if (res.status() === 409) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('SUCCEEDED');
    return;
  }
  throw new Error('analytics-aggregate job remained busy after retries');
}

async function fetchStatsInBrowser(page: Page, queryString: string): Promise<{ browserTz: string; status: number; json: unknown }> {
  await page.goto('/en');
  return page.evaluate(async (qs) => {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const response = await fetch(`/api/admin/stats${qs}`, { credentials: 'include' });
    const json = await response.json();
    return { browserTz, status: response.status, json };
  }, queryString);
}

test.describe('M6-T6 stats HTTP API', () => {
  test.describe.configure({ timeout: 150_000 });

  test('M6-T6 E-55/E-58/E-61/E-63/E-66: 真实同意+访问+3D GLB+五分钟作业 -> 角色限制统计HTTP与时区切换', async ({
    browser,
    playwright,
  }) => {
    const cronSecret = process.env.CRON_SECRET;
  test.skip(!cronSecret, 'CRON_SECRET required');

  const adminAuth = await loadRunAuth('shell-main', BASE, playwright.request);
  const salesAuth = await loadRunAuth('sales', BASE, playwright.request);
  const editorAuth = await loadRunAuth('editor', BASE, playwright.request);

  const anonReq = await playwright.request.newContext({ baseURL: BASE });
  const adminReq = await playwright.request.newContext({ baseURL: BASE, storageState: adminAuth });
  const salesReq = await playwright.request.newContext({ baseURL: BASE, storageState: salesAuth });
  const editorReq = await playwright.request.newContext({ baseURL: BASE, storageState: editorAuth });

  try {
    // 1. Unauthenticated access must fail closed with 401 and no-store
    const unauth = await anonReq.get('/api/admin/stats');
    expect(unauth.status()).toBe(401);
    expect(unauth.headers()['cache-control']).toContain('no-store');

    // 2. Read initial timezone & aggregate prior state to establish clean baseline
    const settingsRes = await adminReq.get('/api/admin/settings/analytics');
    expect(settingsRes.status()).toBe(200);
    const initialSettings = AnalyticsSettingsDTOSchema.parse(await settingsRes.json());
    const siteToday = siteLocalDate(new Date(), initialSettings.timezone);

    await runAggregateJob(adminReq, cronSecret!);
    const baselineRes = await adminReq.get(`/api/admin/stats?from=${siteToday}&to=${siteToday}`);
    expect(baselineRes.status()).toBe(200);
    const baselineDto = StatsDTOSchema.parse(await baselineRes.json());
    const beforeVisitors = findSource(baselineDto, 'visitors').value ?? 0;
    const beforePageViews = findSource(baselineDto, 'page_views').value ?? 0;
    const beforeProductViews = findSource(baselineDto, 'product_views').value ?? 0;
    const beforeModelStarts = findSource(baselineDto, 'model_starts').value ?? 0;
    const beforeModelSuccesses = findSource(baselineDto, 'model_successes').value ?? 0;
    const beforeDurationSamples = findSource(baselineDto, 'mean_load_duration_ms').loadDurationSamples ?? 0;

    // 3. Real visitor browser: consent -> /en page_view -> /en/products -> real GLB start/success
    const visitorCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const visitorPage = await visitorCtx.newPage();
    const acceptedEvents: CapturedEvent[] = [];

    try {
      await visitorPage.route('**/api/analytics/events', async (route) => {
        const req = route.request();
        if (req.method() !== 'POST') {
          await route.continue();
          return;
        }
        const payload = req.postDataJSON() as {
          events?: Array<{ eventId: string; kind: string; productSlug?: string }>;
        };
        const res = await route.fetch();
        try {
          if (res.status() === 200) {
            const receipt = (await res.json()) as { acceptedIds?: string[] };
            const acceptedSet = new Set(receipt.acceptedIds ?? []);
            for (const item of payload.events ?? []) {
              if (acceptedSet.has(item.eventId)) {
                acceptedEvents.push({ kind: item.kind, productSlug: item.productSlug });
              }
            }
          }
        } finally {
          await route.fulfill({ response: res });
        }
      });

      await visitorPage.goto('/en');
      const consentBar = visitorPage.getByRole('region', { name: 'Cookie consent' });
      await expect(consentBar).toBeVisible();
      await consentBar.getByRole('button', { name: 'Accept all' }).click();
      await expect(consentBar).toBeHidden();
      await expect(visitorPage.locator('html')).toHaveAttribute('data-analytics-collecting', 'true');

      await visitorPage.locator('[data-testid="products-link"]:visible').click();
      await expect(visitorPage).toHaveURL(/\/en\/products$/);
      await expect
        .poll(() => visitorPage.locator('[data-testid="product-viewport"][data-framed="1"]').count(), { timeout: 60_000 })
        .toBeGreaterThan(0);

      await expect
        .poll(
          () => {
            const kinds = new Set(acceptedEvents.map((e) => e.kind));
            return (
              kinds.has('page_view') &&
              kinds.has('product_view') &&
              kinds.has('model_view_start') &&
              kinds.has('model_load_success')
            );
          },
          { timeout: 60_000, message: 'expected page_view, product_view, model_view_start, and model_load_success to be accepted' },
        )
        .toBe(true);
    } finally {
      await visitorCtx.close();
    }

    const loadedSuccess = acceptedEvents.find((e) => e.kind === 'model_load_success' && e.productSlug);
    const observedSlug = loadedSuccess?.productSlug ?? acceptedEvents.find((e) => e.productSlug)?.productSlug;
    expect(observedSlug).toBeTruthy();

    // 4. Submit real registered 5-minute aggregate job
    await runAggregateJob(adminReq, cronSecret!);

    // 5. Verify ADMIN real core metrics & product attribution (E-61/E-63)
    const afterRes = await adminReq.get(`/api/admin/stats?from=${siteToday}&to=${siteToday}`);
    expect(afterRes.status()).toBe(200);
    expect(afterRes.headers()['cache-control']).toContain('no-store');
    const afterDto = StatsDTOSchema.parse(await afterRes.json());
    expect(afterDto.sources).toHaveLength(17);

    const visitorsDto = findSource(afterDto, 'visitors');
    expect(visitorsDto.state).toBe('ok');
    expect(visitorsDto.coverage).toBe('full');
    expect(visitorsDto.timezone).toBe(initialSettings.timezone);
    expect(visitorsDto.timezoneRevision).toBe(initialSettings.timezoneRevision);
    expect(visitorsDto.dataThrough).not.toBeNull();
    expect(visitorsDto.lastSucceededAt).not.toBeNull();
    expect(visitorsDto.value!).toBeGreaterThanOrEqual(beforeVisitors + 1);
    expect(findSource(afterDto, 'page_views').value!).toBeGreaterThanOrEqual(beforePageViews + 1);
    expect(findSource(afterDto, 'product_views').value!).toBeGreaterThanOrEqual(beforeProductViews + 1);
    expect(findSource(afterDto, 'model_starts').value!).toBeGreaterThanOrEqual(beforeModelStarts + 1);
    expect(findSource(afterDto, 'model_successes').value!).toBeGreaterThanOrEqual(beforeModelSuccesses + 1);

    const meanDto = findSource(afterDto, 'mean_load_duration_ms');
    expect(meanDto.state).toBe('ok');
    expect(meanDto.loadDurationSamples!).toBeGreaterThanOrEqual(beforeDurationSamples + 1);
    expect(meanDto.value).not.toBeNull();
    expect(afterDto.modelSuccessRate).toBeTruthy();
    expect(afterDto.modelSuccessRate?.coverage).toBe('full');
    expect(afterDto.modelSuccessRate?.value).not.toBeNull();
    expect(afterDto.modelSuccessRate!.value!).toBeGreaterThan(0);
    expect(afterDto.modelSuccessRate!.value!).toBeLessThanOrEqual(1);
    expect(afterDto.recomputableFrom).toBeNull();

    const visitorsOnlyRes = await adminReq.get(`/api/admin/stats?from=${siteToday}&to=${siteToday}&sources=visitors`);
    expect(visitorsOnlyRes.status()).toBe(200);
    const visitorsOnlyDto = StatsDTOSchema.parse(await visitorsOnlyRes.json());
    expect(visitorsOnlyDto.modelSuccessRate).toBeNull();

    // Product attribution: product page_views must be no_data (null, never 0)
    const productRes = await adminReq.get(`/api/admin/stats?from=${siteToday}&to=${siteToday}&productSlug=${observedSlug}`);
    expect(productRes.status()).toBe(200);
    const productDto = StatsDTOSchema.parse(await productRes.json());
    expect(findSource(productDto, 'visitors').value!).toBeGreaterThanOrEqual(1);
    expect(findSource(productDto, 'product_views').value!).toBeGreaterThanOrEqual(1);
    expect(findSource(productDto, 'model_starts').value!).toBeGreaterThanOrEqual(1);
    expect(findSource(productDto, 'model_successes').value!).toBeGreaterThanOrEqual(1);
    expect(findSource(productDto, 'page_views').state).toBe('no_data');
    expect(findSource(productDto, 'page_views').value).toBeNull();

    // 6. Verify SALES and EDITOR RBAC & pre-query trimming (E-66)
    const salesAllRes = await salesReq.get(`/api/admin/stats?from=${siteToday}&to=${siteToday}`);
    expect(salesAllRes.status()).toBe(200);
    const salesAllDto = StatsDTOSchema.parse(await salesAllRes.json());
    const salesSet = new Set(salesAllDto.sources.map((s) => s.source));
    expect(salesSet.has('chat_starts')).toBe(true);
    expect(salesSet.has('inquiries')).toBe(true);
    for (const forbidden of SALES_FORBIDDEN_SOURCES) {
      expect(salesSet.has(forbidden)).toBe(false);
    }
    expect((await salesReq.get('/api/admin/stats?sources=storage')).status()).toBe(403);
    expect((await salesReq.get('/api/admin/stats?sources=mail')).status()).toBe(403);
    const salesMixedRes = await salesReq.get(`/api/admin/stats?from=${siteToday}&to=${siteToday}&sources=visitors,storage,mail`);
    expect(salesMixedRes.status()).toBe(200);
    expect(StatsDTOSchema.parse(await salesMixedRes.json()).sources.map((s) => s.source)).toEqual(['visitors']);

    const editorAllRes = await editorReq.get(`/api/admin/stats?from=${siteToday}&to=${siteToday}`);
    expect(editorAllRes.status()).toBe(200);
    const editorAllDto = StatsDTOSchema.parse(await editorAllRes.json());
    expect(editorAllDto.sources.map((s) => s.source)).toEqual([...EDITOR_ONLY_SOURCES]);
    expect((await editorReq.get('/api/admin/stats?sources=chat_starts')).status()).toBe(403);
    expect((await editorReq.get('/api/admin/stats?sources=inquiries')).status()).toBe(403);
    expect((await editorReq.get('/api/admin/stats?sources=backup')).status()).toBe(403);
    const editorMixedRes = await editorReq.get(`/api/admin/stats?from=${siteToday}&to=${siteToday}&sources=visitors,chat_starts,storage`);
    expect(editorMixedRes.status()).toBe(200);
    expect(StatsDTOSchema.parse(await editorMixedRes.json()).sources.map((s) => s.source)).toEqual(['visitors']);

    // 7. Timezone switch -> browser TZ independence + historical revision label (E-55/E-58)
    const nextTimezone = initialSettings.timezone === 'America/New_York' ? 'Asia/Tokyo' : 'America/New_York';
    const patchRes = await adminReq.patch('/api/admin/settings/analytics', {
      headers: { origin: BASE },
      data: { timezone: nextTimezone, expectedVersion: initialSettings.version },
    });
    expect(patchRes.status()).toBe(200);
    const switched = AnalyticsSettingsUpdateDTOSchema.parse(await patchRes.json());
    expect(switched.timezone).toBe(nextTimezone);
    expect(switched.timezoneRevision).toBe(initialSettings.timezoneRevision + 1);
    expect(switched.recomputableFrom).not.toBeNull();

    try {
      // Before aggregate cron consumes pending recompute, current revision GET stats exposes live recomputableFrom while preserving role trimming
      const preJobAdminRes = await adminReq.get(`/api/admin/stats?sources=visitors`);
      expect(preJobAdminRes.status()).toBe(200);
      const preJobAdminDto = StatsDTOSchema.parse(await preJobAdminRes.json());
      expect(preJobAdminDto.recomputableFrom).not.toBeNull();
      const preJobEditorRes = await editorReq.get(`/api/admin/stats?sources=visitors,chat_starts,storage`);
      expect(preJobEditorRes.status()).toBe(200);
      const preJobEditorDto = StatsDTOSchema.parse(await preJobEditorRes.json());
      expect(preJobEditorDto.sources.map((s) => s.source)).toEqual(['visitors']);
      expect(preJobEditorDto.recomputableFrom).not.toBeNull();

      await runAggregateJob(adminReq, cronSecret!);
      const nextSiteToday = siteLocalDate(new Date(), nextTimezone);

      const ctxTokyo = await browser.newContext({ timezoneId: 'Asia/Tokyo', storageState: adminAuth });
      const ctxLa = await browser.newContext({ timezoneId: 'America/Los_Angeles', storageState: adminAuth });
      try {
        const pageTokyo = await ctxTokyo.newPage();
        const pageLa = await ctxLa.newPage();
        const qs = `?from=${nextSiteToday}&to=${nextSiteToday}&sources=visitors,page_views,model_starts`;
        const [tokyoRead, laRead] = await Promise.all([
          fetchStatsInBrowser(pageTokyo, qs),
          fetchStatsInBrowser(pageLa, qs),
        ]);
        expect(tokyoRead.browserTz).toBe('Asia/Tokyo');
        expect(laRead.browserTz).toBe('America/Los_Angeles');
        expect(tokyoRead.status).toBe(200);
        expect(laRead.status).toBe(200);

        const tokyoDto = StatsDTOSchema.parse(tokyoRead.json);
        const laDto = StatsDTOSchema.parse(laRead.json);
        expect(tokyoDto.recomputableFrom).toBeNull();
        expect(laDto.recomputableFrom).toBeNull();
        for (const source of ['visitors', 'page_views', 'model_starts'] as const) {
          expect(findSource(tokyoDto, source).timezone).toBe(nextTimezone);
          expect(findSource(tokyoDto, source).timezoneRevision).toBe(switched.timezoneRevision);
          expect(findSource(tokyoDto, source).value).toBe(findSource(laDto, source).value);
        }
      } finally {
        await ctxTokyo.close();
        await ctxLa.close();
      }

      // Querying prior revision explicitly keeps original timezone and revision label, with null recomputableFrom
      const prevRevRes = await adminReq.get(
        `/api/admin/stats?from=${siteToday}&to=${siteToday}&timezoneRevision=${initialSettings.timezoneRevision}&sources=visitors,model_starts`,
      );
      expect(prevRevRes.status()).toBe(200);
      const prevRevDto = StatsDTOSchema.parse(await prevRevRes.json());
      expect(findSource(prevRevDto, 'visitors').timezone).toBe(initialSettings.timezone);
      expect(findSource(prevRevDto, 'visitors').timezoneRevision).toBe(initialSettings.timezoneRevision);
      expect(findSource(prevRevDto, 'visitors').value!).toBeGreaterThanOrEqual(1);
      expect(prevRevDto.recomputableFrom).toBeNull();
    } finally {
      const restoreRes = await adminReq.patch('/api/admin/settings/analytics', {
        headers: { origin: BASE },
        data: { timezone: initialSettings.timezone, expectedVersion: switched.version },
      });
      expect(restoreRes.status()).toBe(200);
      await runAggregateJob(adminReq, cronSecret!);
    }
  } finally {
    await anonReq.dispose();
    await adminReq.dispose();
    await salesReq.dispose();
    await editorReq.dispose();
  }
  });
});
