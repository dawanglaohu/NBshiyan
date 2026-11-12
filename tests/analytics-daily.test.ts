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

/* ------------------------------------------------------------------------- *
 * 阶段序列回归（纯桩、不连 PG）：独立元数据 CAS 必须先于主事务，并按 plan expected 写。
 * 这些用例命中 14e 的两个新缺陷（future defer 被清空、CAS 0 静默）与 B3 的 gap 读后写。
 * ------------------------------------------------------------------------- */

import { writeDailyMetadataPhase, writeDailyCoverageMetadata, writeDailyGap, type DailyStateExpectation } from "../src/lib/server/analytics/aggregate";

type SqlCall = { kind: 'query' | 'execute'; sql: string; values: unknown[] };

function flattenValues(values: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const value of values) {
    if (value !== null && typeof value === 'object' && Array.isArray((value as { values?: unknown[] }).values)) {
      out.push(...flattenValues((value as { values: unknown[] }).values));
    } else {
      out.push(value);
    }
  }
  return out;
}

function sqlOf(arg: unknown, values: unknown[]): { text: string; values: unknown[] } {
  if (Array.isArray(arg)) return { text: arg.join('?'), values };
  const object = arg as { strings?: readonly string[]; values?: unknown[] } | null;
  if (object !== null && typeof object === 'object' && Array.isArray(object.strings)) {
    return { text: object.strings.join('?'), values: object.values ?? [] };
  }
  return { text: String(arg), values };
}

function stubDb(options: {
  jobState: unknown[];
  stateQueries: unknown[][];
  live: Array<{ utcDate: string; version: string }>;
  siteRows?: Array<{ localDate: string }>;
  affected?: number | ((index: number) => number);
}) {
  const calls: SqlCall[] = [];
  const stateQueue = [...options.stateQueries];
  const execute = async (arg: unknown, ...rest: unknown[]) => {
    const { text, values } = sqlOf(arg, rest);
    calls.push({ kind: 'execute', sql: text, values });
    if (text.startsWith('SET LOCAL')) return 0;
    const writes = calls.filter((call) => call.kind === 'execute' && !call.sql.startsWith('SET LOCAL'));
    if (typeof options.affected === 'function') return options.affected(writes.length - 1);
    return options.affected ?? 1;
  };
  const query = async (arg: unknown, ...rest: unknown[]) => {
    const { text, values } = sqlOf(arg, rest);
    calls.push({ kind: 'query', sql: text, values });
    if (text.includes('JobState')) return options.jobState;
    if (text.includes('SiteSetting')) {
      return [{ value: { version: 1, timezone: 'UTC', timezoneRevision: 3, changedAt: '2026-03-02T10:00:00.000Z', updatedBy: null } }];
    }
    if (text.includes('AnalyticsDayChange')) return options.live;
    if (text.includes('AnalyticsAggregateDayState')) return stateQueue.shift() ?? [];
    if (text.includes('AnalyticsDaily')) return options.siteRows ?? [];
    return [];
  };
  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRaw: query,
      $executeRaw: execute,
      $executeRawUnsafe: async (arg: unknown) => {
        const { text } = sqlOf(arg, []);
        if (text.startsWith('SET LOCAL')) return 0;
        return execute(arg);
      },
    }),
    $queryRaw: query,
    $executeRaw: execute,
  };
  return { db, calls };
}

const PHASE_NOW = new Date('2026-03-02T10:00:00.000Z');
const OLD_DAY = '2026-01-15';
const LIVE_LEASE = new Date(Date.now() + 120_000).toISOString();
const planState = {
  localDate: OLD_DAY,
  timezoneRevision: 3,
  timezone: 'UTC',
  markerVersions: { [OLD_DAY]: '1' },
  deferUntil: new Date('2026-03-05T00:00:00.000Z').toISOString(),
  gapKind: null,
  gapSince: null,
  updatedAt: '2026-03-01T00:00:00.000Z',
};

function phaseArgs() {
  return {
    now: PHASE_NOW,
    cutoff: PHASE_NOW,
    timezone: 'UTC',
    revision: 3,
    floor: '2026-01-01',
    today: '2026-03-02',
    baseDates: new Set([OLD_DAY]),
    generation: 7,
    leaseOwner: 'analytics-aggregate',
    notAfter: PHASE_NOW,
  };
}

