import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDayCompleteness,
  computeDailyMetrics,
  dedupeTerminalsByEventId,
  isSmokePath,
  meanDurationMs,
  normalizePath,
  partitionTerminals,
  successRate,
  toVersion,
  utcDatesCovered,
  type AnalyticsFact,
} from '../src/lib/analytics/daily-aggregate';

const NOT_AFTER = new Date('2026-03-02T23:59:59.000Z');

let seq = 0;
function fact(input: Partial<AnalyticsFact> & { kind: AnalyticsFact['kind'] }): AnalyticsFact {
  seq += 1;
  return {
    eventId: input.eventId ?? `ev-${seq}`,
    kind: input.kind,
    browserHash: input.browserHash ?? `bh-${seq}`,
    viewId: input.viewId ?? null,
    occurredAt: input.occurredAt ?? new Date('2026-03-02T10:00:00.000Z'),
    receivedAt: input.receivedAt ?? new Date('2026-03-02T10:00:01.000Z'),
    durationMs: input.durationMs ?? null,
    locale: input.locale ?? 'en',
    productSlug: input.productSlug ?? null,
    path: input.path ?? null,
  };
}

describe('M5-T12 日聚合纯函数', { concurrency: false }, () => {
  test('冒烟路径规则：整段或任一段以 nbs-smoke- 开头，段中与 query/fragment 不算', () => {
    assert.equal(isSmokePath(null), false);
    assert.equal(isSmokePath('/en'), false);
    assert.equal(isSmokePath('/nbs-smoke-home'), true);
    assert.equal(isSmokePath('/en/products/nbs-smoke-x'), true);
    assert.equal(isSmokePath('/en/nbs-smoke-x?from=nav'), true);
    assert.equal(isSmokePath('/en/nbs-smoke-x#heap'), true);
    assert.equal(isSmokePath('/en/x-nbs-smoke-y'), false);
    assert.equal(isSmokePath('/en/products/foo?nbs-smoke-1'), false);
    assert.equal(normalizePath('/en/products/foo?x=1#y'), '/en/products/foo');
  });

  test('站点指标：UV 取当日全部计入事实（含终态），事件计数只取非终态', () => {
    const facts = [
      fact({ kind: 'page_view', browserHash: 'b1' }),
      fact({ kind: 'product_view', browserHash: 'b1', productSlug: 'cube' }),
      fact({ kind: 'model_view_start', browserHash: 'b2', viewId: 'v1', productSlug: 'cube' }),
      fact({ kind: 'chat_start', browserHash: 'b3' }),
      fact({ kind: 'model_load_success', browserHash: 'b4', viewId: 'v1', durationMs: 1200 }),
    ];
    const terminals = [facts[4]!];
    const { site } = computeDailyMetrics(facts, terminals, { localDate: '2026-03-02', notAfter: NOT_AFTER });
    assert.equal(site.dimension, 'site');
    // 4 个 browserHash：b1/b2/b3 + 终态自身 b4（模型 compute_metrics 的 all_facts）。
    assert.equal(site.visitors, 4);
    assert.equal(site.pageViews, 1);
    assert.equal(site.productViews, 1);
    assert.equal(site.modelStarts, 1);
    assert.equal(site.chatStarts, 1);
    assert.equal(site.modelSuccesses, 1);
    assert.equal(site.modelFailures, 0);
    assert.equal(site.durationMsSum, 1200n);
    assert.equal(site.loadDurationSamples, 1);
    assert.equal(site.sourceThrough?.toISOString(), '2026-03-02T10:00:01.000Z');
  });

  test('配对终态按 eventId 去重；同一终态出现两次只计一次', () => {
    const start = fact({ kind: 'model_view_start', browserHash: 'b1', viewId: 'v1', productSlug: 'cube' });
    const terminal = fact({ kind: 'model_load_failure', eventId: 'term-1', browserHash: 'b1', viewId: 'v1', durationMs: 500 });
    const { site } = computeDailyMetrics([start], [terminal, terminal], {
      localDate: '2026-03-02',
      notAfter: NOT_AFTER,
    });
    assert.equal(site.modelFailures, 1);
    assert.equal(site.durationMsSum, 500n);
    assert.equal(site.loadDurationSamples, 1);
    assert.equal(dedupeTerminalsByEventId([terminal, terminal]).length, 1);
  });

  test('产品 UV 只取 product_view / model_view_start / 路径命中产品的 page_view；终态不加 UV', () => {
    const resolve = (path: string, locale: string) =>
      path === `/${locale}/products/cube` ? 'cube' : null;
    const facts = [
      fact({ kind: 'product_view', browserHash: 'b1', productSlug: 'cube' }),
      fact({ kind: 'model_view_start', browserHash: 'b2', viewId: 'v1', productSlug: 'cube' }),
      fact({ kind: 'page_view', browserHash: 'b3', path: '/en/products/cube' }),
      fact({ kind: 'page_view', browserHash: 'b3', path: '/en/products/cube#reviews' }),
      fact({ kind: 'model_load_success', browserHash: 'b9', viewId: 'v1', productSlug: 'cube', durationMs: 800 }),
      fact({ kind: 'chat_start', browserHash: 'b8', productSlug: 'cube' }),
    ];
    const terminals = [facts[4]!];
    const { products, site } = computeDailyMetrics(facts, terminals, {
      localDate: '2026-03-02',
      notAfter: NOT_AFTER,
      resolveProductSlugFromPath: resolve,
    });
    const cube = products.get('cube');
    assert.ok(cube);
    assert.deepEqual([cube.visitors, cube.productViews, cube.modelStarts, cube.chatStarts], [3, 1, 1, 1]);
    assert.equal(cube.modelSuccesses, 1);
    assert.equal(cube.durationMsSum, 800n);
    assert.equal(cube.pageViews, null);
    // 终态自身 browserHash 只进站点 UV，不进产品 UV；chat_start 也不进产品 UV。
    assert.equal(site.visitors, 5);
  });

  test('终态经 start 归属产品；缺 start 的终态用自身 productSlug 建行', () => {
    const start = fact({ kind: 'model_view_start', browserHash: 'b1', viewId: 'v1', productSlug: 'cube' });
    const terminal = fact({ kind: 'model_load_failure', browserHash: 'b1', viewId: 'v1', productSlug: 'lamp', durationMs: 100 });
    const orphan = fact({ kind: 'model_load_success', browserHash: 'b2', viewId: 'v2', productSlug: 'lamp', durationMs: 200 });
    const { products } = computeDailyMetrics([start, terminal, orphan], [terminal, orphan], {
      localDate: '2026-03-02',
      notAfter: NOT_AFTER,
    });
    assert.equal(products.get('cube')?.modelFailures, 1);
    assert.equal(products.get('lamp')?.modelSuccesses, 1);
    assert.equal(products.get('lamp')?.modelStarts, 0);
  });

  test('未配对终态（本日窗口内）单独列出，供 Q2/Q5/gap 判定', () => {
    const paired = fact({ kind: 'model_load_success', browserHash: 'b1', viewId: 'v1' });
    const orphan = fact({ kind: 'model_load_failure', browserHash: 'b2', viewId: 'v2' });
    const noView = fact({ kind: 'model_load_failure', browserHash: 'b3', viewId: null });
    const start = fact({ kind: 'model_view_start', browserHash: 'b1', viewId: 'v1', productSlug: 'cube' });
    const { unattributableInDayTerminals } = computeDailyMetrics([start, paired, orphan, noView], [paired], {
      localDate: '2026-03-02',
      notAfter: NOT_AFTER,
    });
    assert.deepEqual(unattributableInDayTerminals.map((item) => item.eventId), [orphan.eventId, noView.eventId]);
  });

  test('终态按 occurredAt<=notAfter 分区：未来终态不计入、留给 defer', () => {
    const start = fact({ kind: 'model_view_start', browserHash: 'b1', viewId: 'v1', productSlug: 'cube' });
    const future = fact({
      kind: 'model_load_success',
      browserHash: 'b1',
      viewId: 'v1',
      productSlug: 'cube',
      durationMs: 900,
      occurredAt: new Date('2026-03-03T00:00:01.000Z'),
    });
    const partition = partitionTerminals([future], NOT_AFTER);
    assert.equal(partition.counted.length, 0);
    assert.equal(partition.deferred.length, 1);
    const { site } = computeDailyMetrics([start, future], [future], { localDate: '2026-03-02', notAfter: NOT_AFTER });
    assert.equal(site.modelSuccesses, 0);
    assert.equal(site.durationMsSum, 0n);
  });

  test('无分母时均值/成功率为 null，零成功为 0%', () => {
    assert.equal(meanDurationMs(0n, 0), null);
    assert.equal(meanDurationMs(300n, 2), 150);
    assert.equal(successRate(0, 0), null);
    assert.equal(successRate(4, 0), 0);
    assert.equal(successRate(4, 1), 0.25);
  });

  test('UTC 日映射：+05:30 落单日，+14 与 -11 跨两日', () => {
    // Mumbai 2026-03-02 00:00 → 2026-03-01T18:30Z；次日 00:00 → 03-02T18:30Z。
    assert.deepEqual(
      utcDatesCovered({ startUtc: '2026-03-01T18:30:00.000Z', endUtc: '2026-03-02T18:30:00.000Z' }),
      ['2026-03-01', '2026-03-02'],
    );
    // Kiritimati(+14) 2026-03-02 00:00 → 03-01T10:00Z；次日 → 03-02T10:00Z。
    assert.deepEqual(
      utcDatesCovered({ startUtc: '2026-03-01T10:00:00.000Z', endUtc: '2026-03-02T10:00:00.000Z' }),
      ['2026-03-01', '2026-03-02'],
    );
    // Pago Pago(-11) 2026-03-02 → 03-02T11:00Z..03-03T11:00Z。
    assert.deepEqual(
      utcDatesCovered({ startUtc: '2026-03-02T11:00:00.000Z', endUtc: '2026-03-03T11:00:00.000Z' }),
      ['2026-03-02', '2026-03-03'],
    );
  });

  test('M6 分类：无 site 行 / 缺 state / gap / defer / marker 前进 / complete', () => {
    const bounds = { startUtc: '2026-03-01T18:30:00.000Z', endUtc: '2026-03-02T18:30:00.000Z' };
    const markers = { '2026-03-01': '7', '2026-03-02': '8' };
    const liveSame = new Map([
      ['2026-03-01', '7'],
      ['2026-03-02', '8'],
    ]);
    assert.equal(
      classifyDayCompleteness({ siteRow: null, state: null, bounds, liveVersions: liveSame }).reason,
      'no_site_row',
    );
    assert.equal(
      classifyDayCompleteness({ siteRow: { timezone: 'Asia/Kolkata' }, state: null, bounds, liveVersions: liveSame }).reason,
      'state_missing',
    );
    assert.equal(
      classifyDayCompleteness({
        siteRow: { timezone: 'Asia/Kolkata' },
        state: { markerVersions: markers, deferUntil: null, gapKind: 'late_unattributable' },
        bounds,
        liveVersions: liveSame,
      }).reason,
      'gap:late_unattributable',
    );
    assert.equal(
      classifyDayCompleteness({
        siteRow: { timezone: 'Asia/Kolkata' },
        state: { markerVersions: markers, deferUntil: new Date('2026-03-03T00:00:00Z'), gapKind: null },
        bounds,
        liveVersions: liveSame,
      }).reason,
      'defer_pending',
    );
    const ahead = classifyDayCompleteness({
      siteRow: { timezone: 'Asia/Kolkata' },
      state: { markerVersions: markers, deferUntil: null, gapKind: null },
      bounds,
      liveVersions: new Map([
        ['2026-03-01', '7'],
        ['2026-03-02', '9'],
      ]),
    });
    assert.equal(ahead.status, 'partial');
    assert.equal(ahead.reason, 'live_marker_ahead');
    assert.equal(ahead.utcDate, '2026-03-02');
    assert.equal(ahead.live, '9');
    assert.equal(ahead.consumed, '8');
    // 缺键按 0 比：state 只消费了一个 UTC 日，另一个键缺省即 0。
    assert.equal(
      classifyDayCompleteness({
        siteRow: { timezone: 'Asia/Kolkata' },
        state: { markerVersions: { '2026-03-01': '7' }, deferUntil: null, gapKind: null },
        bounds,
        liveVersions: liveSame,
      }).reason,
      'live_marker_ahead',
    );
    assert.equal(
      classifyDayCompleteness({
        siteRow: { timezone: 'Asia/Kolkata' },
        state: { markerVersions: markers, deferUntil: null, gapKind: null },
        bounds,
        liveVersions: liveSame,
      }).status,
      'complete',
    );
  });

  test('版本按十进制字符串比较，超过 2^53 也不折叠', () => {
    assert.equal(toVersion(undefined), '0');
    assert.equal(toVersion('0012'), '12');
    assert.equal(toVersion(12), '12');
    assert.equal(toVersion('9007199254740993'), '9007199254740993');
  });
});

