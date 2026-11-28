import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { BASE } from './base-url';
import { expect, test } from './fixtures';
import { loadRunAuth } from './run-auth';
import { shiftLocalDate } from '../src/lib/analytics/aggregate-plan';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { buildStatsApiPath } from '../src/lib/client/ops';
import {
  formatDurationSamples,
  formatModelSuccessRate,
  formatSourceValue,
  mergeSnapshotSources,
  resolveModelSuccessRateDisplay,
  validateStatsDates,
} from '../src/components/admin/stats/StatsContainer';
import { AnalyticsSettingsDTOSchema } from '../src/lib/contracts/analytics';
import { StatsDTOSchema, type StatsDTO, type StatsSource, type StatsSourceDTO } from '../src/lib/contracts/ops';

// 文件顶层开启一次录像，供 CI 与本地复核真实流程视频/GIF（不能写在 describe 内，否则会强制新建 worker）。
test.use({
  video: process.env.E2E_BROWSER_CHANNEL === 'chrome' ? 'off' : 'on',
  ...(process.env.E2E_BROWSER_CHANNEL === 'chrome'
    ? {
        channel: 'chrome' as const,
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage', '--ozone-platform=headless'] },
      }
    : {}),
});

const PROBE_JS = readFileSync('docs/PackJoyU-开发文档/_run/density_probe.js', 'utf8');

const VIEWPORTS = [
  { width: 1920, height: 1080, label: '1920x1080' },
  { width: 1440, height: 900, label: '1440x900' },
  { width: 390, height: 844, label: '390x844' },
] as const;