describe('M5-T12 覆盖元数据：独立 CAS 阶段按 plan expected 写', { concurrency: false }, () => {
  test('coverage 用 plan 快照的 markers/updatedAt 做 CAS，且不清空 future defer', async () => {
    const { db, calls } = stubDb({
      jobState: [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: LIVE_LEASE }],
      stateQueries: [[planState]],
      live: [{ utcDate: OLD_DAY, version: '2' }],
      affected: 1,
    });
    const phase = await writeDailyMetadataPhase(db as never, phaseArgs());
    assert.equal(phase.written.length, 1);
    assert.equal(phase.written[0]?.action, 'coverage');
    assert.equal(phase.written[0]?.result, 'updated');
    assert.deepEqual([...phase.handled], [OLD_DAY]);
    // 守卫先于任何写：第一条语句是 JobState 行锁，第一次写之前没有别的写。
    assert.ok(calls[0]?.sql.includes('JobState'));
    const write = calls.find((call) => call.kind === 'execute' && call.sql.includes('AnalyticsAggregateDayState'));
    assert.ok(write !== undefined);
    const values = flattenValues(write.values);
    // 期望值来自 plan（'1'），不是当时 live 的 '2'。
    assert.ok(values.includes(JSON.stringify({ [OLD_DAY]: '1' })));
    // future defer 保留：仍按「旧 defer 仅 > now 才保留」。
    assert.ok(values.includes('2026-03-05T00:00:00.000Z'));
    assert.ok(values.includes('2026-03-01T00:00:00.000Z'));
  });

  test('CAS 0 行且该行已被并发成功写者终止 → conflict_noop，不抛、不重写', async () => {
    const { db, calls } = stubDb({
      jobState: [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: LIVE_LEASE }],
      stateQueries: [[planState], [{ ...planState, gapKind: 'raw_partial', markerVersions: { [OLD_DAY]: '2' } }]],
      live: [{ utcDate: OLD_DAY, version: '2' }],
      affected: 0,
    });
    const phase = await writeDailyMetadataPhase(db as never, phaseArgs());
    assert.equal(phase.written[0]?.result, 'conflict_noop');
    assert.equal(phase.handled.size, 1);
    const writes = calls.filter((call) => call.kind === 'execute' && call.sql.includes('AnalyticsAggregateDayState'));
    assert.equal(writes.length, 1); // 不重读后强写：只有最初那一次 CAS 尝试
  });

  test('CAS 0 行且仍需重算 → 版本冲突，不静默成功', async () => {
    const { db } = stubDb({
      jobState: [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: LIVE_LEASE }],
      stateQueries: [[planState], [{ ...planState, gapKind: 'budget', markerVersions: {} }]],
      live: [{ utcDate: OLD_DAY, version: '2' }],
      affected: 0,
    });
    await assert.rejects(() => writeDailyMetadataPhase(db as never, phaseArgs()), AggregateVersionConflict);
  });

  test('租约守卫不通过时一条元数据都不写', async () => {
    const { db, calls } = stubDb({ jobState: [], stateQueries: [[planState]], live: [] });
    await assert.rejects(() => writeDailyMetadataPhase(db as never, phaseArgs()), AggregateVersionConflict);
    assert.equal(calls.filter((call) => call.kind === 'execute').length, 0);
  });
});

describe('M5-T12 gap 写：只按原 plan expected，不读当前行', { concurrency: false }, () => {
  const gapArgs = (expected: DailyStateExpectation | null) => ({
    halt: { kind: 'budget' as const, localDate: OLD_DAY, reason: 'deadline' as const, queued: 1 },
    timezone: 'UTC',
    revision: 3,
    now: PHASE_NOW,
    cutoff: PHASE_NOW,
    generation: 7,
    leaseOwner: 'analytics-aggregate',
    notAfter: PHASE_NOW,
    expected,
  });

  test('有 plan expected：只出现 JobState 守卫查询，没有 day-state 读', async () => {
    const { db, calls } = stubDb({
      jobState: [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: LIVE_LEASE }],
      stateQueries: [],
      live: [],
      affected: 1,
    });
    const result = await writeDailyGap(db as never, gapArgs({
      markers: { [OLD_DAY]: '1' },
      updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      deferUntil: new Date('2026-03-05T00:00:00.000Z'),
    }));
    assert.equal(result, 'written');
    const queries = calls.filter((call) => call.kind === 'query');
    assert.ok(queries.every((call) => !call.sql.includes('AnalyticsAggregateDayState')), '不得在写前读当前 day-state');
    const write = calls.find((call) => call.kind === 'execute' && call.sql.includes('AnalyticsAggregateDayState'));
    assert.ok(write !== undefined);
    const values = flattenValues(write.values);
    assert.ok(values.includes(JSON.stringify({ [OLD_DAY]: '1' })));
    assert.ok(values.includes('2026-03-05T00:00:00.000Z'));
  });

  test('plan 当时确认无该行：冲突即 cas_failed，不读当前行也不强写', async () => {
    const { db, calls } = stubDb({
      jobState: [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: LIVE_LEASE }],
      stateQueries: [],
      live: [],
      affected: 0,
    });
    const result = await writeDailyGap(db as never, gapArgs(null));
    assert.equal(result, 'cas_failed');
    assert.ok(calls.filter((call) => call.kind === 'query').every((call) => !call.sql.includes('AnalyticsAggregateDayState')));
  });
});



describe('M5-T12 闭包 coverage：回滚后的独立 CAS 事务', { concurrency: false }, () => {
  test('逐日按原 plan expected 写，且写前不读 day-state', async () => {
    const { db, calls } = stubDb({
      jobState: [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: LIVE_LEASE }],
      stateQueries: [],
      live: [{ utcDate: OLD_DAY, version: '2' }],
      affected: 1,
    });
    const writes = await writeDailyCoverageMetadata(db as never, {
      entries: [{
        date: OLD_DAY,
        expected: { markers: { [OLD_DAY]: '1' }, updatedAt: new Date('2026-03-01T00:00:00.000Z'), deferUntil: new Date('2026-03-05T00:00:00.000Z') },
      }],
      timezone: 'UTC',
      revision: 3,
      now: PHASE_NOW,
      cutoff: PHASE_NOW,
      notAfter: PHASE_NOW,
      generation: 7,
      leaseOwner: 'analytics-aggregate',
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.result, 'updated');
    assert.ok(calls.filter((call) => call.kind === 'query').every((call) => !call.sql.includes('AnalyticsAggregateDayState')));
    const write = calls.find((call) => call.kind === 'execute' && call.sql.includes('AnalyticsAggregateDayState'));
    assert.ok(write !== undefined);
    const values = flattenValues(write.values);
    assert.ok(values.includes(JSON.stringify({ [OLD_DAY]: '1' })));
    assert.ok(values.includes('2026-03-05T00:00:00.000Z'));
  });

  test('没有闭包日时不写库、不开事务', async () => {
    const { db, calls } = stubDb({ jobState: [], stateQueries: [], live: [] });
    const writes = await writeDailyCoverageMetadata(db as never, {
      entries: [],
      timezone: 'UTC',
      revision: 3,
      now: PHASE_NOW,
      cutoff: PHASE_NOW,
      notAfter: PHASE_NOW,
      generation: 7,
      leaseOwner: 'analytics-aggregate',
    });
    assert.deepEqual(writes, []);
    assert.equal(calls.length, 0);
  });
});