import { assertDailyAggregateGuards, AggregateVersionConflict } from "../src/lib/server/analytics/aggregate";
const NOW = new Date('2026-03-02T10:00:00.000Z');

function stubTx(jobState: Array<Record<string, unknown>>): Parameters<typeof assertDailyAggregateGuards>[0] {
  let call = 0;
  return {
    $executeRaw: async () => 0,
    $queryRaw: async () => {
      call += 1;
      if (call === 1) return jobState;
      return [{ value: { timezoneRevision: 3, timezone: 'UTC', version: 1, changedAt: NOW.toISOString(), updatedBy: null } }];
    },
  } as unknown as Parameters<typeof assertDailyAggregateGuards>[0];
}

const base = { timezoneRevision: 3, now: NOW, generation: 7, leaseOwner: 'analytics-aggregate' };
const future = new Date(Date.now() + 60_000).toISOString().replace('T', 'T').replace('Z', 'Z');

describe('M5-T12 assertDailyAggregateGuards fail-closed', { concurrency: false }, () => {
  test('正常租约通过', async () => {
    await assertDailyAggregateGuards(stubTx([{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: future }]), base);
  });

  test('无 JobState 行 → stale_generation', async () => {
    await assert.rejects(() => assertDailyAggregateGuards(stubTx([]), base), AggregateVersionConflict);
  });

  test('代次不相等（含库内更小）→ stale_generation', async () => {
    for (const generation of [6, 8]) {
      await assert.rejects(
        () => assertDailyAggregateGuards(stubTx([{ generation, leaseOwner: 'analytics-aggregate', lockedUntil: future }]), base),
        AggregateVersionConflict,
      );
    }
  });

  test('owner 不等 → stale_generation', async () => {
    await assert.rejects(
      () => assertDailyAggregateGuards(stubTx([{ generation: 7, leaseOwner: 'other-worker', lockedUntil: future }]), base),
      AggregateVersionConflict,
    );
  });

  test('lockedUntil 缺失/非法/已过期 → stale_generation', async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    for (const lockedUntil of [null, 'not-a-time', past]) {
      await assert.rejects(
        () => assertDailyAggregateGuards(stubTx([{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil }]), base),
        AggregateVersionConflict,
      );
    }
  });

  test('运行时负控：cast 省略 generation / leaseOwner 必须在写前失败', async () => {
    const futureLease = new Date(Date.now() + 60_000).toISOString();
    const row = [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: futureLease }];
    await assert.rejects(
      () => assertDailyAggregateGuards(stubTx(row), { ...base, generation: undefined as unknown as number }),
      AggregateVersionConflict,
    );
    await assert.rejects(
      () => assertDailyAggregateGuards(stubTx(row), { ...base, leaseOwner: undefined as unknown as string }),
      AggregateVersionConflict,
    );
  });
});