const EDITOR_ALLOWED_SOURCES: readonly StatsSource[] = [
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

const EDITOR_FORBIDDEN_SOURCES: readonly StatsSource[] = [
  'chat_starts',
  'inquiries',
  'chat_conversations',
  'chat_messages',
  'chat_notifications',
  ...SALES_FORBIDDEN_SOURCES,
];

type Role = 'ADMIN' | 'SALES' | 'EDITOR';
type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;
const ROLE_SLOTS = { ADMIN: 'content-admin', SALES: 'sales', EDITOR: 'editor' } as const;

type CapturedEvent = { kind: string; productSlug?: string };
type DensityVerdict = Record<string, string | boolean>;
type DensityRaw = {
  verdict?: DensityVerdict;
  contentFound?: boolean;
  fill?: number;
  leftGap?: number;
  rightGap?: number;
  avail?: { left: number; right: number; width: number };
  interiorBand?: { px: number; ratio: number };
  overflowX?: number;
  mobile?: boolean;
  contract?: Record<string, unknown>;
  viewport?: { width: number; height: number };
  main?: string;
  rail?: Record<string, unknown> | null;
  counts?: Record<string, number>;
  growth?: unknown[];
  emptyTracks?: unknown[];
  gapOffenders?: unknown[];
  padOffenders?: unknown[];
  sparseBlocks?: unknown[];
};

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

type ObservedStatsResponse = {
  seq: number;
  url: string;
  status: number;
  rawText: string;
};

type StatsGetObserver = {
  latestSeq: () => number;
  nextAfter: (afterSeq: number, predicate?: (entry: ObservedStatsResponse) => boolean) => Promise<ObservedStatsResponse>;
};

/**
 * R5：在 Playwright Node 侧对 GET /api/admin/stats 建立纯透传观察器（route.fetch + 原样 fulfill），
 * 在交还页面前于 Node 侧拷贝响应体字节，彻底规避跨页路由切换时 Chromium CDP 回收响应缓冲导致的偶发 Network.getResponseBody。
 */
async function attachStatsGetObserver(page: Page): Promise<StatsGetObserver> {
  let seq = 0;
  const entries: ObservedStatsResponse[] = [];
  await page.route(
    (url) => url.pathname === '/api/admin/stats',
    async (route) => {
      const req = route.request();
      if (req.method() !== 'GET') {
        await route.continue();
        return;
      }
      const upstream = await route.fetch();
      const rawText = await upstream.text();
      seq += 1;
      entries.push({
        seq,
        url: req.url(),
        status: upstream.status(),
        rawText,
      });
      await route.fulfill({ response: upstream, body: rawText });
    },
  );
  return {
    latestSeq: () => seq,
    async nextAfter(afterSeq, predicate) {
      let matched: ObservedStatsResponse | undefined;
      await expect
        .poll(
          () => {
            matched = entries.find((item) => item.seq > afterSeq && (!predicate || predicate(item)));
            return Boolean(matched);
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      return matched!;
    },
  };
}

async function openRoleContext(
  browser: Browser,
  state: StorageState,
  opts?: {
    viewport?: { width: number; height: number };
    hasTouch?: boolean;
    isMobile?: boolean;
    observeStats?: boolean;
  },
): Promise<{ context: BrowserContext; page: Page; observer: StatsGetObserver | null }> {
  const context = await browser.newContext({
    storageState: state,
    baseURL: BASE,
    locale: 'en-US',
    viewport: opts?.viewport ?? { width: 1440, height: 900 },
    ...(opts?.hasTouch ? { hasTouch: true } : {}),
    ...(opts?.isMobile ? { isMobile: true } : {}),
  });
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  const page = await context.newPage();
  const observer = opts?.observeStats === false ? null : await attachStatsGetObserver(page);
  return { context, page, observer };
}

/** 从角色可访问的起始后台页点击可见控件 stats-link 进入 /admin/stats（窄屏先点开抽屉菜单）。 */
async function navigateViaStatsLink(
  page: Page,
  observer: StatsGetObserver,
  startPath: string,
  mobile: boolean,
): Promise<{ status: number; url: string; dto: StatsDTO }> {
  await page.goto(startPath);
  if (mobile) {
    const menuBtn = page.locator('button.adm-menu');
    await expect(menuBtn).toBeVisible();
    await menuBtn.click();
  }
  const nav = page.getByRole('navigation', { name: '后台导航' });
  const statsLink = nav.getByTestId('stats-link');
  await expect(statsLink).toBeVisible();

  const beforeClickSeq = observer.latestSeq();
  await statsLink.click();
  await expect(page).toHaveURL(/\/admin\/stats$/);
  const statsEntry = await observer.nextAfter(beforeClickSeq);
  expect(statsEntry.status).toBe(200);
  const dto = StatsDTOSchema.parse(JSON.parse(statsEntry.rawText));
  await expect(page.getByRole('heading', { level: 1, name: '数据看板' })).toBeVisible();
  await expect(page.getByTestId('stats-timezone')).toContainText(dto.sources[0]!.timezone);
  if (!mobile) {
    await expect(statsLink).toHaveAttribute('aria-current', 'page');
  }
  return { status: statsEntry.status, url: statsEntry.url, dto };
}

async function runWorkDensityProbe(page: Page): Promise<DensityRaw> {
  return page.evaluate(
    ({ src, opts }) => {
      (0, eval)(src);
      const fn = (globalThis as { densityProbe?: (o: unknown) => DensityRaw }).densityProbe;
      if (!fn) throw new Error('densityProbe not injected');
      return fn(opts);
    },
    {
      src: PROBE_JS,
      opts: { type: 'work', density: 7, gutter: 16, gap: 16, pad: 16, main: 'main.adm-main' },
    },
  );
}

function safeDensityReport(raw: DensityRaw) {
  return {
    verdict: raw.verdict,
    contentFound: raw.contentFound,
    fill: raw.fill,
    leftGap: raw.leftGap,
    rightGap: raw.rightGap,
    avail: raw.avail,
    interiorBand: raw.interiorBand,
    overflowX: raw.overflowX,
    mobile: raw.mobile,
    contract: raw.contract,
    viewport: raw.viewport,
    main: raw.main,
    rail: raw.rail,
    counts: raw.counts,
  };
}

test.describe('M6-T4 core stats dashboard page', () => {
  test.describe.configure({ timeout: 180_000 });

  test('M6-T4 E-61/E-63/E-66: 真实同意+访问+3D GLB+五分钟作业 -> stats-link导航、筛选/刷新与三角色权限矩阵', async ({
    browser,
    playwright,
  }) => {
    const cronSecret = process.env.CRON_SECRET;
    test.skip(!cronSecret, 'CRON_SECRET required');

    // 0. 纯客户端格式化与路径构造规则复核（E-63 零值 vs 无样本、同键旧值保留、查询串构造）
    expect(buildStatsApiPath({})).toBe('/api/admin/stats');
    expect(
      buildStatsApiPath({
        from: '2026-11-01',
        to: '2026-11-02',
        productSlug: 'corrugated-boxes',
        sources: ['visitors', 'page_views'],
      }),
    ).toBe('/api/admin/stats?from=2026-11-01&to=2026-11-02&productSlug=corrugated-boxes&sources=visitors%2Cpage_views');
    expect(formatModelSuccessRate({ value: null, coverage: 'full' })).toBe('—（无发起样本）');
    expect(formatModelSuccessRate({ value: 0, coverage: 'full' })).toBe('0%');
    expect(formatModelSuccessRate({ value: 0.75, coverage: 'full' })).toBe('75%');
    expect(
      formatSourceValue({
        source: 'mean_load_duration_ms',
        state: 'no_data',
        value: null,
        timezone: 'UTC',
        timezoneRevision: 1,
        dataThrough: null,
        queriedAt: '2026-11-27T00:00:00.000Z',
        lastSucceededAt: null,
        coverage: 'unavailable',
        loadDurationSamples: 0,
      }),
    ).toBe('No data yet');
    expect(
      formatSourceValue({
        source: 'visitors',
        state: 'zero',
        value: 0,
        timezone: 'UTC',
        timezoneRevision: 1,
        dataThrough: '2026-11-27T00:00:00.000Z',
        queriedAt: '2026-11-27T00:00:00.000Z',
        lastSucceededAt: '2026-11-27T00:00:00.000Z',
        coverage: 'full',
      }),
    ).toBe('0');
    expect(validateStatsDates('2026-11-10', '2026-11-01').toError).toBeTruthy();

    const prevSnapshot: StatsDTO = {
      sources: [
        {
          source: 'visitors',
          state: 'ok',
          value: 12,
          timezone: 'UTC',
          timezoneRevision: 1,
          dataThrough: '2026-11-27T01:00:00.000Z',
          queriedAt: '2026-11-27T01:01:00.000Z',
          lastSucceededAt: '2026-11-27T01:00:00.000Z',
          coverage: 'full',
        },
      ],
      modelSuccessRate: null,
      recomputableFrom: null,
    };
    const failedCurrent: StatsDTO = {
      sources: [
        {
          source: 'visitors',
          state: 'query_failed',
          value: null,
          timezone: 'UTC',
          timezoneRevision: 1,
          dataThrough: null,
          queriedAt: '2026-11-27T02:00:00.000Z',
          lastSucceededAt: null,
          coverage: 'unavailable',
        },
      ],
      modelSuccessRate: null,
      recomputableFrom: null,
    };
    const merged = mergeSnapshotSources(failedCurrent, prevSnapshot);
    expect(merged.retainedSources.has('visitors')).toBe(true);
    expect(merged.dto.sources[0]?.value).toBe(12);
    expect(merged.dto.sources[0]?.lastSucceededAt).toBe('2026-11-27T01:00:00.000Z');

    // R3 纯规则复核：跨 timezoneRevision 的单源失败不得合并旧版本的数值、样本数或时间
    const prevRev1WithDuration: StatsDTO = {
      sources: [
        {
          source: 'visitors',
          state: 'ok',
          value: 25,
          timezone: 'UTC',
          timezoneRevision: 1,
          dataThrough: '2026-11-27T01:00:00.000Z',
          queriedAt: '2026-11-27T01:01:00.000Z',
          lastSucceededAt: '2026-11-27T01:00:00.000Z',
          coverage: 'full',
        },
        {
          source: 'mean_load_duration_ms',
          state: 'ok',
          value: 380,
          timezone: 'UTC',
          timezoneRevision: 1,
          dataThrough: '2026-11-27T01:00:00.000Z',
          queriedAt: '2026-11-27T01:01:00.000Z',
          lastSucceededAt: '2026-11-27T01:00:00.000Z',
          coverage: 'full',
          loadDurationSamples: 9,
        },
      ],
      modelSuccessRate: null,
      recomputableFrom: null,
    };
    const failedRev2: StatsDTO = {
      sources: [
        {
          source: 'visitors',
          state: 'query_failed',
          value: null,
          timezone: 'Asia/Tokyo',
          timezoneRevision: 2,
          dataThrough: null,
          queriedAt: '2026-11-27T03:00:00.000Z',
          lastSucceededAt: null,
          coverage: 'unavailable',
        },
        {
          source: 'mean_load_duration_ms',
          state: 'query_failed',
          value: null,
          timezone: 'Asia/Tokyo',
          timezoneRevision: 2,
          dataThrough: null,
          queriedAt: '2026-11-27T03:00:00.000Z',
          lastSucceededAt: null,
          coverage: 'unavailable',
          loadDurationSamples: 0,
        },
      ],
      modelSuccessRate: null,
      recomputableFrom: null,
    };
    const crossRevMerged = mergeSnapshotSources(failedRev2, prevRev1WithDuration);
    expect(crossRevMerged.retainedSources.size).toBe(0);
    expect(crossRevMerged.dto.sources[0]?.value).toBeNull();
    expect(crossRevMerged.dto.sources[0]?.dataThrough).toBeNull();
    expect(crossRevMerged.dto.sources[1]?.value).toBeNull();
    expect(crossRevMerged.dto.sources[1]?.dataThrough).toBeNull();
    expect(formatSourceValue(crossRevMerged.dto.sources[1]!)).toBe('查询失败（无快照）');
    expect(formatDurationSamples(crossRevMerged.dto.sources[1]!)).toBe('—');

    // R4 纯规则复核：覆盖查询失败、旧值、确实未接入、真实无样本（no_data / zero）与有分母 0%，失败/未接入不断言 0 starts
    const make3dPair = (
      state: StatsSourceDTO['state'],
      startsVal: number | null,
      succVal: number | null,
      coverage: StatsSourceDTO['coverage'],
    ): { startsSource: StatsSourceDTO; successesSource: StatsSourceDTO } => ({
      startsSource: {
        source: 'model_starts',
        state,
        value: startsVal,
        timezone: 'UTC',
        timezoneRevision: 1,
        dataThrough: startsVal !== null ? '2026-11-27T01:00:00.000Z' : null,
        queriedAt: '2026-11-27T01:01:00.000Z',
        lastSucceededAt: startsVal !== null ? '2026-11-27T01:00:00.000Z' : null,
        coverage,
      },
      successesSource: {
        source: 'model_successes',
        state: succVal === 0 && state === 'ok' ? 'zero' : state,
        value: succVal,
        timezone: 'UTC',
        timezoneRevision: 1,
        dataThrough: succVal !== null ? '2026-11-27T01:00:00.000Z' : null,
        queriedAt: '2026-11-27T01:01:00.000Z',
        lastSucceededAt: succVal !== null ? '2026-11-27T01:00:00.000Z' : null,
        coverage,
      },
    });

    const failedRateDisplay = resolveModelSuccessRateDisplay(
      { value: null, coverage: 'unavailable' },
      make3dPair('query_failed', null, null, 'unavailable'),
    );
    expect(failedRateDisplay.badgeState).toBe('query_failed');
    expect(failedRateDisplay.valueText).toBe('查询失败（无快照）');
    expect(failedRateDisplay.pairText).not.toContain('0 starts');

    const staleRateDisplay = resolveModelSuccessRateDisplay(
      { value: 0.75, coverage: 'full' },
      make3dPair('stale', 4, 3, 'full'),
    );
    expect(staleRateDisplay.badgeState).toBe('stale');
    expect(staleRateDisplay.isAlert).toBe(true);
    expect(staleRateDisplay.valueText).toBe('75%');
    expect(staleRateDisplay.pairText).toBe('3 / 4 starts');

    const disconnectedRateDisplay = resolveModelSuccessRateDisplay(
      { value: null, coverage: 'unavailable' },
      make3dPair('not_connected', null, null, 'unavailable'),
    );
    expect(disconnectedRateDisplay.badgeState).toBe('not_connected');
    expect(disconnectedRateDisplay.valueText).toBe('Not connected: model_success_rate');
    expect(disconnectedRateDisplay.pairText).not.toContain('0 starts');

    const noDataRateDisplay = resolveModelSuccessRateDisplay(
      { value: null, coverage: 'unavailable' },
      make3dPair('no_data', null, null, 'unavailable'),
    );
    expect(noDataRateDisplay.badgeState).toBe('no_data');
    expect(noDataRateDisplay.valueText).toBe('—（无发起样本）');
    expect(noDataRateDisplay.pairText).toBe('No data yet（尚无配对样本）');

    const zeroStartsRateDisplay = resolveModelSuccessRateDisplay(
      { value: null, coverage: 'full' },
      make3dPair('zero', 0, 0, 'full'),
    );
    expect(zeroStartsRateDisplay.badgeState).toBe('no_data');
    expect(zeroStartsRateDisplay.valueText).toBe('—（无发起样本）');
    expect(zeroStartsRateDisplay.pairText).toBe('0 starts（无配对分母）');

    const zeroPctWithDenomDisplay = resolveModelSuccessRateDisplay(
      { value: 0, coverage: 'full' },
      make3dPair('ok', 5, 0, 'full'),
    );
    expect(zeroPctWithDenomDisplay.badgeState).toBe('zero');
    expect(zeroPctWithDenomDisplay.valueText).toBe('0%');
    expect(zeroPctWithDenomDisplay.pairText).toBe('0 / 5 starts');

    // 1. 加载 globalSetup 真实登录的三个角色槽
    const states: Record<Role, StorageState> = {
      ADMIN: await loadRunAuth(ROLE_SLOTS.ADMIN, BASE, playwright.request),
      SALES: await loadRunAuth(ROLE_SLOTS.SALES, BASE, playwright.request),
      EDITOR: await loadRunAuth(ROLE_SLOTS.EDITOR, BASE, playwright.request),
    };

    const anonReq = await playwright.request.newContext({ baseURL: BASE });
    const adminReq = await playwright.request.newContext({ baseURL: BASE, storageState: states.ADMIN });
    const salesReq = await playwright.request.newContext({ baseURL: BASE, storageState: states.SALES });
    const editorReq = await playwright.request.newContext({ baseURL: BASE, storageState: states.EDITOR });

    try {
      // 未登录：页面重定向登录，接口 401
      const anonPageRes = await anonReq.get('/admin/stats', { maxRedirects: 0 });
      expect([302, 303, 307, 308]).toContain(anonPageRes.status());
      const anonApiRes = await anonReq.get('/api/admin/stats');
      expect(anonApiRes.status()).toBe(401);
      expect(anonApiRes.headers()['cache-control']).toContain('no-store');

      // 2. 读取当前站点时区与聚合基准
      const settingsRes = await adminReq.get('/api/admin/settings/analytics');
      expect(settingsRes.status()).toBe(200);
      const settings = AnalyticsSettingsDTOSchema.parse(await settingsRes.json());
      const siteToday = siteLocalDate(new Date(), settings.timezone);

      await runAggregateJob(adminReq, cronSecret!);
      const baselineRes = await adminReq.get(`/api/admin/stats?from=${siteToday}&to=${siteToday}`);
      expect(baselineRes.status()).toBe(200);
      const baselineDto = StatsDTOSchema.parse(await baselineRes.json());
      const beforeVisitors = findSource(baselineDto, 'visitors').value ?? 0;
      const beforePageViews = findSource(baselineDto, 'page_views').value ?? 0;
      const beforeProductViews = findSource(baselineDto, 'product_views').value ?? 0;
      const beforeModelStarts = findSource(baselineDto, 'model_starts').value ?? 0;
      const beforeModelSuccesses = findSource(baselineDto, 'model_successes').value ?? 0;
      const beforeSamples = findSource(baselineDto, 'mean_load_duration_ms').loadDurationSamples ?? 0;

      // 3. E-61 真实访客产品动作：从 /en 首页点击同意 -> 点击导航进入 /en/products -> 真实加载 GLB 产出 start/success
      const visitorCtx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
      await visitorCtx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
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
            { timeout: 60_000 },
          )
          .toBe(true);
      } finally {
        await visitorCtx.close();
      }

      const observedSlug =
        acceptedEvents.find((e) => e.kind === 'model_load_success' && e.productSlug)?.productSlug ??
        acceptedEvents.find((e) => e.productSlug)?.productSlug;
      expect(observedSlug).toBeTruthy();

      // 4. 提交真实五分钟聚合作业
      await runAggregateJob(adminReq, cronSecret!);

      // 5. ADMIN 真实登录后从后台壳点击可见控件 stats-link 进入 /admin/stats，核核心指标、样本数、时区与筛选/刷新
      const adminSession = await openRoleContext(browser, states.ADMIN, { viewport: { width: 1440, height: 900 } });
      try {
        const adminPage = adminSession.page;
        const adminObserver = adminSession.observer!;
        let forbiddenMutations = 0;
        adminPage.on('request', (req) => {
          const p = new URL(req.url()).pathname;
          if (p.startsWith('/api/admin/cron/') || p === '/api/internal/ops-report') {
            forbiddenMutations += 1;
          }
        });

        const { dto: initialDto } = await navigateViaStatsLink(adminPage, adminObserver, '/admin/inquiries', false);
        expect(initialDto.sources).toHaveLength(17);

        // 核对日期输入框自动填充为站点今日（非浏览器本地硬算）
        await expect(adminPage.getByTestId('stats-filter-from')).toHaveValue(siteToday);
        await expect(adminPage.getByTestId('stats-filter-to')).toHaveValue(siteToday);
        await expect(adminPage.getByTestId('stats-timezone')).toContainText(
          `${settings.timezone} (rev ${settings.timezoneRevision})`,
        );

        const afterVisitors = findSource(initialDto, 'visitors').value!;
        const afterPageViews = findSource(initialDto, 'page_views').value!;
        const afterProductViews = findSource(initialDto, 'product_views').value!;
        const afterModelStarts = findSource(initialDto, 'model_starts').value!;
        const afterModelSuccesses = findSource(initialDto, 'model_successes').value!;
        const afterDuration = findSource(initialDto, 'mean_load_duration_ms');
        expect(afterVisitors).toBeGreaterThanOrEqual(beforeVisitors + 1);
        expect(afterPageViews).toBeGreaterThanOrEqual(beforePageViews + 1);
        expect(afterProductViews).toBeGreaterThanOrEqual(beforeProductViews + 1);
        expect(afterModelStarts).toBeGreaterThanOrEqual(beforeModelStarts + 1);
        expect(afterModelSuccesses).toBeGreaterThanOrEqual(beforeModelSuccesses + 1);
        expect(afterDuration.loadDurationSamples!).toBeGreaterThanOrEqual(beforeSamples + 1);

        // 页面可见数值与 DTO 一致，样本数与成功率可见（E-61、E-63）
        await expect(adminPage.getByTestId('stats-value-visitors')).toHaveText(afterVisitors.toLocaleString('en-US'));
        await expect(adminPage.getByTestId('stats-value-page_views')).toHaveText(afterPageViews.toLocaleString('en-US'));
        await expect(adminPage.getByTestId('stats-value-product_views')).toHaveText(afterProductViews.toLocaleString('en-US'));
        await expect(adminPage.getByTestId('stats-value-model_starts')).toHaveText(afterModelStarts.toLocaleString('en-US'));
        await expect(adminPage.getByTestId('stats-value-model_successes')).toHaveText(
          afterModelSuccesses.toLocaleString('en-US'),
        );
        await expect(adminPage.getByTestId('stats-duration-samples')).toContainText(
          String(afterDuration.loadDurationSamples),
        );
        await expect(adminPage.getByTestId('stats-model-success-rate')).toBeVisible();
        await expect(adminPage.getByTestId('stats-svg-chart')).toBeVisible();
        await expect(adminPage.locator('[data-testid="stats-table"] tbody tr')).toHaveCount(17);

        // 产品筛选控件：选择 observedSlug 发真实 GET /api/admin/stats?...&productSlug=<slug>
        const beforeProdSeq = adminObserver.latestSeq();
        await adminPage.getByTestId('stats-filter-product').selectOption(observedSlug!);
        const productEntry = await adminObserver.nextAfter(
          beforeProdSeq,
          (entry) => new URL(entry.url).searchParams.get('productSlug') === observedSlug,
        );
        expect(productEntry.status).toBe(200);
        const productDto = StatsDTOSchema.parse(JSON.parse(productEntry.rawText));
        expect(findSource(productDto, 'product_views').value!).toBeGreaterThanOrEqual(1);
        expect(findSource(productDto, 'model_starts').value!).toBeGreaterThanOrEqual(1);
        expect(findSource(productDto, 'page_views').state).toBe('no_data');
        await expect(adminPage.getByTestId('stats-value-page_views')).toHaveText('No data yet');

        // 切回全部产品，再测无样本历史自然日（E-63 无样本为 null 而非 0%）
        const beforeResetSeq = adminObserver.latestSeq();
        await adminPage.getByTestId('stats-filter-product').selectOption('');
        const resetEntry = await adminObserver.nextAfter(
          beforeResetSeq,
          (entry) => !new URL(entry.url).searchParams.has('productSlug'),
        );
        expect(resetEntry.status).toBe(200);

        const emptyHistoryDay = shiftLocalDate(siteToday, -7);
        const beforeHistorySeq = adminObserver.latestSeq();
        await adminPage.getByTestId('stats-filter-from').fill(emptyHistoryDay);
        await adminPage.getByTestId('stats-filter-to').fill(emptyHistoryDay);
        const dateEntry = await adminObserver.nextAfter(
          beforeHistorySeq,
          (entry) =>
            new URL(entry.url).searchParams.get('from') === emptyHistoryDay &&
            new URL(entry.url).searchParams.get('to') === emptyHistoryDay,
        );
        expect(dateEntry.status).toBe(200);
        const dateDto = StatsDTOSchema.parse(JSON.parse(dateEntry.rawText));
        const historyDuration = findSource(dateDto, 'mean_load_duration_ms');
        if (historyDuration.loadDurationSamples === 0) {
          expect(historyDuration.value).toBeNull();
          expect(dateDto.modelSuccessRate?.value).toBeNull();
          await expect(adminPage.getByTestId('stats-value-model_success_rate')).toHaveText('—（无发起样本）');
        }

        // 恢复站点今日，验证 ADMIN「仅系统运维」范围切换与手动「刷新」控件
        const beforeTodaySeq = adminObserver.latestSeq();
        await adminPage.getByTestId('stats-filter-from').fill(siteToday);
        await adminPage.getByTestId('stats-filter-to').fill(siteToday);
        const backTodayEntry = await adminObserver.nextAfter(
          beforeTodaySeq,
          (entry) =>
            new URL(entry.url).searchParams.get('from') === siteToday &&
            new URL(entry.url).searchParams.get('to') === siteToday,
        );
        expect(backTodayEntry.status).toBe(200);

        const beforeOpsSeq = adminObserver.latestSeq();
        await adminPage.getByTestId('stats-scope-ops').click();
        const opsOnlyEntry = await adminObserver.nextAfter(
          beforeOpsSeq,
          (entry) => new URL(entry.url).searchParams.get('sources') === 'api_requests,api_errors,mail,storage,backup',
        );
        expect(opsOnlyEntry.status).toBe(200);
        await expect(adminPage.getByTestId('stats-section-ops')).toBeVisible();
        await expect(adminPage.getByTestId('stats-section-core')).toHaveCount(0);
        await expect(adminPage.locator('[data-testid="stats-table"] tbody tr')).toHaveCount(5);

        const beforeAllSeq = adminObserver.latestSeq();
        await adminPage.getByTestId('stats-scope-all').click();
        const allScopeEntry = await adminObserver.nextAfter(
          beforeAllSeq,
          (entry) => !new URL(entry.url).searchParams.has('sources'),
        );
        expect(allScopeEntry.status).toBe(200);

        const beforeRefreshSeq = adminObserver.latestSeq();
        await adminPage.getByTestId('stats-refresh').click();
        expect((await adminObserver.nextAfter(beforeRefreshSeq)).status).toBe(200);
        expect(forbiddenMutations, '手动刷新与筛选绝不触发 cron 或 ops-report').toBe(0);
      } finally {
        await adminSession.context.close();
      }

      // 6. SALES 页面仅呈现核心+业务授权来源（12 项），无运维分区，直接越权请求 403 且混合响应无隐藏计数（E-66 / R5）
      const salesSession = await openRoleContext(browser, states.SALES, { viewport: { width: 1440, height: 900 } });
      try {
        const salesPage = salesSession.page;
        const { url: salesStatsUrl, dto: salesDto } = await navigateViaStatsLink(
          salesPage,
          salesSession.observer!,
          '/admin/inquiries',
          false,
        );
        expect(new URL(salesStatsUrl).pathname).toBe('/api/admin/stats');
        expect(salesDto.sources).toHaveLength(12);
        const salesNames = new Set(salesDto.sources.map((s) => s.source));
        for (const forbidden of SALES_FORBIDDEN_SOURCES) {
          expect(salesNames.has(forbidden)).toBe(false);
          await expect(salesPage.getByTestId(`stats-source-${forbidden}`)).toHaveCount(0);
          await expect(salesPage.getByTestId(`stats-row-${forbidden}`)).toHaveCount(0);
        }
        await expect(salesPage.getByTestId('stats-section-core')).toBeVisible();
        await expect(salesPage.getByTestId('stats-section-business')).toBeVisible();
        await expect(salesPage.getByTestId('stats-section-ops')).toHaveCount(0);
        await expect(salesPage.getByTestId('stats-scope-ops')).toHaveCount(0);
        await expect(salesPage.locator('[data-testid="stats-table"] tbody tr')).toHaveCount(12);

        expect((await salesReq.get('/api/admin/stats?sources=storage')).status()).toBe(403);
        expect((await salesReq.get('/api/admin/stats?sources=api_errors,mail,backup')).status()).toBe(403);
        const salesMixedRes = await salesReq.get(
          `/api/admin/stats?from=${siteToday}&to=${siteToday}&sources=visitors,inquiries,storage,backup`,
        );
        expect(salesMixedRes.status()).toBe(200);
        const salesMixedRaw = (await salesMixedRes.json()) as Record<string, unknown>;
        expectMixedStatsEnvelope(salesMixedRaw);
        const salesMixedDto = StatsDTOSchema.parse(salesMixedRaw);
        expect(salesMixedDto.sources.map((s) => s.source)).toEqual(['visitors', 'inquiries']);
      } finally {
        await salesSession.context.close();
      }

      // 7. EDITOR 页面仅呈现公开流量/产品/3D 来源（7 项），无业务与运维分区，直接越权请求 403 且无隐藏计数（E-66）
      const editorSession = await openRoleContext(browser, states.EDITOR, { viewport: { width: 1440, height: 900 } });
      try {
        const editorPage = editorSession.page;
        const { dto: editorDto } = await navigateViaStatsLink(
          editorPage,
          editorSession.observer!,
          '/admin/specs',
          false,
        );
        expect(editorDto.sources.map((s) => s.source)).toEqual([...EDITOR_ALLOWED_SOURCES]);
        for (const forbidden of EDITOR_FORBIDDEN_SOURCES) {
          await expect(editorPage.getByTestId(`stats-source-${forbidden}`)).toHaveCount(0);
          await expect(editorPage.getByTestId(`stats-row-${forbidden}`)).toHaveCount(0);
        }
        await expect(editorPage.getByTestId('stats-section-core')).toBeVisible();
        await expect(editorPage.getByTestId('stats-section-business')).toHaveCount(0);
        await expect(editorPage.getByTestId('stats-section-ops')).toHaveCount(0);
        await expect(editorPage.getByTestId('stats-scope-ops')).toHaveCount(0);
        await expect(editorPage.locator('[data-testid="stats-table"] tbody tr')).toHaveCount(7);

        expect((await editorReq.get('/api/admin/stats?sources=inquiries')).status()).toBe(403);
        expect((await editorReq.get('/api/admin/stats?sources=chat_starts')).status()).toBe(403);
        expect((await editorReq.get('/api/admin/stats?sources=storage')).status()).toBe(403);
        const editorMixedRes = await editorReq.get(
          `/api/admin/stats?from=${siteToday}&to=${siteToday}&sources=visitors,inquiries,chat_starts,storage`,
        );
        expect(editorMixedRes.status()).toBe(200);
        const editorMixedRaw = (await editorMixedRes.json()) as Record<string, unknown>;
        expectMixedStatsEnvelope(editorMixedRaw);
        const editorMixedDto = StatsDTOSchema.parse(editorMixedRaw);
        expect(editorMixedDto.sources.map((s) => s.source)).toEqual(['visitors']);
      } finally {
        await editorSession.context.close();
      }

      // 8. R1 / R2 / R3 / R4 真实挂载 DOM 回归测试（受控响应与延迟验证）
      const regSession = await openRoleContext(browser, states.ADMIN, {
        viewport: { width: 1440, height: 900 },
        observeStats: false,
      });
      try {
        const regPage = regSession.page;
        type MockReply =
          | { kind: 'dto'; dto: StatsDTO; hold?: Promise<void> }
          | { kind: 'error'; status: 403 | 503; code: 'forbidden' | 'service_unavailable'; message: string }
          | { kind: 'network_error' };

        const makeMockDto = (opts: {
          timezone?: string;
          rev?: number;
          queriedAt?: string;
          dataThrough?: string | null;
          visitors?: { state: StatsSourceDTO['state']; value: number | null };
          starts?: { state: StatsSourceDTO['state']; value: number | null; coverage?: StatsSourceDTO['coverage'] };
          successes?: { state: StatsSourceDTO['state']; value: number | null; coverage?: StatsSourceDTO['coverage'] };
          duration?: {
            state: StatsSourceDTO['state'];
            value: number | null;
            samples: number;
            coverage?: StatsSourceDTO['coverage'];
          };
          rate?: StatsDTO['modelSuccessRate'];
          apiRequests?: { state: StatsSourceDTO['state']; value: number | null };
        }): StatsDTO => {
          const tz = opts.timezone ?? 'UTC';
          const rev = opts.rev ?? 1;
          const queriedAt = opts.queriedAt ?? '2026-11-20T12:00:00.000Z';
          const through = opts.dataThrough === undefined ? '2026-11-20T11:55:00.000Z' : opts.dataThrough;
          const v = opts.visitors ?? { state: 'ok', value: 11 };
          const st = opts.starts ?? { state: 'ok', value: 4, coverage: 'full' };
          const sc = opts.successes ?? { state: 'ok', value: 3, coverage: 'full' };
          const dur = opts.duration ?? { state: 'ok', value: 420, samples: 9, coverage: 'full' };
          const sources: StatsSourceDTO[] = [
            {
              source: 'visitors',
              state: v.state,
              value: v.value,
              timezone: tz,
              timezoneRevision: rev,
              dataThrough: v.value !== null ? through : null,
              queriedAt,
              lastSucceededAt: v.value !== null ? through : null,
              coverage: v.value !== null ? 'full' : 'unavailable',
            },
            {
              source: 'model_starts',
              state: st.state,
              value: st.value,
              timezone: tz,
              timezoneRevision: rev,
              dataThrough: st.value !== null ? through : null,
              queriedAt,
              lastSucceededAt: st.value !== null ? through : null,
              coverage: st.coverage ?? (st.value !== null ? 'full' : 'unavailable'),
            },
            {
              source: 'model_successes',
              state: sc.state,
              value: sc.value,
              timezone: tz,
              timezoneRevision: rev,
              dataThrough: sc.value !== null ? through : null,
              queriedAt,
              lastSucceededAt: sc.value !== null ? through : null,
              coverage: sc.coverage ?? (sc.value !== null ? 'full' : 'unavailable'),
            },
            {
              source: 'mean_load_duration_ms',
              state: dur.state,
              value: dur.value,
              timezone: tz,
              timezoneRevision: rev,
              dataThrough: dur.value !== null ? through : null,
              queriedAt,
              lastSucceededAt: dur.value !== null ? through : null,
              coverage: dur.coverage ?? (dur.value !== null ? 'full' : 'unavailable'),
              loadDurationSamples: dur.samples,
            },
          ];
          if (opts.apiRequests) {
            sources.push({
              source: 'api_requests',
              state: opts.apiRequests.state,
              value: opts.apiRequests.value,
              timezone: tz,
              timezoneRevision: rev,
              dataThrough: opts.apiRequests.value !== null ? through : null,
              queriedAt,
              lastSucceededAt: opts.apiRequests.value !== null ? through : null,
              coverage: opts.apiRequests.value !== null ? 'full' : 'unavailable',
            });
          }
          const computedRate =
            opts.rate !== undefined
              ? opts.rate
              : st.value !== null && sc.value !== null && st.value > 0
                ? { value: sc.value / st.value, coverage: 'full' as const }
                : { value: null, coverage: st.value === 0 ? ('full' as const) : ('unavailable' as const) };
          return StatsDTOSchema.parse({
            sources,
            modelSuccessRate: computedRate,
            recomputableFrom: null,
          });
        };

        const seenStatsUrls: string[] = [];
        let replyHandler: (url: URL) => MockReply = () => ({ kind: 'dto', dto: makeMockDto({}) });

        await regPage.route(
          (url) => url.pathname === '/api/admin/stats',
          async (route) => {
            const reqUrl = new URL(route.request().url());
            seenStatsUrls.push(reqUrl.pathname + reqUrl.search);
            const plan = replyHandler(reqUrl);
            if (plan.kind === 'dto') {
              if (plan.hold) await plan.hold;
              await route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: { 'cache-control': 'private, no-store' },
                body: JSON.stringify(plan.dto),
              });
              return;
            }
            if (plan.kind === 'network_error') {
              await route.abort('failed');
              return;
            }
            await route.fulfill({
              status: plan.status,
              contentType: 'application/json',
              headers: { 'cache-control': 'private, no-store' },
              body: JSON.stringify({ error: plan.code, message: plan.message }),
            });
          },
        );

        // 8.1 R2：A (visitors=11) -> B (visitors=88) -> 切回 A 并延迟最后一个响应，A 筛选标签下绝不出现 B 的 88
        let releaseDelayedA!: () => void;
        const delayedAPromise = new Promise<void>((resolve) => {
          releaseDelayedA = resolve;
        });
        let aRequestCount = 0;
        replyHandler = (url) => {
          if (url.searchParams.get('productSlug') === observedSlug) {
            return { kind: 'dto', dto: makeMockDto({ visitors: { state: 'ok', value: 88 } }) };
          }
          aRequestCount += 1;
          if (aRequestCount === 1) {
            return { kind: 'dto', dto: makeMockDto({ visitors: { state: 'ok', value: 11 } }) };
          }
          return {
            kind: 'dto',
            dto: makeMockDto({ visitors: { state: 'ok', value: 15 } }),
            hold: delayedAPromise,
          };
        };

        await regPage.goto('/admin/stats');
        await expect(regPage.getByTestId('stats-value-visitors')).toHaveText('11');
        await expect(regPage.getByTestId('stats-date-range')).toContainText('2026-11-20 → 2026-11-20');

        await regPage.getByTestId('stats-filter-product').selectOption(observedSlug!);
        await expect(regPage.getByTestId('stats-value-visitors')).toHaveText('88');
        await expect(regPage.getByTestId('stats-svg-chart')).toContainText('88');

        await regPage.getByTestId('stats-filter-product').selectOption('');
        await expect.poll(() => aRequestCount).toBe(2);
        // 最后一个 A 响应仍在延迟中：筛选器已是全部产品（A），只显示 A 自身的快照 11，绝不出现 B 的 88
        await expect(regPage.getByTestId('stats-filter-product')).toHaveValue('');
        await expect(regPage.getByTestId('stats-value-visitors')).toHaveText('11');
        await expect(regPage.getByTestId('stats-svg-chart')).not.toContainText('88');
        await expect(regPage.getByTestId('stats-row-visitors')).not.toContainText('88');

        releaseDelayedA();
        await expect(regPage.getByTestId('stats-value-visitors')).toHaveText('15');

        // R2 补充：切向未缓存查询 B 时挂起 B，等待期间显示加载态而非旧计数；切回 A 后迟到的 B 响应绝不覆盖当前查询 A
        let releaseLateB!: () => void;
        const lateBPromise = new Promise<void>((resolve) => {
          releaseLateB = resolve;
        });
        let lateBSeen = 0;
        replyHandler = (url) => {
          if (url.searchParams.get('from') === '2026-11-18') {
            lateBSeen += 1;
            return {
              kind: 'dto',
              dto: makeMockDto({ visitors: { state: 'ok', value: 99 } }),
              hold: lateBPromise,
            };
          }
          return { kind: 'dto', dto: makeMockDto({ visitors: { state: 'ok', value: 16 } }) };
        };
        await regPage.getByTestId('stats-filter-from').fill('2026-11-18');
        await regPage.getByTestId('stats-filter-to').fill('2026-11-18');
        await expect.poll(() => lateBSeen).toBeGreaterThanOrEqual(1);
        await expect(regPage.getByTestId('stats-loading')).toBeVisible();
        await expect(regPage.getByTestId('stats-source-visitors')).toHaveCount(0);

        await regPage.getByTestId('stats-filter-from').fill('2026-11-20');
        await regPage.getByTestId('stats-filter-to').fill('2026-11-20');
        await expect(regPage.getByTestId('stats-value-visitors')).toHaveText('16');
        releaseLateB();
        await regPage.waitForTimeout(150);
        await expect(regPage.getByTestId('stats-value-visitors')).toHaveText('16');
        await expect(regPage.getByTestId('stats-page')).not.toContainText('99');

        // 8.2 R3：切换服务端 timezoneRevision (rev 1 -> rev 2) 且单源失败，新版本标签下绝不出现旧版本数值、样本数或时间
        replyHandler = () => ({
          kind: 'dto',
          dto: makeMockDto({
            timezone: 'Asia/Tokyo',
            rev: 2,
            queriedAt: '2026-11-20T13:00:00.000Z',
            dataThrough: '2026-11-20T12:55:00.000Z',
            visitors: { state: 'query_failed', value: null },
            duration: { state: 'query_failed', value: null, samples: 0, coverage: 'unavailable' },
          }),
        });
        await regPage.getByTestId('stats-refresh').click();
        await expect(regPage.getByTestId('stats-timezone')).toContainText('Asia/Tokyo (rev 2)');
        await expect(regPage.getByTestId('stats-value-visitors')).toHaveText('查询失败（无快照）');
        await expect(regPage.getByTestId('stats-value-mean_load_duration_ms')).toHaveText('查询失败（无快照）');
        await expect(regPage.getByTestId('stats-duration-samples')).toContainText('—');
        await expect(regPage.getByTestId('stats-duration-samples')).not.toContainText('9');
        await expect(regPage.getByTestId('stats-page')).not.toContainText('420 ms');
        await expect(regPage.getByTestId('stats-page')).not.toContainText('2026-11-20T11:55:00.000Z');
        await expect(regPage.getByTestId('stats-row-visitors')).not.toContainText('2026-11-20T12:55:00.000Z');
        await expect(regPage.getByTestId('stats-row-mean_load_duration_ms')).not.toContainText('2026-11-20T12:55:00.000Z');

        // 8.3 R4：DOM 验证 3D 读数五种状态（查询失败[含同键保留与无快照]、旧值、确实未接入、真实无样本、有分母的 0%）
        replyHandler = () => ({
          kind: 'dto',
          dto: makeMockDto({
            rev: 2,
            timezone: 'Asia/Tokyo',
            starts: { state: 'query_failed', value: null, coverage: 'unavailable' },
            successes: { state: 'query_failed', value: null, coverage: 'unavailable' },
            duration: { state: 'query_failed', value: null, samples: 0, coverage: 'unavailable' },
            rate: { value: null, coverage: 'unavailable' },
          }),
        });
        // 同键刷新保留 8.2 同 rev 2 的配对读数，但状态必须标为 query_failed 而非 ok
        await regPage.getByTestId('stats-refresh').click();
        await expect(regPage.getByTestId('stats-model-success-rate')).toHaveAttribute('data-source-state', 'query_failed');
        await expect(regPage.getByTestId('stats-value-model_success_rate')).toHaveText('75%');

        // 切至无缓存新日期验证无快照 query_failed：绝不断言无样本或 0 starts
        await regPage.getByTestId('stats-filter-from').fill('2026-11-19');
        await regPage.getByTestId('stats-filter-to').fill('2026-11-19');
        await expect(regPage.getByTestId('stats-model-success-rate')).toHaveAttribute('data-source-state', 'query_failed');
        await expect(regPage.getByTestId('stats-value-model_success_rate')).toHaveText('查询失败（无快照）');
        await expect(regPage.getByTestId('stats-success-rate-pair')).not.toContainText('0 starts');
        await expect(regPage.getByTestId('stats-row-mean_load_duration_ms')).toContainText('查询失败（无快照）');
        await expect(regPage.getByTestId('stats-row-mean_load_duration_ms')).toContainText('samples=—');

        replyHandler = () => ({
          kind: 'dto',
          dto: makeMockDto({
            rev: 2,
            timezone: 'Asia/Tokyo',
            starts: { state: 'stale', value: 4, coverage: 'full' },
            successes: { state: 'stale', value: 3, coverage: 'full' },
            duration: { state: 'stale', value: 310, samples: 3, coverage: 'full' },
            rate: { value: 0.75, coverage: 'full' },
          }),
        });
        await regPage.getByTestId('stats-refresh').click();
        await expect(regPage.getByTestId('stats-model-success-rate')).toHaveAttribute('data-source-state', 'stale');
        await expect(regPage.getByTestId('stats-model-success-rate')).toHaveAttribute('data-alert', 'true');
        await expect(regPage.getByTestId('stats-value-model_success_rate')).toHaveText('75%');
        await expect(regPage.getByTestId('stats-success-rate-pair')).toContainText('3 / 4 starts');

        replyHandler = () => ({
          kind: 'dto',
          dto: makeMockDto({
            rev: 2,
            timezone: 'Asia/Tokyo',
            starts: { state: 'not_connected', value: null, coverage: 'unavailable' },
            successes: { state: 'not_connected', value: null, coverage: 'unavailable' },
            duration: { state: 'not_connected', value: null, samples: 0, coverage: 'unavailable' },
            rate: { value: null, coverage: 'unavailable' },
          }),
        });
        await regPage.getByTestId('stats-refresh').click();
        await expect(regPage.getByTestId('stats-model-success-rate')).toHaveAttribute('data-source-state', 'not_connected');
        await expect(regPage.getByTestId('stats-value-model_success_rate')).toHaveText('Not connected: model_success_rate');
        await expect(regPage.getByTestId('stats-success-rate-pair')).not.toContainText('0 starts');

        replyHandler = () => ({
          kind: 'dto',
          dto: makeMockDto({
            rev: 2,
            timezone: 'Asia/Tokyo',
            starts: { state: 'zero', value: 0, coverage: 'full' },
            successes: { state: 'zero', value: 0, coverage: 'full' },
            duration: { state: 'no_data', value: null, samples: 0, coverage: 'full' },
            rate: { value: null, coverage: 'full' },
          }),
        });
        await regPage.getByTestId('stats-refresh').click();
        await expect(regPage.getByTestId('stats-model-success-rate')).toHaveAttribute('data-source-state', 'no_data');
        await expect(regPage.getByTestId('stats-value-model_success_rate')).toHaveText('—（无发起样本）');
        await expect(regPage.getByTestId('stats-value-mean_load_duration_ms')).toHaveText('—（无样本）');

        replyHandler = () => ({
          kind: 'dto',
          dto: makeMockDto({
            rev: 2,
            timezone: 'Asia/Tokyo',
            starts: { state: 'ok', value: 5, coverage: 'full' },
            successes: { state: 'zero', value: 0, coverage: 'full' },
            duration: { state: 'ok', value: 500, samples: 5, coverage: 'full' },
            rate: { value: 0, coverage: 'full' },
          }),
        });
        await regPage.getByTestId('stats-refresh').click();
        await expect(regPage.getByTestId('stats-model-success-rate')).toHaveAttribute('data-source-state', 'zero');
        await expect(regPage.getByTestId('stats-value-model_success_rate')).toHaveText('0%');
        await expect(regPage.getByTestId('stats-success-rate-pair')).toContainText('0 / 5 starts');

        // 8.4 R1：先在全部范围与仅系统运维范围均缓存 api_requests=42 快照 -> 失权收到 403 清快照并停止该越权查询 -> 后续 503 与断网均不恢复运维计数
        replyHandler = () => ({
          kind: 'dto',
          dto: makeMockDto({
            rev: 2,
            timezone: 'Asia/Tokyo',
            apiRequests: { state: 'ok', value: 42 },
          }),
        });
        await regPage.getByTestId('stats-refresh').click();
        await expect(regPage.getByTestId('stats-source-api_requests')).toBeVisible();
        await expect(regPage.getByTestId('stats-value-api_requests')).toHaveText('42');
        await expect(regPage.getByTestId('stats-svg-chart')).toContainText('已接线 API 请求数');
        await expect(regPage.getByTestId('stats-row-api_requests')).toContainText('42');

        await regPage.getByTestId('stats-scope-ops').click();
        await expect(regPage.getByTestId('stats-value-api_requests')).toHaveText('42');

        replyHandler = () => ({
          kind: 'error',
          status: 403,
          code: 'forbidden',
          message: 'Forbidden',
        });
        const countBeforeForbidden = seenStatsUrls.length;
        await regPage.getByTestId('stats-refresh').click();
        await expect(regPage.getByTestId('stats-error-banner')).toBeVisible();
        await expect(regPage.getByTestId('stats-scope-ops')).toHaveCount(0);
        await expect(regPage.getByTestId('stats-source-api_requests')).toHaveCount(0);
        await expect(regPage.getByTestId('stats-svg-chart')).toHaveCount(0);
        await expect(regPage.getByTestId('stats-table')).toHaveCount(0);
        expect(seenStatsUrls.length).toBe(countBeforeForbidden + 1);
        expect(seenStatsUrls[seenStatsUrls.length - 1]).toContain('sources=api_requests');

        // 后续请求失败（503 及网络异常）：越权 sources 查询已停止不再发出，且卡片、图表与表格均不会恢复已隐藏的运维计数 42
        replyHandler = () => ({
          kind: 'error',
          status: 503,
          code: 'service_unavailable',
          message: 'Service temporarily unavailable',
        });
        const countBeforeSubsequentFail = seenStatsUrls.length;
        await regPage.getByTestId('stats-refresh').click();
        await expect.poll(() => seenStatsUrls.length).toBe(countBeforeSubsequentFail + 1);
        expect(seenStatsUrls[seenStatsUrls.length - 1]).not.toContain('sources=');
        await expect(regPage.getByTestId('stats-error-banner')).toBeVisible();
        await expect(regPage.getByTestId('stats-source-api_requests')).toHaveCount(0);
        await expect(regPage.getByTestId('stats-svg-chart')).toHaveCount(0);
        await expect(regPage.getByTestId('stats-table')).toHaveCount(0);
        await expect(regPage.getByTestId('stats-page')).not.toContainText('已接线 API 请求数');

        replyHandler = () => ({ kind: 'network_error' });
        const countBeforeNetErr = seenStatsUrls.length;
        await regPage.getByTestId('stats-refresh').click();
        await expect.poll(() => seenStatsUrls.length).toBe(countBeforeNetErr + 1);
        expect(seenStatsUrls[seenStatsUrls.length - 1]).not.toContain('sources=');
        await expect(regPage.getByTestId('stats-source-api_requests')).toHaveCount(0);
        await expect(regPage.getByTestId('stats-svg-chart')).toHaveCount(0);
        await expect(regPage.getByTestId('stats-table')).toHaveCount(0);
      } finally {
        await regSession.context.close();
      }
    } finally {
      await anonReq.dispose();
      await adminReq.dispose();
      await salesReq.dispose();
      await editorReq.dispose();
    }
  });

  test('M6-T4 11-UI: 1920x1080 / 1440x900 / 390x844 真实会话导航、computed style 与 work 密度 D1-D6/手机真实 n/a', async ({
    browser,
    playwright,
  }, testInfo) => {
    const adminState = await loadRunAuth(ROLE_SLOTS.ADMIN, BASE, playwright.request);
    const reports: Array<Record<string, unknown>> = [];

    for (const vp of VIEWPORTS) {
      const mobile = vp.width < 768;
      const session = await openRoleContext(browser, adminState, {
        viewport: { width: vp.width, height: vp.height },
        hasTouch: mobile,
        isMobile: mobile,
      });
      try {
        const { page, observer } = session;
        const { dto: vpDto } = await navigateViaStatsLink(page, observer!, '/admin/inquiries', mobile);
        expect(vpDto.sources).toHaveLength(17);
        await expect(page.getByTestId('stats-source-visitors')).toBeVisible();
        await expect(page.getByTestId('stats-table')).toBeVisible();

        const probe = await runWorkDensityProbe(page);
        expect(probe.contentFound, `${vp.label} contentFound`).toBe(true);
        expect(probe.overflowX, `${vp.label} raw overflowX`).toBe(0);
        expect(probe.verdict?.overflow, `${vp.label} verdict.overflow`).toBe('pass');
        expect(probe.verdict?.D3, `${vp.label} verdict.D3`).toBe('pass');
        expect(probe.verdict?.pass, `${vp.label} verdict.pass`).toBe(true);

        if (!mobile) {
          for (const key of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'] as const) {
            expect(probe.verdict?.[key], `${vp.label} ${key}`).toBe('pass');
          }
          expect(probe.fill ?? 0, `${vp.label} work fill >= 0.85`).toBeGreaterThanOrEqual(0.85);
        } else {
          // 手机保留探针真实 n/a，不伪造全 pass（验收标准 2 / 17 节）
          for (const key of ['D1', 'D2', 'D4', 'D5', 'D6'] as const) {
            expect(probe.verdict?.[key], `${vp.label} mobile ${key} genuine n/a`).toBe('n/a');
          }
        }

        const measured = await page.evaluate(() => {
          const cs = (el: Element) => getComputedStyle(el);
          const rectOf = (el: Element) => {
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
          };
          const boxStyle = (el: Element) => {
            const s = cs(el);
            return {
              borders: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
              borderColor: s.borderRightColor,
              radii: [
                s.borderTopLeftRadius,
                s.borderTopRightRadius,
                s.borderBottomRightRadius,
                s.borderBottomLeftRadius,
              ],
              shadow: s.boxShadow,
              bgImage: s.backgroundImage,
              bg: s.backgroundColor,
              fg: s.color,
              pad: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft],
              rect: rectOf(el),
            };
          };
          const filterCard = document.querySelector('[data-testid="stats-filters"]')!;
          const metricCard = document.querySelector('[data-testid="stats-source-visitors"]')!;
          const fromInput = document.querySelector('[data-testid="stats-filter-from"]')!;
          const productSelect = document.querySelector('[data-testid="stats-filter-product"]')!;
          const applyBtn = document.querySelector('[data-testid="stats-apply"]')!;
          const refreshBtn = document.querySelector('[data-testid="stats-refresh"]')!;
          const tableHeader = document.querySelector('[data-testid="stats-table"] th')!;
          const title = document.querySelector('.stats-title')!;
          const activeNav = document.querySelector('#adm-nav a[aria-current="page"]');
          return {
            titleFont: { size: cs(title).fontSize, line: cs(title).lineHeight, weight: cs(title).fontWeight },
            filterCard: boxStyle(filterCard),
            metricCard: boxStyle(metricCard),
            fromInput: boxStyle(fromInput),
            productSelect: boxStyle(productSelect),
            applyBtn: boxStyle(applyBtn),
            refreshBtn: boxStyle(refreshBtn),
            tableHeader: {
              bg: cs(tableHeader).backgroundColor,
              fg: cs(tableHeader).color,
              size: cs(tableHeader).fontSize,
              line: cs(tableHeader).lineHeight,
            },
            activeNavLeftBorderColor: activeNav ? cs(activeNav).borderLeftColor : null,
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });

        expect(measured.overflowX).toBe(0);
        expect(measured.titleFont).toEqual({ size: '28px', line: '32px', weight: '700' });
        for (const [label, box] of [
          ['filtersCard', measured.filterCard],
          ['metricCard', measured.metricCard],
          ['fromInput', measured.fromInput],
          ['productSelect', measured.productSelect],
          ['applyBtn', measured.applyBtn],
          ['refreshBtn', measured.refreshBtn],
        ] as const) {
          expect(box.borders, `${vp.label} ${label} 2px borders`).toEqual(['2px', '2px', '2px', '2px']);
          expect(box.borderColor, `${vp.label} ${label} black border`).toBe('rgb(0, 0, 0)');
          expect(box.radii, `${vp.label} ${label} 0px radius`).toEqual(['0px', '0px', '0px', '0px']);
          expect(box.shadow, `${vp.label} ${label} no shadow`).toBe('none');
          expect(box.bgImage, `${vp.label} ${label} no gradient`).toBe('none');
        }
        expect(measured.filterCard.pad).toEqual(['16px', '16px', '16px', '16px']);
        expect(measured.metricCard.pad).toEqual(['16px', '16px', '16px', '16px']);
        expect(measured.tableHeader).toEqual({
          bg: 'rgb(255, 255, 255)',
          fg: 'rgb(0, 0, 0)',
          size: '14px',
          line: '20px',
        });
        if (!mobile) {
          expect(measured.activeNavLeftBorderColor).toBe('rgb(180, 87, 0)');
        }

        const minControlHeight = mobile ? 44 : 36;
        expect(measured.fromInput.rect.h, `${vp.label} fromInput height`).toBeGreaterThanOrEqual(minControlHeight);
        expect(measured.productSelect.rect.h, `${vp.label} productSelect height`).toBeGreaterThanOrEqual(
          minControlHeight,
        );
        expect(measured.applyBtn.rect.h, `${vp.label} applyBtn height`).toBeGreaterThanOrEqual(minControlHeight);
        expect(measured.refreshBtn.rect.h, `${vp.label} refreshBtn height`).toBeGreaterThanOrEqual(minControlHeight);
        if (mobile) {
          expect(measured.applyBtn.rect.w, '390 applyBtn touch width').toBeGreaterThanOrEqual(44);
          expect(measured.refreshBtn.rect.w, '390 refreshBtn touch width').toBeGreaterThanOrEqual(44);
        }

        const shotPath = testInfo.outputPath(`stats-${vp.label}.png`);
        await page.screenshot({ path: shotPath, fullPage: false });
        expect(existsSync(shotPath)).toBe(true);
        await testInfo.attach(`stats-${vp.label}`, { path: shotPath, contentType: 'image/png' });

        reports.push({
          viewport: vp.label,
          mobile,
          density: safeDensityReport(probe),
          styles: measured,
        });
      } finally {
        await session.context.close();
      }
    }

    const evidenceDir = path.resolve('e2e-evidence', 'm6-t4-density');
    mkdirSync(evidenceDir, { recursive: true });
    const reportPath = path.join(evidenceDir, 'stats-density-report.json');
    const serialized = JSON.stringify({ task: 'M6-T4', route: '/admin/stats', viewports: reports }, null, 2) + '\n';
    writeFileSync(reportPath, serialized);
    await testInfo.attach('stats-density-report', { path: reportPath, contentType: 'application/json' });
  });
});

function expectMixedStatsEnvelope(raw: Record<string, unknown>) {
  expect(Object.keys(raw).sort()).toEqual([
    'apiErrorRate', 'modelSuccessRate', 'notificationCounts', 'recomputableFrom', 'sources',
  ]);
  expect(raw.apiErrorRate).toBeNull();
  expect(raw.modelSuccessRate).toBeNull();
  expect(raw.notificationCounts).toBeNull();
}