/* ------------------------------------------------------------------------- *
 * notAfter 语义与阶段预算（初审两项必修的确定性负控）
 * ------------------------------------------------------------------------- */

import { mergeDeferUntil } from "../src/lib/server/analytics/aggregate-day-state";
import { runAggregateOnce, runDailyAggregateRound, AggregateDeadlineExceeded, AggregateCommitUnknown } from "../src/lib/server/analytics/aggregate";
import { runRetentionBatch, runRetentionCleanup } from "../src/lib/server/analytics/retention-cleanup";

describe('M5-T12 defer 合并按 notAfter 判定', { concurrency: false }, () => {
  const notAfter = new Date('2026-03-02T10:00:00.000Z');
  const later = new Date('2026-03-02T10:05:00.000Z');

  test('previous 晚于 notAfter 就保留（即使早于 now）', () => {
    const previous = new Date('2026-03-02T10:03:00.000Z');
    assert.equal(mergeDeferUntil(previous, null, notAfter)?.toISOString(), '2026-03-02T10:03:00.000Z');
    assert.ok(later.getTime() > previous.getTime());
  });

  test('previous 等于或早于 notAfter 一律丢弃', () => {
    assert.equal(mergeDeferUntil(new Date('2026-03-02T10:00:00.000Z'), null, notAfter), null);
    assert.equal(mergeDeferUntil(new Date('2026-03-02T09:59:00.000Z'), null, notAfter), null);
  });

  test('notAfter 晚于 now 时，落在两者之间的 previous 必须丢弃', () => {
    const after = new Date('2026-03-02T10:10:00.000Z');
    const previous = new Date('2026-03-02T10:07:00.000Z');
    assert.ok(previous.getTime() > later.getTime() && previous.getTime() < after.getTime());
    assert.equal(mergeDeferUntil(previous, null, after), null);
  });

  test('新旧 defer 取 min', () => {
    const previous = new Date('2026-03-02T10:30:00.000Z');
    const next = new Date('2026-03-02T10:20:00.000Z');
    assert.equal(mergeDeferUntil(previous, next, notAfter)?.toISOString(), '2026-03-02T10:20:00.000Z');
    assert.equal(mergeDeferUntil(next, previous, notAfter)?.toISOString(), '2026-03-02T10:20:00.000Z');
  });
});

describe('M5-T12 阶段预算：metadata 消耗后主事务不得复用旧配额', { concurrency: false }, () => {
  function onceDb(options: { delayMs: number; transactions: Array<{ at: number; opts: { maxWaitMs?: number; timeoutMs?: number } }> }) {
    let call = 0;
    const query = async (arg: unknown, ...rest: unknown[]) => {
      const { text } = sqlOf(arg, rest);
      if (text.includes('SiteSetting')) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        return [{ value: { version: 1, timezone: 'UTC', timezoneRevision: 3 } }];
      }
      if (text.includes('JobState')) {
        // 第二次事务（主 RR）立即以版本冲突退出，只为观测它拿到的预算。
        if (call > 1) throw new AggregateVersionConflict('stale_generation');
        return [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: new Date(Date.now() + 60_000).toISOString() }];
      }
      return [];
    };
    const execute = async () => 0;
    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>, opts: { maxWaitMs?: number; timeoutMs?: number }) => {
        call += 1;
        options.transactions.push({ at: Date.now(), opts: opts ?? {} });
        return fn({ $queryRaw: query, $executeRaw: execute, $executeRawUnsafe: async () => 0 });
      },
      $queryRaw: query,
      $executeRaw: execute,
    };
    return db;
  }

  const args = (deadlineAt: Date) => ({
    now: PHASE_NOW,
    siteTimezone: 'UTC',
    currentDate: '2026-03-02',
    timezoneRevision: 3,
    generation: 7,
    deadlineAt,
    daily: { baseDates: [] as string[], leaseOwner: 'analytics-aggregate' },
  });

  test('metadata 吃掉几乎全部预算后，主事务一次都不开', async () => {
    const transactions: Array<{ at: number; opts: object }> = [];
    const db = onceDb({ delayMs: 300, transactions });
    await assert.rejects(
      () => runAggregateOnce({ ...args(new Date(Date.now() + 500)), db: db as never } as never),
      AggregateDeadlineExceeded,
    );
    assert.equal(transactions.length, 1, '只允许 metadata 阶段那一次事务');
  });

  test('主事务的 maxWait+timeout 不超过阶段之后的真实剩余', async () => {
    const transactions: Array<{ at: number; opts: { maxWaitMs?: number; timeoutMs?: number } }> = [];
    const db = onceDb({ delayMs: 250, transactions });
    const deadlineAt = new Date(Date.now() + 2_000);
    await assert.rejects(() => runAggregateOnce({ ...args(deadlineAt), db: db as never } as never));
    assert.equal(transactions.length, 2);
    const main = transactions[1]!;
    const granted = (main.opts.maxWaitMs ?? 0) + (main.opts.timeoutMs ?? 0);
    const remainingAtOpen = deadlineAt.getTime() - main.at;
    assert.ok(granted <= remainingAtOpen, `granted=${granted} remaining=${remainingAtOpen}`);
    assert.ok(main.at - transactions[0]!.at >= 200, 'metadata 阶段确实吃掉了时间');
  });
});

