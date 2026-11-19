import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  dailyCoverageStart,
  DailyRoundHalt,
  runAggregateOnce,
  runDailyAggregateRound,
  runDailyInTx,
  writeDailyMetadataPhase,
} from '../src/lib/server/analytics/aggregate';
import { RAW_EVENT_RETENTION_MS } from '../src/lib/analytics/day-boundaries';

const NOW = new Date('2026-03-05T00:00:00.000Z');
const RAW_CUTOFF = new Date('2026-02-03T00:00:00.000Z');
const OLD_DAY = '2026-02-03';
const OWNER = 'coverage-test';

type Call = { tx: number; kind: 'query' | 'execute'; sql: string; values: unknown[] };
function flatten(values: unknown[]): unknown[] {
  return values.flatMap((value) => value !== null && typeof value === 'object' && 'values' in value
    ? flatten((value as { values: unknown[] }).values) : [value]);
}
function sqlOf(arg: unknown, values: unknown[]) {
  if (Array.isArray(arg)) {
    const sql = Prisma.sql(arg as unknown as TemplateStringsArray, ...values);
    return { sql: sql.strings.join('?'), values: flatten(sql.values) };
  }
  const object = arg as { strings: readonly string[]; values: unknown[] };
  return { sql: object.strings.join('?'), values: flatten(object.values) };
}

function state(date: string) {
  return {
    localDate: date, timezoneRevision: 3, timezone: 'UTC', markerVersions: { [date]: '1' },
    deferUntil: null, gapKind: null, gapSince: null, updatedAt: '2026-03-04T00:00:00.000Z',
  };
}

/** SQL 记录替身只模拟查询结果和回调提交/回滚；不把这些断言冒充 PostgreSQL 执行。 */
function fixture(options: { dates?: string[]; terminalDay?: string; startDay?: string } = {}) {
  const calls: Call[] = [];
  const transactions: Array<{ id: number; status: 'running' | 'committed' | 'rolled_back' }> = [];
  const dates = options.dates ?? [];
  const makeTx = (id: number) => ({
    $queryRaw: async (arg: unknown, ...rest: unknown[]) => {
      const call = { tx: id, kind: 'query' as const, ...sqlOf(arg, rest) };
      calls.push(call);
      if (call.sql.includes('JobState')) return [{ generation: 7, leaseOwner: OWNER, lockedUntil: '2026-04-01T00:00:00.000Z' }];
      if (call.sql.includes('SiteSetting')) return [{ value: { version: 1, timezone: 'UTC', timezoneRevision: 3 } }];
      if (call.sql.includes('AnalyticsDayChange')) return dates.map((date) => ({ utcDate: date, version: '2' }));
      if (call.sql.includes('AnalyticsAggregateDayState')) {
        return dates.map(state).filter((row) => !call.sql.includes('WHERE "localDate" =') || call.values.includes(row.localDate));
      }
      if (/FROM "AnalyticsDaily"\s/.test(call.sql)) return dates.map((localDate) => ({ localDate }));
      if (call.sql.includes('AnalyticsEvent')) {
        if (options.terminalDay && call.sql.includes('"durationMs"') && call.values.includes(`${options.terminalDay}T00:00:00.000Z`)) {
          return [{ eventId: 'terminal', kind: 'model_load_success', browserHash: 'browser', viewId: 'view',
            occurredAt: `${options.terminalDay}T12:00:00.000Z`, receivedAt: '2026-03-04T23:00:00.000Z',
            durationMs: 100, locale: 'en', productSlug: null, path: '/en' }];
        }
        if (options.startDay && call.sql.includes('LIMIT 1') && call.sql.includes("'model_view_start'")) {
          return [{ occurredAt: `${options.startDay}T12:00:00.000Z` }];
        }
        return [];
      }
      return [];
    },
    $executeRaw: async (arg: unknown, ...rest: unknown[]) => {
      calls.push({ tx: id, kind: 'execute', ...sqlOf(arg, rest) });
      return 1;
    },
    $executeRawUnsafe: async () => 0,
  });
  const db = {
    ...makeTx(0),
    $transaction: async <T>(fn: (tx: ReturnType<typeof makeTx>) => Promise<T>) => {
      const record = { id: transactions.length + 1, status: 'running' as 'running' | 'committed' | 'rolled_back' };
      transactions.push(record);
      try {
        const result = await fn(makeTx(record.id));
        record.status = 'committed';
        return result;
      } catch (error) {
        record.status = 'rolled_back';
        throw error;
      }
    },
  };
  return { db, tx: makeTx(0), calls, transactions };
}

function args(rawCutoff = RAW_CUTOFF, baseDates = new Set([OLD_DAY])) {
  return {
    now: NOW, cutoff: NOW, notAfter: NOW, rawCutoff,
    timezone: 'UTC', revision: 3, floor: '2025-02-01', today: '2026-03-05',
    generation: 7, leaseOwner: OWNER, leaseClock: () => NOW, baseDates,
    maxDays: 500, deadlineReached: () => false, resolveProduct: () => null,
  };
}