describe('M5-T12 B7：COMMIT 答复未知与确认回滚必须分开', { concurrency: false }, () => {
  function phaseDb(mode: 'rollback' | 'lost-receipt') {
    const writes: unknown[] = [];
    const query = async (arg: unknown, ...rest: unknown[]) => {
      const { text } = sqlOf(arg, rest);
      if (text.includes('JobState')) {
        if (mode === 'rollback') throw new AggregateVersionConflict('stale_generation');
        return [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: LIVE_LEASE }];
      }
      if (text.includes('SiteSetting')) return [{ value: { version: 1, timezone: 'UTC', timezoneRevision: 3 } }];
      if (text.includes('AnalyticsDayChange')) return [{ utcDate: OLD_DAY, version: '2' }];
      if (text.includes('AnalyticsAggregateDayState')) return [{ ...planState }];
      return [];
    };
    const execute = async (arg: unknown) => {
      writes.push(arg);
      return 1;
    };
    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const value = await fn({ $queryRaw: query, $executeRaw: execute, $executeRawUnsafe: async () => 0 });
        if (mode === 'lost-receipt') throw new Error('connection lost after commit');
        return value;
      },
      $queryRaw: query,
      $executeRaw: execute,
    };
    return { db, writes };
  }

  test('回调内失败＝确认回滚：原错误上抛、不标 unknown、零写入', async () => {
    const { db, writes } = phaseDb('rollback');
    await assert.rejects(
      () => writeDailyMetadataPhase(db as never, phaseArgs()),
      (error: unknown) => error instanceof AggregateVersionConflict,
    );
    assert.equal(writes.length, 0);
  });

  test('真实提交后丢回执＝unknown：committed 不可当 false，unknownTargets 非空且写入已发生', async () => {
    const { db, writes } = phaseDb('lost-receipt');
    await assert.rejects(
      () => writeDailyMetadataPhase(db as never, phaseArgs()),
      (error: unknown) => {
        assert.ok(error instanceof AggregateCommitUnknown);
        assert.equal(error.phase, 'metadata');
        assert.deepEqual(error.unknownTargets, [OLD_DAY]);
        return true;
      },
    );
    const dayStateWrites = writes.filter((arg) => sqlOf(arg, []).text.includes('AnalyticsAggregateDayState'));
    assert.equal(dayStateWrites.length, 1, '回调已经写过一行：提交可能已落库');
  });
});

describe('M5-T12 B7 包装返回：unknown 必须穿过真实 wrapper/作业入口', { concurrency: false }, () => {
  function dailyDb(mode: 'lost-receipt' | 'rollback') {
    let transactions = 0;
    const query = async (arg: unknown, ...rest: unknown[]) => {
      const { text } = sqlOf(arg, rest);
      if (text.includes('JobState')) {
        if (mode === 'rollback') throw new AggregateVersionConflict('stale_generation');
        return [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: LIVE_LEASE }];
      }
      if (text.includes('SiteSetting')) return [{ value: { version: 1, timezone: 'UTC', timezoneRevision: 3 } }];
      if (text.includes('AnalyticsDayChange')) return [{ utcDate: OLD_DAY, version: '2' }];
      if (text.includes('AnalyticsAggregateDayState')) return [{ ...planState }];
      return [];
    };
    const execute = async () => 1;
    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        transactions += 1;
        const value = await fn({ $queryRaw: query, $executeRaw: execute, $executeRawUnsafe: async () => 0 });
        if (mode === 'lost-receipt') throw new Error('reply lost after commit');
        return value;
      },
      $queryRaw: query,
      $executeRaw: execute,
    };
    return { db, count: () => transactions };
  }

  const roundArgs = () => ({
    now: PHASE_NOW,
    siteTimezone: 'UTC',
    currentDate: '2026-03-02',
    timezoneRevision: 3,
    generation: 7,
    leaseOwner: 'analytics-aggregate',
    baseDates: [OLD_DAY] as string[],
  });

  test('metadata 提交后丢回执：wrapper 返回 status=unknown、committed=null、targets 保留、主事务 0 次', async () => {
    const { db, count } = dailyDb('lost-receipt');
    const result = await runDailyAggregateRound({ ...roundArgs(), db: db as never } as never);
    assert.equal(result.status, 'unknown');
    assert.equal(result.committed, null, '未知提交不能用 [] 冒充没写');
    assert.equal(result.commitUnknown?.phase, 'metadata');
    assert.deepEqual(result.commitUnknown?.targets, [OLD_DAY]);
    assert.equal(count(), 1, '主指标阶段不得在 metadata 未知后开启');
  });

  test('回调内失败：wrapper 返回确认回滚（committed=[]、commitUnknown=null）', async () => {
    const { db } = dailyDb('rollback');
    const result = await runDailyAggregateRound({ ...roundArgs(), db: db as never } as never);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.committed, []);
    assert.equal(result.commitUnknown, null);
  });

  test('作业入口：metadata 丢回执时抛出带 phase/targets 的 AggregateCommitUnknown，主事务 0 次', async () => {
    const { db, count } = dailyDb('lost-receipt');
    await assert.rejects(
      () => runAggregateOnce({
        now: PHASE_NOW,
        siteTimezone: 'UTC',
        currentDate: '2026-03-02',
        timezoneRevision: 3,
        generation: 7,
        daily: { baseDates: [OLD_DAY], leaseOwner: 'analytics-aggregate' },
        db: db as never,
      } as never),
      (error: unknown) => {
        assert.ok(error instanceof AggregateCommitUnknown);
        assert.equal(error.phase, 'metadata');
        assert.deepEqual(error.unknownTargets, [OLD_DAY]);
        return true;
      },
    );
    assert.equal(count(), 1);
  });
});

describe('M5-T12 未知提交不得被 retention 当成确认回滚', { concurrency: false }, () => {
  test('abortsRetentionRun 覆盖 CommitUnknown：不得继续写 gap/删除', async () => {
    const { abortsRetentionRun } = await import("../src/lib/server/analytics/retention");
    assert.equal(abortsRetentionRun(new AggregateCommitUnknown('metrics', ['2026-03-01'])), true);
    assert.equal(abortsRetentionRun(new AggregateCommitUnknown('metadata', ['2026-03-01'])), true);
    assert.equal(abortsRetentionRun(new AggregateVersionConflict('write_conflict')), true);
    assert.equal(abortsRetentionRun(new Error('ordinary aggregate failure')), false);
  });
});

describe('M5-T12 主事务未知时，已确认提交的 metadata 必须保留', { concurrency: false }, () => {
  test('metadata 成功提交、main 丢回执：返回 unknown 且 metadata 结果仍在', async () => {
    let transactions = 0;
    const query = async (arg: unknown, ...rest: unknown[]) => {
      const { text } = sqlOf(arg, rest);
      if (text.includes('JobState')) return [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: LIVE_LEASE }];
      if (text.includes('SiteSetting')) return [{ value: { version: 1, timezone: 'UTC', timezoneRevision: 3 } }];
      if (text.includes('AnalyticsDayChange')) return [{ utcDate: OLD_DAY, version: '2' }];
      if (text.includes('AnalyticsAggregateDayState')) return [{ ...planState }];
      return [];
    };
    const execute = async () => 1;
    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        transactions += 1;
        const value = await fn({ $queryRaw: query, $executeRaw: execute, $executeRawUnsafe: async () => 0 });
        if (transactions === 2) throw new Error('reply lost after commit');
        return value;
      },
      $queryRaw: query,
      $executeRaw: execute,
    };
    const result = await runDailyAggregateRound({
      now: PHASE_NOW,
      siteTimezone: 'UTC',
      currentDate: '2026-03-02',
      timezoneRevision: 3,
      generation: 7,
      leaseOwner: 'analytics-aggregate',
      baseDates: [],
      db: db as never,
    } as never);
    assert.equal(result.status, 'unknown');
    assert.equal(result.committed, null);
    assert.equal(result.commitUnknown?.phase, 'metrics');
    assert.ok(result.metadata.length >= 1, '主事务未知不得抹掉已确认的 metadata 结果');
    assert.ok(result.metadata.some((item) => item.localDate === OLD_DAY));
    assert.equal(transactions, 2);
  });
});

describe('M5-T12 GC 批次事务：COMMIT 未知与确认回滚分开', { concurrency: false }, () => {
  function batchDb(mode: 'ok' | 'callback-throws' | 'lost-receipt' | 'pool-timeout') {
    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<number>) => {
        if (mode === 'pool-timeout') throw Object.assign(new Error('pool timeout'), { code: 'P2024' });
        const value = await fn({ $executeRaw: async () => 7 });
        if (mode === 'lost-receipt') throw new Error('reply lost after commit');
        return value;
      },
    };
    return db;
  }

  test('正常提交：返回受影响行数', async () => {
    const count = await runRetentionBatch(batchDb('ok') as never, ['2026-03-01'], async (tx) => {
      const affected = await (tx as unknown as { $executeRaw: () => Promise<number> }).$executeRaw();
      return Number(affected);
    });
    assert.equal(count, 7);
  });

  test('回调内失败＝确认回滚：原错误上抛，不标 unknown', async () => {
    const failure = new AggregateVersionConflict('stale_generation');
    await assert.rejects(
      () => runRetentionBatch(batchDb('callback-throws') as never, ['2026-03-01'], async () => { throw failure; }),
      (error: unknown) => error instanceof AggregateVersionConflict,
    );
  });

  test('模拟提交成功后丢回执＝unknown：保留 targets，交由调用方停止后续批次', async () => {
    await assert.rejects(
      () => runRetentionBatch(batchDb('lost-receipt') as never, ['2026-03-01'], async () => 7),
      (error: unknown) => {
        assert.ok(error instanceof AggregateCommitUnknown);
        assert.equal(error.phase, 'metrics');
        assert.deepEqual(error.unknownTargets, ['2026-03-01']);
        return true;
      },
    );
  });

  test('P2024（事务未开）不算 unknown，原样上抛', async () => {
    await assert.rejects(
      () => runRetentionBatch(batchDb('pool-timeout') as never, ['2026-03-01'], async () => 7),
      (error: unknown) => (error as { code?: string }).code === 'P2024',
    );
  });
});