const rawQueries = (calls: Call[]) => calls.filter((call) => call.kind === 'query' && call.sql.includes('AnalyticsEvent'));
const metricWrites = (calls: Call[]) => calls.filter((call) => call.kind === 'execute' && /(?:DELETE FROM|INSERT INTO) "AnalyticsDaily"\s/.test(call.sql));
const stateWrites = (calls: Call[]) => calls.filter((call) => call.kind === 'execute' && call.sql.includes('AnalyticsAggregateDayState'));

describe('M5-T12 coverageStart strict eventCutoff + five minutes', () => {
  const cases = [
    ['日界相等', '2026-03-05T00:00:00Z', 'UTC', '2026-02-03T00:00:00Z', '2026-02-04T00:00:00.000Z'],
    ['日界前两分钟', '2026-03-04T23:58:00Z', 'UTC', '2026-02-02T23:58:00Z', '2026-02-04T00:00:00.000Z'],
    ['安全窗终点恰等日界', '2026-03-04T23:55:00Z', 'UTC', '2026-02-02T23:55:00Z', '2026-02-04T00:00:00.000Z'],
    ['安全窗终点早于日界一毫秒', '2026-03-04T23:54:59.999Z', 'UTC', '2026-02-02T23:54:59.999Z', '2026-02-03T00:00:00.000Z'],
    ['普通日', '2026-03-04T12:00:00Z', 'UTC', '2026-02-02T12:00:00Z', '2026-02-03T00:00:00.000Z'],
    ['显式更晚接收截止', '2026-03-05T00:00:00Z', 'UTC', '2026-02-04T00:00:00Z', '2026-02-05T00:00:00.000Z'],
    ['保留期日界取max', '2026-03-05T00:00:00Z', 'UTC', '2026-02-01T00:00:00Z', '2026-02-03T00:00:00.000Z'],
    ['非整点偏移', '2026-03-04T18:30:00Z', 'Asia/Kolkata', '2026-02-02T18:30:00Z', '2026-02-03T18:30:00.000Z'],
    ['DST 23小时日', '2026-03-09T12:00:00Z', 'America/New_York', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00.000Z'],
    ['DST 25小时日', '2026-11-02T12:00:00Z', 'America/New_York', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00.000Z'],
  ];
  for (const [label, now, timezone, cutoff, expected] of cases) {
    test(label!, () => assert.equal(dailyCoverageStart(new Date(now!), timezone!, new Date(cutoff!)), expected));
  }
});

describe('M5-T12 main and metadata use the same receivedAt coverage boundary', { concurrency: false }, () => {
  for (const source of ['base', 'dirty'] as const) {
    for (const [label, cutoff, expectedOld] of [
      ['日界相等', RAW_CUTOFF, true],
      ['日界前两分钟', new Date('2026-02-02T23:58:00Z'), true],
      ['安全窗恰等日界', new Date('2026-02-02T23:55:00Z'), true],
      ['安全窗早一毫秒', new Date('2026-02-02T23:54:59.999Z'), false],
    ] as const) {
      test(`${source}: ${label}`, async () => {
        // 较早的业务now使此表能独立检验eventCutoff，而不是由30天floor遮住结果。
        const now = new Date('2026-03-04T23:54:59.999Z');
        const options = { ...args(cutoff, source === 'base' ? new Set([OLD_DAY]) : new Set<string>()), now, cutoff: now, notAfter: now };
        const main = fixture({ dates: [OLD_DAY] });
        const result = await runDailyInTx(main.tx as never, options);
        assert.deepEqual(result.metadataDays, expectedOld ? [{ date: OLD_DAY, action: 'coverage' }] : []);
        assert.deepEqual(result.result.targets, expectedOld ? [] : [OLD_DAY]);
        assert.equal(rawQueries(main.calls).length === 0, expectedOld);
        assert.equal(metricWrites(main.calls).length === 0, expectedOld);
        if (!expectedOld) {
          assert.ok(rawQueries(main.calls).every((call) => call.values.includes(cutoff.toISOString())), '原始事实读取仍用未加五分钟的receivedAt截止');
        }
        const metadata = fixture({ dates: [OLD_DAY] });
        const phase = await writeDailyMetadataPhase(metadata.db as never, options);
        assert.deepEqual(phase.written.map((item) => item.localDate), expectedOld ? [OLD_DAY] : []);
        assert.equal(rawQueries(metadata.calls).length, 0);
        assert.equal(metricWrites(metadata.calls).length, 0, '独立metadata不得删除或替换旧指标');
        if (expectedOld) {
          const write = stateWrites(metadata.calls)[0];
          assert.ok(write);
          assert.ok(write.values.includes('raw_partial'));
          assert.ok(write.values.includes(JSON.stringify({ [OLD_DAY]: '2' })), '消费本轮live marker');
          assert.ok(write.values.includes(JSON.stringify({ [OLD_DAY]: '1' })), 'CAS仍比较plan marker');
          assert.ok(write.values.includes(state(OLD_DAY).updatedAt), 'CAS仍比较plan updatedAt');
        }
      });
    }
  }

  test('固定UTC反例默认rawCutoff：wrapper先独立raw_partial，主事务不读该日raw也不改旧指标', async () => {
    assert.equal(NOW.getTime() - RAW_EVENT_RETENTION_MS, RAW_CUTOFF.getTime());
    const built = fixture({ dates: [OLD_DAY] });
    const result = await runDailyAggregateRound({
      db: built.db as never, now: NOW, siteTimezone: 'UTC', timezoneRevision: 3,
      currentDate: '2026-03-05', baseDates: [OLD_DAY], generation: 7, leaseOwner: OWNER, clock: () => NOW,
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.committed, []);
    assert.deepEqual(result.metadata, [{ localDate: OLD_DAY, action: 'coverage', result: 'updated' }]);
    assert.equal(rawQueries(built.calls).length, 0);
    assert.equal(metricWrites(built.calls).length, 0);
    assert.deepEqual([...new Set(stateWrites(built.calls).map((call) => call.tx))], [1]);
    assert.deepEqual(built.transactions.map((tx) => tx.status), ['committed', 'committed']);
  });

  test('runAggregateOnce把显式rawCutoff同时传给metadata和daily主事务', async () => {
    const date = '2026-02-04';
    const built = fixture({ dates: [date] });
    const result = await runAggregateOnce({
      db: built.db as never, now: NOW, siteTimezone: 'UTC', timezoneRevision: 3,
      currentDate: '2026-03-05', generation: 7, clock: () => NOW,
      daily: { baseDates: [date], rawCutoff: new Date('2026-02-04T00:00:00Z'), leaseOwner: OWNER },
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.daily?.committed, []);
    assert.ok(stateWrites(built.calls).some((call) => call.tx === 1 && call.values.includes('raw_partial')));
    assert.equal(metricWrites(built.calls).length, 0);
    // 旧rollup仍会读近期raw；只断言日轮不可触碰受保护旧日。
    assert.ok(rawQueries(built.calls).every((call) => !call.values.includes(`${date}T00:00:00.000Z`)));
  });
});

describe('M5-T12 closure uses the same strict coverage boundary', { concurrency: false }, () => {
  test('闭包发现受保护日：整笔指标回滚，独立CAS raw_partial，不读该日raw', async () => {
    const built = fixture({ terminalDay: '2026-02-04', startDay: OLD_DAY });
    const result = await runDailyAggregateRound({
      db: built.db as never, now: NOW, rawCutoff: RAW_CUTOFF,
      siteTimezone: 'UTC', timezoneRevision: 3, currentDate: '2026-03-05',
      baseDates: ['2026-02-04'], generation: 7, leaseOwner: OWNER, clock: () => NOW,
    });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.committed, []);
    assert.ok(result.metadata.some((item) => item.localDate === OLD_DAY && item.action === 'coverage'));
    assert.deepEqual(built.transactions.map((tx) => tx.status), ['committed', 'rolled_back', 'committed']);
    assert.ok(stateWrites(built.calls).some((call) => call.tx === 3 && call.values.includes('raw_partial')));
    const bounded = rawQueries(built.calls).filter((call) => call.sql.includes('"occurredAt" >='));
    for (const call of bounded) {
      const start = call.values.find((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value));
      assert.notEqual(start, `${OLD_DAY}T00:00:00.000Z`);
    }
    assert.ok(metricWrites(built.calls).every((call) => call.tx === 2 && !call.values.includes(OLD_DAY)));
  });

  test('闭包日恰等coverageStart：可重算，raw读取保留原cutoff', async () => {
    const built = fixture({ terminalDay: '2026-02-05', startDay: '2026-02-04' });
    const result = await runDailyInTx(built.tx as never, args(RAW_CUTOFF, new Set(['2026-02-05'])));
    assert.deepEqual(result.result.committed, ['2026-02-05', '2026-02-04']);
    assert.deepEqual(result.closureMeta, []);
    assert.ok(rawQueries(built.calls).some((call) => call.values.includes('2026-02-04T00:00:00.000Z')));
    assert.ok(rawQueries(built.calls).every((call) => call.values.includes(RAW_CUTOFF.toISOString())));
  });

  test('主事务直接入口在闭包coverage中止时保留原期望值', async () => {
    const built = fixture({ terminalDay: '2026-02-04', startDay: OLD_DAY });
    await assert.rejects(
      () => runDailyInTx(built.tx as never, args(RAW_CUTOFF, new Set(['2026-02-04']))),
      (error: unknown) => {
        assert.ok(error instanceof DailyRoundHalt);
        assert.equal(error.halt.kind, 'coverage');
        assert.deepEqual(error.coveragePending, [{ date: OLD_DAY, expected: { markers: {}, updatedAt: null, deferUntil: null } }]);
        return true;
      },
    );
  });
});