describe('M5-T12 retention-cleanup 整体消费者：批次 COMMIT 未知即停且不写 FAILED', { concurrency: false }, () => {
  const NOW = new Date('2026-05-01T00:00:00.000Z');
  const LOCKED = new Date('2026-05-01T01:00:00.000Z').toISOString();
  const view = {
    key: 'analytics-aggregate' as const,
    generation: 3,
    lastStatus: 'NEVER' as const,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSucceededAt: null,
    lockedUntil: LOCKED,
    leaseActive: true,
    lastErrorCode: null,
    summary: null,
  };

  function build(mode: 'lost-receipt' | 'callback-fails' | 'event-zero') {
    const records = { completions: [] as Array<{ status: string; errorCode: string | null }>, renews: 0 };
    let transaction = 0;
    let batches = 0;
    const settings = {
      value: JSON.stringify({ version: 0, timezone: 'UTC', timezoneRevision: 1, changedAt: NOW.toISOString(), updatedBy: null }),
    };
    const query = async (arg: unknown) => {
      const text = Array.isArray(arg) ? arg.join('?') : ((arg as { strings?: readonly string[] }).strings ?? []).join('?');
      if (text.includes('FROM "SiteSetting"')) return [settings];
      if (text.includes('FROM "AnalyticsRollupDay"') && text.includes('"timezoneRevision" = ')) {
        return [{ siteDate: '2026-01-01' }];
      }
      if (text.includes('FROM "AnalyticsRollupDay"') && text.includes('"siteDate" = ')) {
        return [{ timezoneRevision: 1 }];
      }
      if (text.includes('FROM "AnalyticsRollupDay"')) return [{ siteDate: '2026-01-01', timezoneRevision: 1 }];
      if (text.includes('FROM "AnalyticsEvent"') && text.includes('"receivedAt" <')) return [{ count: 1 }];
      if (text.includes('FROM "AnalyticsEvent"')) return [{ count: 1 }];
      if (text.includes('FROM "AnalyticsDailyRollup"')) return [{ count: 0 }];
      if (text.includes('FROM "AnalyticsDaily"') && text.includes('"expiresAt" >')) return [];
      if (text.includes('FROM "AnalyticsDaily"')) return [{ count: 0 }];
      if (text.includes('FROM "AnalyticsAggregateDayState"')) return [];
      if (text.includes('FROM "AnalyticsDayChange"')) return [{ count: 0 }];
      return [];
    };
    const execute = async () => {
      batches += 1;
      if (mode === 'callback-fails' && batches === 2) throw new Error('batch_callback');
      // 事件删除批次删到 0 行：已提交但没有删到任何行。
      if (mode === 'event-zero') return 0;
      return 1;
    };
    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        transaction += 1;
        const before = batches;
        const value = await fn({ $queryRaw: query, $executeRaw: execute, $executeRawUnsafe: async () => 0 });
        if (mode === 'lost-receipt' && batches > before && batches === 2) {
          throw new Error('reply lost after commit');
        }
        return value;
      },
      $queryRaw: query,
      $executeRaw: execute,
    };
    const repo = {
      claimPreservingStatus: async () => ({ acquired: true as const, generation: 3, lockedUntil: LOCKED, timezoneRevision: 1, view }),
      renew: async () => {
        records.renews += 1;
        return { renewed: true as const, generation: 3, lockedUntil: LOCKED, view };
      },
      completeSeparately: async (input: { status: string; errorCode: string | null }) => {
        records.completions.push({ status: input.status, errorCode: input.errorCode });
        return { committed: true as const, view };
      },
    };
    return { db, repo, records, transactions: () => transaction, batches: () => batches };
  }

  function args(built: ReturnType<typeof build>) {
    return {
      db: built.db as never,
      clock: () => NOW,
      mode: 'delete' as const,
      batchSize: 1,
      maxPerRun: 5,
      audit: async () => {},
      repoFactory: () => built.repo as never,
    };
  }

  test('首批已确认、后批模拟丢回执：后续批次 0、FAILED 终态 0、已确认行数与批次数都保留', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...logArgs: unknown[]) => {
      errors.push(logArgs.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
    try {
      const built = build('lost-receipt');
      const result = await runRetentionCleanup(args(built) as never);
      assert.equal(result.status, 'unknown', '未知提交不得折叠成 failed');
      assert.equal(result.deletedEvents, 1, '只保留首批已确认 1 行');
      if (result.status === 'unknown') {
        assert.equal(result.phase, 'metrics');
        assert.ok(result.targets.length >= 1);
      }
      assert.deepEqual(built.records.completions, [], '不得写任何终态（尤其不能是 FAILED）');
      assert.equal(built.batches(), 2, '第二批未知后不得再开批次');
      // 同一 runRetentionCleanup 消费者的结构化日志：已确认批次必须已记 1，未知批次不得计入。
      const logged = errors.find((line) => line.includes('commit_unknown'));
      assert.ok(logged, '未知提交必须有结构化日志');
      const payload = JSON.parse(logged.slice(logged.indexOf('{'))) as Record<string, unknown>;
      assert.equal(payload.confirmedBatches, 1, '首批已确认的批次数必须立刻保留，不能等全部 drain 结束');
      assert.equal(payload.confirmedDeletedEvents, 1);
      assert.equal(payload.confirmedDeletedRollupRows, 0);
      assert.equal(payload.phase, 'metrics');
      assert.ok(Number(payload.targets) >= 1);
    } finally {
      console.error = originalError;
    }
  });

  test('事件批次删到 0 行：已提交但 batches 与行数都不得记成 1', async () => {
    const built = build('event-zero');
    const result = await runRetentionCleanup(args(built) as never);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.deletedEvents, 0, '0 行提交不能记成删到 1 行');
    assert.equal(result.deletedRollupRows, 0);
    assert.equal(result.batches, 0, '0 行提交不能记成 1 个确认批次');
    // 0 行即停：不再继续开后续批次；终态仍是正常完成。
    assert.deepEqual(built.records.completions.map((item) => item.status), ['SUCCEEDED']);
  });
  test('对照：批次回调内失败是确认失败，finish(FAILED) 必须被记录', async () => {
    const built = build('callback-fails');
    const result = await runRetentionCleanup(args(built) as never);
    assert.equal(result.status, 'failed');
    assert.equal(built.records.completions.length, 1, '观察点必须能到达 finish 分支');
    assert.equal(built.records.completions[0]?.status, 'FAILED');
    assert.equal(result.deletedEvents, 1);
  });
});

describe('M5-T12 阶段证据：按执行位置判别，不用错误码白名单', { concurrency: false }, () => {
  const codes = [
    { code: 'P2028' },
    { meta: { code: '57014' } },
    { meta: { code: '55P03' } },
  ];

  test('回调内 57014＝确认回滚：原错误上抛，不是 unknown', async () => {
    const failure = Object.assign(new Error('statement timeout'), { meta: { code: '57014' } });
    const db = { $transaction: async (fn: (tx: unknown) => Promise<number>) => fn({ $executeRaw: async () => 1 }) };
    await assert.rejects(
      () => runRetentionBatch(db as never, ['2026-03-01'], async () => { throw failure; }),
      (error: unknown) => error === failure,
    );
  });

  test('回调返回后三种码（P2028/57014/55P03）一律 unknown', async () => {
    for (const shape of codes) {
      const db = { $transaction: async (fn: (tx: unknown) => Promise<number>) => { await fn({ $executeRaw: async () => 1 }); throw Object.assign(new Error('post-callback'), shape); } };
      await assert.rejects(
        () => runRetentionBatch(db as never, ['2026-03-01'], async () => 1),
        (error: unknown) => {
          assert.ok(error instanceof AggregateCommitUnknown);
          assert.deepEqual(error.unknownTargets, ['2026-03-01']);
          return true;
        },
      );
    }
  });

  test('BEGIN 前 P2024＝确认无提交，原错误上抛不算 unknown', async () => {
    const db = { $transaction: async () => { throw Object.assign(new Error('pool timeout'), { code: 'P2024' }); } };
    await assert.rejects(
      () => runRetentionBatch(db as never, ['2026-03-01'], async () => 1),
      (error: unknown) => !(error instanceof AggregateCommitUnknown) && (error as { code?: string }).code === 'P2024',
    );
  });

  test('aggregate 元数据阶段：回调返回后 57014 也必须落 unknown', async () => {
    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        await fn({
          $queryRaw: async (arg: unknown) => {
            const text = Array.isArray(arg) ? arg.join('?') : ((arg as { strings?: readonly string[] }).strings ?? []).join('?');
            if (text.includes('JobState')) return [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: new Date(Date.now() + 60_000).toISOString() }];
            if (text.includes('SiteSetting')) return [{ value: { version: 1, timezone: 'UTC', timezoneRevision: 3, changedAt: '2026-03-02T10:00:00.000Z', updatedBy: null } }];
            return [];
          },
          $executeRaw: async () => 1,
          $executeRawUnsafe: async () => 0,
        });
        throw Object.assign(new Error('statement timeout'), { meta: { code: '57014' } });
      },
      $queryRaw: async () => [],
      $executeRaw: async () => 1,
    };
    await assert.rejects(
      () => runAggregateOnce({
        now: PHASE_NOW,
        siteTimezone: 'UTC',
        currentDate: '2026-03-02',
        timezoneRevision: 3,
        generation: 7,
        daily: { baseDates: [], leaseOwner: 'analytics-aggregate' },
        db: db as never,
      } as never),
      (error: unknown) => {
        assert.ok(error instanceof AggregateCommitUnknown);
        assert.equal(error.phase, 'metadata');
        return true;
      },
    );
  });
});
describe('M5-T12 wrapper 主事务：按执行位置判 unknown，不看错误码', { concurrency: false }, () => {
  const codes = [
    { name: 'P2028', make: () => Object.assign(new Error('transaction closed'), { code: 'P2028' }) },
    { name: '57014', make: () => Object.assign(new Error('statement timeout'), { meta: { code: '57014' } }) },
    { name: '55P03', make: () => Object.assign(new Error('lock not available'), { meta: { code: '55P03' } }) },
  ];

  function wrapperQuery() {
    return async (arg: unknown, ...rest: unknown[]) => {
      const { text } = sqlOf(arg, rest);
      if (text.includes('JobState')) return [{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: LIVE_LEASE }];
      if (text.includes('SiteSetting')) return [{ value: { version: 1, timezone: 'UTC', timezoneRevision: 3 } }];
      if (text.includes('AnalyticsDayChange')) return [{ utcDate: OLD_DAY, version: '2' }];
      if (text.includes('AnalyticsAggregateDayState')) return [{ ...planState }];
      return [];
    };
  }

  function wrapperTx(overrides: Record<string, unknown> = {}) {
    return { $queryRaw: wrapperQuery(), $executeRaw: async () => 1, $executeRawUnsafe: async () => 0, ...overrides };
  }

  /** 事务 #1 = 独立 metadata 阶段，事务 #2 = 主指标事务；三档故障点各不相同。 */
  function roundDb(mode: 'post-callback' | 'callback' | 'pre-begin', failure: Error) {
    const state = { transactions: 0 };
    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        state.transactions += 1;
        const current = state.transactions;
        if (mode === 'pre-begin' && current === 2) throw failure;
        if (mode === 'callback' && current === 2) {
          return await fn(wrapperTx({ $queryRaw: async () => { throw failure; } }));
        }
        const value = await fn(wrapperTx());
        if (mode === 'post-callback' && current === 2) throw failure;
        return value;
      },
      $queryRaw: wrapperQuery(),
      $executeRaw: async () => 1,
    };
    return { db, state };
  }

  const roundArgs = (db: unknown) => ({
    now: PHASE_NOW,
    siteTimezone: 'UTC',
    currentDate: '2026-03-02',
    timezoneRevision: 3,
    generation: 7,
    leaseOwner: 'analytics-aggregate',
    baseDates: [OLD_DAY] as string[],
    db: db as never,
  } as never);

  for (const shape of codes) {
    test(`主事务回调返回后 ${shape.name}＝unknown，不按码表判回滚`, async () => {
      const { db, state } = roundDb('post-callback', shape.make());
      const result = await runDailyAggregateRound(roundArgs(db));
      assert.equal(result.status, 'unknown');
      assert.equal(result.errorCode, 'commit_unknown');
      assert.equal(result.committed, null, '未知提交不能用 [] 冒充没写');
      assert.equal(result.commitUnknown?.phase, 'metrics');
      assert.ok(result.commitUnknown.targets.includes(OLD_DAY));
      // 已确认的 metadata 结果必须保留；未知后不得再补 gap、写 FAILED 或开新事务。
      assert.ok(result.metadata.some((item) => item.localDate === OLD_DAY));
      assert.deepEqual(result.gaps, []);
      assert.equal(state.transactions, 2, '未知后不得再开事务');
    });
  }

  test('主事务回调内 57014＝确认回滚（预算中止 + gap），不是 unknown', async () => {
    const failure = codes[1]!.make();
    const { db } = roundDb('callback', failure);
    const result = await runDailyAggregateRound(roundArgs(db));
    assert.notEqual(result.status, 'unknown');
    assert.equal(result.commitUnknown, null);
    assert.deepEqual(result.committed, [], '回调内失败＝确认回滚');
    assert.equal(result.status, 'budget');
    assert.equal(result.gaps.length, 1, '确认回滚后才允许在独立事务里记 gap');
  });

  test('主事务 BEGIN 前 P2024＝确认无提交：原错误上抛不算 unknown', async () => {
    const failure = Object.assign(new Error('pool timeout'), { code: 'P2024' });
    const { db } = runPreBeginDb(failure);
    await assert.rejects(
      () => runDailyAggregateRound(roundArgs(db)),
      (error: unknown) => {
        assert.equal(error, failure);
        assert.equal(error instanceof AggregateCommitUnknown, false);
        return true;
      },
    );
  });

  function runPreBeginDb(failure: Error) {
    const state = { transactions: 0 };
    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        state.transactions += 1;
        if (state.transactions === 2) throw failure;
        return await fn(wrapperTx());
      },
      $queryRaw: wrapperQuery(),
      $executeRaw: async () => 1,
    };
    return { db, state };
  }

  test('作业入口 runAggregateOnce 主事务（metrics）回调返回后三码一律 AggregateCommitUnknown', async () => {
    for (const shape of codes) {
      let transactions = 0;
      const db = {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          transactions += 1;
          const value = await fn(wrapperTx());
          // 事务 #1 是 daily 的 metadata 阶段；#2 起就是 runAggregateOnce 的主事务（daily 主事务在其内）。
          if (transactions >= 2) throw shape.make();
          return value;
        },
        $queryRaw: wrapperQuery(),
        $executeRaw: async () => 1,
      };
      await assert.rejects(
        () => runAggregateOnce({
          now: PHASE_NOW,
          siteTimezone: 'UTC',
          currentDate: '2026-03-02',
          timezoneRevision: 3,
          generation: 7,
          daily: { baseDates: [], leaseOwner: 'analytics-aggregate' },
          db: db as never,
        } as never),
        (error: unknown) => {
          assert.ok(error instanceof AggregateCommitUnknown);
          assert.equal(error.phase, 'metrics');
          assert.ok(error.unknownTargets.length >= 1);
          return true;
        },
      );
    }
  });

  test('作业入口 runAggregateOnce 主事务 BEGIN 前 P2024 上抛原错误，不是 unknown', async () => {
    const failure = Object.assign(new Error('pool timeout'), { code: 'P2024' });
    const db = {
      $transaction: async () => { throw failure; },
      $queryRaw: async () => [],
      $executeRaw: async () => 0,
    };
    await assert.rejects(
      () => runAggregateOnce({
        now: PHASE_NOW,
        siteTimezone: 'UTC',
        currentDate: '2026-03-02',
        timezoneRevision: 3,
        generation: 7,
        daily: { baseDates: [], leaseOwner: 'analytics-aggregate' },
        db: db as never,
      } as never),
      (error: unknown) => {
        assert.equal(error, failure);
        assert.equal(error instanceof AggregateCommitUnknown, false);
        return true;
      },
    );
  });
});