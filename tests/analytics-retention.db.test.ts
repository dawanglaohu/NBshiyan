// M5-T11 分析保留作业：纯逻辑、registry/cron 接线与隔离 PostgreSQL 验收。
//
// 纯用例（不连库）覆盖模式判定、operations 的 dryRun 透传与 cron 只有一条保留任务；
// 真实库用例只在 M5T11_TEST_DATABASE_URL 存在时跑（loopback 才允许），
// M5T11_REQUIRE_DATABASE=true 时缺地址直接失败、不静默 skip。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Prisma, PrismaClient } from '@prisma/client';
import { createOperationsHandler, createJobRegistry } from '../src/lib/server/jobs/registry';
import {
  ANALYTICS_RETENTION_KEY,
  abortsRetentionRun,
  classifyHistoricalDays,
  coverageOfHistory,
  createAnalyticsRetentionJob,
  resolveRetentionMode,
  runAnalyticsRetention,
  worstCoverage,
} from '../src/lib/server/analytics/retention';
import {
  eventExpiryCutoff,
  rollupExpiryCutoff,
  shiftCalendarMonths,
} from '../src/lib/server/analytics/retention-plan';
import { createJobLeaseRepo } from '../src/lib/server/jobs/lease-repo';
import {
  AggregateDeadlineExceeded,
  AggregateGuardFailure,
  AggregateVersionConflict,
  aggregateOneDayInSnapshot,
  assertCurrentTimezoneRevision,
} from '../src/lib/server/analytics/aggregate';
import { ANALYTICS_ROLLUP_JOB_KEY } from '../src/lib/server/analytics/rollup';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';

const TZ = 'Asia/Shanghai';
const SECRET = 's'.repeat(40);

/* ------------------------------------------------------------------ 纯用例 */

test('保留模式：默认、已授权但未请求、未授权请求都落回 dry-run', () => {
  assert.deepEqual(resolveRetentionMode({}), { mode: 'dry-run', rejected: false });
  assert.deepEqual(resolveRetentionMode({ requestedDelete: false, authorized: true }), { mode: 'dry-run', rejected: false });
  assert.deepEqual(resolveRetentionMode({ requestedDelete: true }), { mode: 'dry-run', rejected: true });
  assert.deepEqual(resolveRetentionMode({ requestedDelete: true, authorized: false }), { mode: 'dry-run', rejected: true });
  assert.deepEqual(resolveRetentionMode({ requestedDelete: true, authorized: true }), { mode: 'delete', rejected: false });
});

test('历史受影响日分类：可重算 / 旧行留存 / 缺口 / 已过期四类与最坏覆盖度', () => {
  const partition = classifyHistoricalDays({
    completeRawCoverageStartUtc: '2027-02-13T16:00:00.000Z',
    rollupExpiryThrough: '2026-02-15',
    days: [
      // 已过 13 个自然月：按保留规则到期，不记缺口。
      { siteDate: '2026-01-10', dayStartUtc: '2026-01-09T16:00:00.000Z', hasAggregate: true },
      // 仍有旧 AnalyticsRollupDay 行：保留实物，报 retained；完整性未确认，不是当前口径。
      { siteDate: '2027-02-08', dayStartUtc: '2027-02-07T16:00:00.000Z', hasAggregate: true },
      { siteDate: '2027-02-10', dayStartUtc: '2027-02-09T16:00:00.000Z', hasAggregate: true },
      // 无旧行：缺口。
      { siteDate: '2027-02-11', dayStartUtc: '2027-02-10T16:00:00.000Z', hasAggregate: false },
      { siteDate: '2027-02-12', dayStartUtc: '2027-02-11T16:00:00.000Z', hasAggregate: true },
      // 日界不早于完整覆盖起点：可整日重算（即使有旧行也先重算）。
      { siteDate: '2027-02-14', dayStartUtc: '2027-02-13T16:00:00.000Z', hasAggregate: true },
    ],
  });
  assert.deepEqual(
    Object.keys(partition).sort(),
    ['affectedDays', 'coverage', 'gapDays', 'recomputedDays', 'retainedAggregateDays'],
    '分类结果不得再出现 completeAggregateDays / preservedDays 这类完整性字段',
  );
  assert.deepEqual(partition.affectedDays, ['2026-01-10', '2027-02-08', '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-14']);
  assert.deepEqual(partition.recomputedDays, ['2027-02-14']);
  assert.deepEqual(partition.retainedAggregateDays, ['2027-02-08', '2027-02-10', '2027-02-12']);
  assert.deepEqual(partition.gapDays, ['2027-02-11']);
  assert.equal(partition.coverage, 'unavailable');

  // 只有旧行、没有缺口：partial（旧结果实物在，但完整性无法确认）。
  const retainedOnly = classifyHistoricalDays({
    completeRawCoverageStartUtc: '2027-02-13T16:00:00.000Z',
    rollupExpiryThrough: '2026-02-15',
    days: [{ siteDate: '2027-02-08', dayStartUtc: '2027-02-07T16:00:00.000Z', hasAggregate: true }],
  });
  assert.deepEqual(retainedOnly.retainedAggregateDays, ['2027-02-08']);
  assert.equal(retainedOnly.coverage, 'partial');

  // 全部可整日重算：complete。
  const recomputableOnly = classifyHistoricalDays({
    completeRawCoverageStartUtc: '2027-02-13T16:00:00.000Z',
    rollupExpiryThrough: '2026-02-15',
    days: [{ siteDate: '2027-02-14', dayStartUtc: '2027-02-13T16:00:00.000Z', hasAggregate: false }],
  });
  assert.equal(recomputableOnly.coverage, 'complete');

  assert.equal(worstCoverage('complete', 'complete'), 'complete');
  assert.equal(worstCoverage('complete', 'partial'), 'partial');
  assert.equal(worstCoverage('partial', 'unavailable'), 'unavailable');
  assert.equal(worstCoverage('unavailable', 'complete'), 'unavailable');
  assert.equal(coverageOfHistory({ retainedAggregateDays: ['d'], gapDays: [] }), 'partial');
  assert.equal(coverageOfHistory({ retainedAggregateDays: [], gapDays: ['d'] }), 'unavailable');
  assert.equal(coverageOfHistory({ retainedAggregateDays: [], gapDays: [] }), 'complete');
});

test('D5：保留服务不再暴露 settle 数值入口，也没有完整性判定/回退分支', () => {
  const src = readFileSync(new URL('../src/lib/server/analytics/retention.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /settleMs/);
  assert.doesNotMatch(src, /aggregateIsComplete/);
  assert.doesNotMatch(src, /completeAggregateDays|preservedDays/);
  // 旧聚合实物保留的语义仍在：只观察行是否存在，不读 revision/watermark 判完整。
  assert.match(src, /retainedAggregateDays/);
  assert.doesNotMatch(src, /"eventCount" AS "eventCount"/);
});

test('单日聚合预算：剩余不足时不开事务，直接抛 deadline', async () => {
  let opened = false;
  const db = {
    $transaction: async () => {
      opened = true;
      throw new Error('should not open');
    },
  } as unknown as Parameters<typeof aggregateOneDayInSnapshot>[0]['db'];
  await assert.rejects(
    () => aggregateOneDayInSnapshot({
      db,
      siteDate: '2027-02-14',
      siteTimezone: TZ,
      cutoff: NOW,
      timezoneRevision: 1,
      generation: 1,
      now: NOW,
      deadlineAt: new Date(Date.now() + 100),
      occurredNotAfter: NOW,
    }),
    (error: unknown) => error instanceof AggregateDeadlineExceeded,
  );
  assert.equal(opened, false);
});

test('单日聚合预算：充足时按剩余预算切分 maxWait/timeout，并走 RepeatableRead', async () => {
  let options: { isolationLevel?: string; maxWait?: number; timeout?: number } | undefined;
  const db = {
    $transaction: async (_fn: unknown, opts: { isolationLevel?: string; maxWait?: number; timeout?: number }) => {
      options = opts;
      throw new Error('stop-before-work');
    },
  } as unknown as Parameters<typeof aggregateOneDayInSnapshot>[0]['db'];
  await assert.rejects(() => aggregateOneDayInSnapshot({
    db,
    siteDate: '2027-02-14',
    siteTimezone: TZ,
    cutoff: NOW,
    timezoneRevision: 1,
    generation: 1,
    now: NOW,
    deadlineAt: new Date(Date.now() + 10_000),
    occurredNotAfter: NOW,
  }));
  assert.ok(options);
  assert.equal(options?.isolationLevel, Prisma.TransactionIsolationLevel.RepeatableRead);
  assert.ok(Number(options?.maxWait) + Number(options?.timeout) <= 10_000, 'maxWait+timeout 不得超过剩余预算');
  assert.ok(Number(options?.timeout) < 15_000, '不得退回默认 15s，应按剩余预算派生');
});

test('D4 守卫：写前复核 revision，版本冲突归一、未知失败打阶段标记且一个字节都不写', async () => {
  type FakePgError = { meta?: { code?: string }; code?: string };
  const makeTx = (options: { revision?: number; revisionError?: FakePgError; generation?: number | null; generationError?: FakePgError; writeError?: Error }) => {
    const executed: string[] = [];
    const tx = {
      $executeRawUnsafe: async () => 0,
      $executeRaw: async (strings: TemplateStringsArray) => {
        const text = strings.join(' ');
        executed.push(text);
        if (options.writeError && text.includes('DELETE FROM')) throw options.writeError;
        return 1;
      },
      $queryRaw: async (strings: TemplateStringsArray) => {
        const text = strings.join(' ');
        if (text.includes('FROM "JobState"')) {
          if (options.generationError) throw options.generationError;
          return options.generation === null ? [] : [{ generation: options.generation ?? 1 }];
        }
        if (text.includes('FROM "SiteSetting"')) {
          if (options.revisionError) throw options.revisionError;
          return [{ value: { timezoneRevision: options.revision ?? 1 } }];
        }
        return [];
      },
    };
    return { tx, executed };
  };
  const dbFor = (tx: unknown) => ({
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Parameters<typeof aggregateOneDayInSnapshot>[0]['db']);
  const args = {
    siteDate: '2027-02-14',
    siteTimezone: TZ,
    cutoff: NOW,
    timezoneRevision: 1,
    generation: 1,
    now: NOW,
    assertTimezoneRevision: true,
  };

  // A. 代次一致：守卫放行，随后照常写入。
  {
    const { tx, executed } = makeTx({ revision: 1 });
    const day = await aggregateOneDayInSnapshot({ db: dbFor(tx), ...args });
    assert.equal(day.written, true);
    assert.ok(executed.some((text) => text.includes('LOCK TABLE "SiteSetting"')));
    assert.ok(executed.some((text) => text.includes('DELETE FROM "AnalyticsDailyRollup"')));
  }

  // B. 旧快照并发写冲突：40001（PG SQLSTATE）与 P2034（Prisma 映射）都必须归一为版本冲突，
  //    且守卫之后没有任何 DELETE/INSERT。
  for (const revisionError of [{ meta: { code: '40001' } }, { code: 'P2034' }] as FakePgError[]) {
    const { tx, executed } = makeTx({ revision: 1, revisionError });
    await assert.rejects(
      () => aggregateOneDayInSnapshot({ db: dbFor(tx), ...args }),
      (thrown: unknown) => thrown instanceof AggregateVersionConflict,
    );
    assert.equal(executed.filter((text) => text.includes('DELETE FROM')).length, 0);
  }

  // C. 守卫没能完成（23505 唯一冲突 / 未知 XX000）：不能归一成版本冲突，但必须打上守卫阶段标记，
  //    让上层终止本轮；守卫之后同样一个字节都不写。阶段判断不依赖具体 SQLSTATE。
  for (const revisionError of [{ meta: { code: '23505' } }, { meta: { code: 'XX000' }, code: 'P2010' }] as FakePgError[]) {
    const { tx, executed } = makeTx({ revision: 1, revisionError });
    await assert.rejects(
      () => aggregateOneDayInSnapshot({ db: dbFor(tx), ...args }),
      (thrown: unknown) => thrown instanceof AggregateGuardFailure
        && !(thrown instanceof AggregateVersionConflict)
        && (thrown as AggregateGuardFailure).original === revisionError,
    );
    assert.equal(executed.filter((text) => text.includes('DELETE FROM')).length, 0);
  }

  // D. 校验已经通过后的普通聚合失败：不得被打成守卫失败，仍按普通失败上抛（上层记 gap）。
  {
    const { tx } = makeTx({ revision: 1, writeError: new Error('aggregate_write_failed') });
    await assert.rejects(
      () => aggregateOneDayInSnapshot({ db: dbFor(tx), ...args }),
      (thrown: unknown) => thrown instanceof Error
        && thrown.message === 'aggregate_write_failed'
        && !(thrown instanceof AggregateGuardFailure),
    );
  }

  // E. 锁等待/语句超时是预算错误：原样上抛，不能吞成版本冲突、守卫失败或普通失败。
  const { tx: budgetTx } = makeTx({ revision: 1, revisionError: { meta: { code: '55P03' } } });
  await assert.rejects(
    () => aggregateOneDayInSnapshot({ db: dbFor(budgetTx), ...args }),
    (thrown: unknown) =>
      !(thrown instanceof AggregateVersionConflict)
      && !(thrown instanceof AggregateGuardFailure)
      && (thrown as { meta?: { code?: string } }).meta?.code === '55P03',
  );

  // F. generation 前置读取（JobState FOR UPDATE）的未知错误同样属于守卫阶段：打标记、不写。
  for (const generationError of [{ meta: { code: 'XX000' } }, { code: 'P1017' }] as FakePgError[]) {
    const { tx, executed } = makeTx({ revision: 1, generationError });
    await assert.rejects(
      () => aggregateOneDayInSnapshot({ db: dbFor(tx), ...args }),
      (thrown: unknown) => thrown instanceof AggregateGuardFailure
        && !(thrown instanceof AggregateVersionConflict)
        && (thrown as AggregateGuardFailure).original === generationError,
    );
    assert.equal(executed.filter((text) => text.includes('DELETE FROM')).length, 0);
  }

  // G. generation 前置读取的预算错误保持原分类，不得被标成守卫失败。
  const { tx: generationBudgetTx } = makeTx({ revision: 1, generationError: { meta: { code: '57014' } } });
  await assert.rejects(
    () => aggregateOneDayInSnapshot({ db: dbFor(generationBudgetTx), ...args }),
    (thrown: unknown) =>
      !(thrown instanceof AggregateGuardFailure)
      && !(thrown instanceof AggregateVersionConflict)
      && (thrown as { meta?: { code?: string } }).meta?.code === '57014',
  );

  // H. generation 真超前（库里 2 > 本轮 1）：版本冲突语义不变。
  const { tx: staleGenerationTx } = makeTx({ revision: 1, generation: 2 });
  await assert.rejects(
    () => aggregateOneDayInSnapshot({ db: dbFor(staleGenerationTx), ...args }),
    (thrown: unknown) => thrown instanceof AggregateVersionConflict && !(thrown instanceof AggregateGuardFailure),
  );
});

test('R5 服务级假 DB：preflight 的 generation/settings 前置失败按守卫失败终止，不记 gap、不删', async () => {
  type FakePgError = { meta?: { code?: string }; code?: string };
  // 假 DB 只覆盖本用例需要的查询面；它证明的是服务层分类与顺序，不证明真实 PG 回滚。
  const makeRetentionDb = (options: {
    generationFirst?: { generation: number };
    generationErrorOnce?: FakePgError;
    settingsErrorOnce?: FakePgError;
    preflightDeleteErrorOnce?: boolean;
  } = {}) => {
    const settings = {
      version: 1,
      timezone: TZ,
      timezoneRevision: 1,
      changedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: null,
    };
    const leaseRow = {
      generation: 1,
      lastStatus: 'RUNNING',
      lastStartedAt: NOW.toISOString(),
      lastFinishedAt: null,
      lastSucceededAt: null,
      lockedUntil: '2027-03-15T04:05:00.000Z',
      lastErrorCode: null,
      summary: null,
    };
    const failedRow = {
      generation: 1,
      lastStatus: 'FAILED',
      lastStartedAt: NOW.toISOString(),
      lastFinishedAt: NOW.toISOString(),
      lastSucceededAt: null,
      lockedUntil: null,
      lastErrorCode: 'internal_error',
      summary: null,
    };
    const stats = { deletedEvents: 0, deletedDaily: 0, deletedDays: 0, generationChecks: 0 };
    let generationInjected = false;
    let settingsInjected = false;
    let preflightDeleteInjected = false;
    let jobStateInserts = 0;
    const textOf = (query: unknown): string => {
      if (Array.isArray(query)) return query.map(String).join(' ');
      if (query && typeof query === 'object') {
        const inline = (query as { text?: unknown }).text ?? (query as { sql?: unknown }).sql;
        if (typeof inline === 'string') return inline;
        const parts = (query as { strings?: unknown }).strings;
        if (Array.isArray(parts)) return parts.map(String).join(' ');
      }
      return '';
    };
    const tx = {
      $executeRawUnsafe: async () => 0,
      $executeRaw: async (query: unknown) => {
        const text = textOf(query);
        if (text.includes('LOCK TABLE')) return 0;
        if (text.includes('DELETE FROM "AnalyticsEvent"')) {
          stats.deletedEvents += 1;
          return 1;
        }
        if (text.includes('DELETE FROM "AnalyticsDailyRollup"')) {
          if (text.includes('AS target')) return 0;
          if (!preflightDeleteInjected && options.preflightDeleteErrorOnce) {
            preflightDeleteInjected = true;
            throw new Error('aggregate_write_failed');
          }
          stats.deletedDaily += 1;
          return 1;
        }
        if (text.includes('DELETE FROM "AnalyticsRollupDay"')) return 0;
        if (text.includes('INSERT INTO "AnalyticsRollupDay"')) return 1;
        return 0;
      },
      $queryRaw: async (query: unknown) => {
        const text = textOf(query);
        if (text.includes('FROM "SiteSetting"')) {
          if (text.includes('FOR UPDATE') && !settingsInjected && options.settingsErrorOnce) {
            settingsInjected = true;
            throw options.settingsErrorOnce;
          }
          return [{ value: settings }];
        }
        if (text.includes('INSERT INTO "JobState"')) {
          jobStateInserts += 1;
          return [jobStateInserts === 1 ? leaseRow : failedRow];
        }
        if (text.includes('UPDATE "JobState"')) {
          // 租约续租的 UPDATE 返回完整行；释放租约的 UPDATE 只要 generation。
          return text.includes('SET "leaseOwner"') ? [{ generation: 1 }] : [leaseRow];
        }
        if (text.includes('FROM "JobState"')) {
          if (text.includes('SELECT "generation"')) {
            stats.generationChecks += 1;
            if (!generationInjected && stats.generationChecks === 1 && options.generationErrorOnce) {
              generationInjected = true;
              throw options.generationErrorOnce;
            }
            if (!generationInjected && stats.generationChecks === 1 && options.generationFirst) {
              generationInjected = true;
              return [{ generation: options.generationFirst.generation }];
            }
            return [{ generation: 1 }];
          }
          return [];
        }
        if (text.includes('FROM "AnalyticsEvent"')) {
          if (text.includes('COUNT(*)')) return [{ count: 1 }];
          if (text.includes('ORDER BY "receivedAt"')) return [{ eventId: 'e1', siteDate: '2027-03-14' }];
          return [];
        }
        if (text.includes('FROM "AnalyticsDailyRollup"')) {
          if (text.includes('COUNT(*)')) return [{ count: 0 }];
          return [];
        }
        if (text.includes('FROM "AnalyticsRollupDay"')) {
          if (text.includes('COUNT(*)')) return [{ count: 0 }];
          return [];
        }
        return [];
      },
    };
    const db = {
      $queryRaw: tx.$queryRaw,
      $executeRaw: tx.$executeRaw,
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof runAnalyticsRetention>[0]['db'];
    return { db, stats };
  };
  const runWith = (db: Parameters<typeof runAnalyticsRetention>[0]['db']) =>
    runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true });

  // A. generation 读取未知错误：FAILED/internal_error，gap 为空，raw 未删。
  {
    const { db, stats } = makeRetentionDb({ generationErrorOnce: { meta: { code: 'XX000' } } });
    const run = await runWith(db);
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.equal(run.status, 'FAILED');
    assert.equal(run.errorCode, 'internal_error');
    assert.deepEqual(run.report.history.gapDays, []);
    assert.equal(run.report.deletedEvents, 0);
    assert.equal(stats.deletedEvents, 0);
  }

  // B. generation 预算错误：按预算超时返回，不标守卫失败、不删。
  {
    const { db, stats } = makeRetentionDb({ generationErrorOnce: { meta: { code: '57014' } } });
    const run = await runWith(db);
    assert.equal(run.kind, 'timeout');
    assert.equal(stats.deletedEvents, 0);
  }

  // C. generation 真超前：版本冲突，不删。
  {
    const { db, stats } = makeRetentionDb({ generationFirst: { generation: 2 } });
    const run = await runWith(db);
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.equal(run.status, 'FAILED');
    assert.equal(run.errorCode, 'version_conflict');
    assert.deepEqual(run.report.history.gapDays, []);
    assert.equal(stats.deletedEvents, 0);
  }

  // D. settings 守卫未知错误（R3 A4/A5 同形）：同样终止，不落 gap、不删。
  {
    const { db, stats } = makeRetentionDb({ settingsErrorOnce: { meta: { code: '23505' } } });
    const run = await runWith(db);
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.equal(run.status, 'FAILED');
    assert.equal(run.errorCode, 'internal_error');
    assert.deepEqual(run.report.history.gapDays, []);
    assert.equal(stats.deletedEvents, 0);
  }

  // E. 前置校验通过后的普通聚合失败：仍按契约记 gap 并继续删除（阶段区分不被扩大）。
  {
    const { db, stats } = makeRetentionDb({ preflightDeleteErrorOnce: true });
    const run = await runWith(db);
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.deepEqual(run.report.history.gapDays, ['2027-03-14']);
    assert.deepEqual(run.report.history.recomputedDays, []);
    assert.equal(run.report.deletedEvents, 1);
    assert.equal(stats.deletedEvents, 1);
  }
});

test('R4 失败阶段：守卫失败必须终止，普通聚合失败仍 gap，预算错误保留', () => {
  assert.equal(abortsRetentionRun(new AggregateVersionConflict('stale_timezone_revision')), true);
  assert.equal(abortsRetentionRun(new AggregateGuardFailure(new Error('guard broke'))), true);
  assert.equal(abortsRetentionRun(new Error('aggregate_write_failed')), false);
  // 预算错误在 preflight 更早的分支按 timeout 处理，不属于“守卫失败终止”。
  assert.equal(abortsRetentionRun({ meta: { code: '55P03' } }), false);
});

test('R5 事务都没开成：按守卫阶段失败上抛，不落普通聚合失败', async () => {
  const db = {
    $transaction: async () => { throw new Error('connect_failed'); },
  } as unknown as Parameters<typeof aggregateOneDayInSnapshot>[0]['db'];
  await assert.rejects(
    () => aggregateOneDayInSnapshot({
      db,
      siteDate: '2027-02-14',
      siteTimezone: TZ,
      cutoff: NOW,
      timezoneRevision: 1,
      generation: 1,
      now: NOW,
      assertTimezoneRevision: true,
    }),
    (thrown: unknown) => thrown instanceof AggregateGuardFailure
      && (thrown as AggregateGuardFailure).original instanceof Error,
  );
});

test('单日聚合：写入后到期即抛错回滚，occurredNotAfter 与旧代次按既有语义处理', async () => {
  const txFor = (overrides: { generation?: number; onUpsert?: () => void } = {}) => {
    const seen: string[] = [];
    let executes = 0;
    const tx = {
      $executeRawUnsafe: async () => 0,
      $queryRaw: async (...args: unknown[]) => {
        // tagged template 的字符串数组只有外层，嵌套的 Prisma.Sql 片段作为参数值出现；
        // 两者都收集，才能断言 occurredNotAfter 进入了事件查询。
        const parts: string[] = [];
        for (const arg of args) {
          if (Array.isArray(arg)) parts.push(...arg.map(String));
          else if (arg && typeof arg === 'object' && 'text' in arg) parts.push(String((arg as { text?: string }).text ?? ''));
        }
        const text = parts.join(' ');
        seen.push(text);
        if (text.includes('FROM "JobState"')) {
          return overrides.generation === undefined ? [] : [{ generation: overrides.generation }];
        }
        return [];
      },
      $executeRaw: async () => {
        executes += 1;
        // 第 1 次是删除当日聚合，第 2 次是 watermark upsert；在最后一次写入后让时钟过期。
        if (executes === 2) overrides.onUpsert?.();
        return 1;
      },
    };
    return { tx, seen };
  };

  // A. 写入完成后到期：抛 AggregateDeadlineExceeded，事务不提交（回调抛错即回滚）。
  const realNow = Date.now;
  const base = realNow();
  let fakeNow = base;
  Date.now = () => fakeNow;
  try {
    const { tx, seen } = txFor({ onUpsert: () => { fakeNow = base + 10_000; } });
    const db = {
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof aggregateOneDayInSnapshot>[0]['db'];
    await assert.rejects(
      () => aggregateOneDayInSnapshot({
        db,
        siteDate: '2027-02-14',
        siteTimezone: TZ,
        cutoff: NOW,
        timezoneRevision: 1,
        generation: 1,
        now: NOW,
        deadlineAt: new Date(base + 5_000),
        occurredNotAfter: NOW,
      }),
      (error: unknown) => error instanceof AggregateDeadlineExceeded,
    );
    assert.ok(seen.some((text) => text.includes('"occurredAt" <=')), 'occurredNotAfter 必须进入事件查询');
  } finally {
    Date.now = realNow;
  }

  // B. 库里代次高于本次领取：抛版本冲突，不进入任何写入。
  const { tx: staleTx } = txFor({ generation: 9 });
  let wrote = false;
  staleTx.$executeRaw = async () => {
    wrote = true;
    return 1;
  };
  const staleDb = {
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(staleTx),
  } as unknown as Parameters<typeof aggregateOneDayInSnapshot>[0]['db'];
  await assert.rejects(
    () => aggregateOneDayInSnapshot({
      db: staleDb,
      siteDate: '2027-02-14',
      siteTimezone: TZ,
      cutoff: NOW,
      timezoneRevision: 1,
      generation: 1,
      now: NOW,
      deadlineAt: new Date(Date.now() + 10_000),
      occurredNotAfter: NOW,
    }),
    (error: unknown) => error instanceof AggregateVersionConflict,
  );
  assert.equal(wrote, false);
});

test('registry 注册 analytics-retention，且 operations 把 dryRun 原样交给作业', async () => {
  const seen: (boolean | undefined)[] = [];
  const registry = createJobRegistry([
    {
      key: ANALYTICS_RETENTION_KEY,
      async run(context) {
        seen.push(context.dryRun);
        return { kind: 'ran', status: 'SUCCEEDED', counts: { candidateCount: 1, deletedCount: 0 } };
      },
    },
  ]);
  assert.equal(registry.has(ANALYTICS_RETENTION_KEY), true);

  const handler = createOperationsHandler({ services: registry, secret: SECRET, clock: () => new Date('2027-03-15T04:00:00.000Z') });
  const post = (body: unknown) =>
    handler(new Request('http://127.0.0.1/api/admin/cron/operations', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));

  const explicit = await post({ jobKey: ANALYTICS_RETENTION_KEY, dryRun: false });
  assert.equal(explicit.status, 200);
  assert.deepEqual(seen, [false]);
  const omitted = await post({ jobKey: ANALYTICS_RETENTION_KEY });
  assert.equal(omitted.status, 200);
  assert.deepEqual(seen, [false, true]);
});

test('作业工厂只提供固定 key，不因构造而访问数据库', () => {
  const neverCalled = new Proxy({}, { get: () => { throw new Error('db touched during construction'); } }) as unknown as PrismaClient;
  const job = createAnalyticsRetentionJob({ db: neverCalled, deleteAuthorized: false });
  assert.equal(job.key, ANALYTICS_RETENTION_KEY);
});

test('cron 模板：04:30 单独调度 analytics-retention，命令行无密钥、无启用开关', () => {
  const cron = readFileSync(new URL('../deploy/cron.nbshiyan', import.meta.url), 'utf8');
  const lines = cron.split(/\r?\n/);
  const jobLine = lines.find((row) => row.includes('/api/admin/cron/operations') && row.includes('analytics-retention'));
  assert.ok(jobLine, 'cron 必须有一行 analytics-retention');
  assert.match(jobLine, /^30 4 \* \* \* /);
  assert.match(jobLine, /http:\/\/127\.0\.0\.1:3000\/api\/admin\/cron\/operations/);
  assert.match(jobLine, /\{jobKey:'analytics-retention'\}/);
  assert.match(jobLine, /process\.env\.CRON_SECRET/);
  assert.equal(jobLine.replaceAll('process.env.CRON_SECRET', '').includes('CRON_SECRET'), false);
  assert.match(jobLine, /r\.status===409/);
  // 默认 dry-run：命令行里不得出现 dryRun:false，也不得把真实清理开关写上命令行。
  assert.doesNotMatch(jobLine, /dryRun:false/);
  assert.doesNotMatch(jobLine, /RETENTION_CLEANUP_MODE=delete/);
  // 旧 03:30 行由既有回归用例守着，本任务不动它；两个保留入口错开分钟只是不彼此撞，
  // 与每 5 分钟聚合作业的互斥由 analytics-aggregate 租约和 409 busy 语义保证，不靠时刻。
  const legacyLine = lines.find((row) => row.includes('/api/admin/cron/retention-cleanup'));
  assert.ok(legacyLine, '旧 retention-cleanup 行保留，退役由单独任务处理');
  assert.match(legacyLine, /^30 3 \* \* \* /);
});

test('delete 只落分析六张表（旧三表 + 新三表），不碰询盘/聊天/审计/备份', () => {
  const src = readFileSync(new URL('../src/lib/server/analytics/retention.ts', import.meta.url), 'utf8');
  const targets = [...src.matchAll(/DELETE FROM "([A-Za-z]+)"/g)].map((match) => match[1]).sort();
  // M5-T12：04:30 的 analytics-retention 是 AnalyticsDaily 的唯一清理者，state/marker 依次在其后。
  assert.deepEqual(targets, [
    'AnalyticsAggregateDayState',
    'AnalyticsDaily',
    'AnalyticsDailyRollup',
    'AnalyticsDayChange',
    'AnalyticsEvent',
    'AnalyticsRollupDay',
  ]);
  // 分析域之外一张都不许出现：审计、询盘、聊天、通知、邮件、账号、设置、作业状态。
  const forbidden = [
    'AuditLog', 'Inquiry', 'InquiryItem', 'InquiryMessage', 'InquiryNote',
    'ChatConversation', 'ChatMessage', 'ChatReadCursor', 'ChatNotification', 'ChatVisitorSession',
    'MailMessage', 'Contact', 'User', 'SiteSetting', 'JobState', 'Model3D', 'PublicAsset', 'LogoUpload',
  ];
  for (const table of forbidden) {
    assert.equal(targets.includes(table), false, `保留清理不得删除业务表 ${table}`);
  }
});

test('compose 点同时注册聚合作业与保留作业', async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:1/test';
  const { createJobServices } = await import('../src/lib/server/composition');
  const fakeDb = {
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    $transaction: async () => { throw new Error('no database'); },
  } as unknown as PrismaClient;
  const services = createJobServices({ db: fakeDb, deleteAuthorized: false });
  assert.equal(services.jobs.has(ANALYTICS_RETENTION_KEY), true);
  assert.equal(services.jobs.has(ANALYTICS_ROLLUP_JOB_KEY), true);
});

/* --------------------------------------------------------------- 真实库用例 */

const rawUrl = process.env.M5T11_TEST_DATABASE_URL;
const PG_URL = rawUrl?.startsWith('postgres') ? rawUrl : null;
const REQUIRE_PG = process.env.M5T11_REQUIRE_DATABASE === 'true';
if (REQUIRE_PG && !PG_URL) {
  throw new Error('M5T11_REQUIRE_DATABASE=true 时 M5T11_TEST_DATABASE_URL 必须设置（PG 用例不允许静默 skip）');
}
if (PG_URL) {
  const host = new URL(PG_URL).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`M5T11_TEST_DATABASE_URL 必须指向 loopback 测试库，实际 host=${host}`);
  }
}
const skip = !PG_URL && 'no M5T11_TEST_DATABASE_URL';

const SCHEMA = `m5t11_${randomBytes(6).toString('hex')}`;
/** 只有本进程真的 CREATE 成功才置 true；预存同名对象一律不认领、不 seed、不清理。 */
let ownedSchema = false;
const url = PG_URL
  ? `${PG_URL}${PG_URL.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}`
  : null;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

/**
 * 先查存在性，再用不带 IF NOT EXISTS 的 CREATE 抢占名字。
 * 返回 true 只代表「这一行 CREATE 是本进程做的」；冲突或预存对象返回 false，调用方不得清理。
 */
async function createOwnedSchema(client: PrismaClient, name: string): Promise<boolean> {
  const existing = await client.$queryRaw<{ one: number }[]>`
    SELECT 1 AS "one" FROM pg_namespace WHERE nspname = ${name}
  `;
  if (existing.length > 0) return false;
  await client.$executeRawUnsafe(`CREATE SCHEMA "${name}"`);
  return true;
}

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

function shiftDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function context(now: Date, dryRun?: boolean) {
  return {
    now,
    deadlineAt: new Date(Date.now() + 55_000),
    signal: new AbortController().signal,
    ...(dryRun === undefined ? {} : { dryRun }),
  };
}

const NOW = new Date('2027-03-15T04:00:00.000Z');
const EVENT_CUTOFF = eventExpiryCutoff(NOW);
const ROLLUP_CUTOFF = rollupExpiryCutoff(NOW, TZ);

/** 过期与未过期各一半：事件按 receivedAt 等号到期，汇总按站点日等号到期。 */
async function seed(client: PrismaClient) {
  await client.$executeRaw`DELETE FROM "AnalyticsEvent"`;
  await client.$executeRaw`DELETE FROM "AnalyticsDailyRollup"`;
  await client.$executeRaw`DELETE FROM "AnalyticsRollupDay"`;
  await client.$executeRaw`DELETE FROM "JobState"`;
  await client.$executeRaw`
    INSERT INTO "SiteSetting" ("key", "value")
    VALUES ('analytics.settings', ${JSON.stringify({
      version: 1,
      timezone: TZ,
      timezoneRevision: 1,
      changedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: null,
    })}::jsonb)
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"
  `;

  const freshReceivedAt = new Date(EVENT_CUTOFF.getTime() + 1);
  const todayOccurredAt = new Date('2027-03-15T02:00:00.000Z');
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsEvent" (
      "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
      "productSlug", "path", "occurredAt", "receivedAt"
    ) VALUES
      (${'ev-expired'}, ${'sk-expired'}, ${'p'.repeat(64)}, ${'bh-expired'}, ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(EVENT_CUTOFF)}, ${utc(EVENT_CUTOFF)}),
      (${'ev-fresh'}, ${'sk-fresh'}, ${'p'.repeat(64)}, ${'bh-fresh'}, ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(freshReceivedAt)}, ${utc(freshReceivedAt)}),
      (${'ev-today'}, ${'sk-today'}, ${'p'.repeat(64)}, ${'bh-today'}, ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(todayOccurredAt)}, ${utc(todayOccurredAt)})
  `);

  await client.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsRollupDay" (
      "siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt"
    ) VALUES
      (${shiftDate(ROLLUP_CUTOFF, -1)}, 1, ${utc(NOW)}, 4, ${utc(EVENT_CUTOFF)}, ${utc(NOW)}, ${utc(NOW)}),
      (${ROLLUP_CUTOFF}, 1, ${utc(NOW)}, 5, ${utc(EVENT_CUTOFF)}, ${utc(NOW)}, ${utc(NOW)}),
      (${shiftDate(ROLLUP_CUTOFF, 1)}, 1, ${utc(NOW)}, 6, ${utc(EVENT_CUTOFF)}, ${utc(NOW)}, ${utc(NOW)})
  `);
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsDailyRollup" ("siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers", "createdAt", "updatedAt")
    VALUES
      (${shiftDate(ROLLUP_CUTOFF, -1)}, 'page_view'::"AnalyticsEventKind", 'en', '', 4, 2, ${utc(NOW)}, ${utc(NOW)}),
      (${ROLLUP_CUTOFF}, 'page_view'::"AnalyticsEventKind", 'en', '', 5, 3, ${utc(NOW)}, ${utc(NOW)}),
      (${shiftDate(ROLLUP_CUTOFF, 1)}, 'page_view'::"AnalyticsEventKind", 'en', '', 6, 4, ${utc(NOW)}, ${utc(NOW)})
  `);
}

async function count(client: PrismaClient, sql: Prisma.Sql): Promise<number> {
  const rows = await client.$queryRaw<{ count: number }[]>(sql);
  return Number(rows[0]?.count ?? 0);
}

/** 读 analytics-retention 这一行：状态、错误码与摘要里的实际删除数。 */
async function retentionState(client: PrismaClient) {
  const rows = await client.$queryRaw<{ lastStatus: string; lastErrorCode: string | null; summary: unknown }[]>`
    SELECT "lastStatus"::text AS "lastStatus", "lastErrorCode", "summary"
    FROM "JobState" WHERE "key" = ${ANALYTICS_RETENTION_KEY}
  `;
  assert.equal(rows.length, 1);
  const summary = rows[0].summary as { counts?: { deletedCount?: number; candidateCount?: number } };
  return {
    status: rows[0].lastStatus,
    errorCode: rows[0].lastErrorCode,
    deletedCount: summary.counts?.deletedCount,
    candidateCount: summary.counts?.candidateCount,
  };
}

/**
 * 装一个只拦截指定键值的 BEFORE INSERT 触发器：聚合写当日行时整句抛错，
 * 用来制造「recomputable 日单日聚合失败」。返回的清理函数只删本用例创建的 function/trigger。
 */
async function installInsertBlocker(
  client: PrismaClient,
  spec: { table: string; column: string; value: string },
): Promise<() => Promise<void>> {
  const suffix = randomBytes(3).toString('hex');
  const fn = `m5t11_ins_${suffix}`;
  const trg = `m5t11_ins_trg_${suffix}`;
  const literal = `'${spec.value.replaceAll("'", "''")}'`;
  await client.$executeRawUnsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger AS $m5t11$
BEGIN
  IF NEW."${spec.column}" = ${literal} THEN
    RAISE EXCEPTION 'm5t11_blocked_insert';
  END IF;
  RETURN NEW;
END
$m5t11$ LANGUAGE plpgsql`);
  await client.$executeRawUnsafe(
    `CREATE TRIGGER "${trg}" BEFORE INSERT ON "${spec.table}" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`,
  );
  return async () => {
    await client.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trg}" ON "${spec.table}"`);
    await client.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`);
  };
}
/** 在指定站点日插入一条到期原始事件，可选插入旧聚合标记（watermark/revision/完成时刻由用例控制）。 */
async function seedOldDay(
  client: PrismaClient,
  opts: {
    day: string;
    eventId: string;
    receivedAt: Date;
    occurredAt?: Date;
    marker?: {
      timezoneRevision: number;
      sourceMaxReceivedAt: Date | null;
      eventCount?: number;
      completedAt?: Date;
    } | null;
  },
): Promise<void> {
  const occurredAt = opts.occurredAt ?? opts.receivedAt;
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsEvent" (
      "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
      "productSlug", "path", "occurredAt", "receivedAt"
    ) VALUES (
      ${opts.eventId}, ${`sk-${opts.eventId}`}, ${'p'.repeat(64)}, ${`bh-${opts.eventId}`},
      ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(occurredAt)}, ${utc(opts.receivedAt)}
    )
  `);
  if (opts.marker === null) return;
  const marker = opts.marker ?? { timezoneRevision: 1, sourceMaxReceivedAt: opts.receivedAt };
  const sourceMax = marker.sourceMaxReceivedAt === null ? Prisma.sql`NULL` : utc(marker.sourceMaxReceivedAt);
  const completedAt = marker.completedAt ?? NOW;
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsRollupDay" (
      "siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt"
    ) VALUES (
      ${opts.day}, ${marker.timezoneRevision}, ${utc(completedAt)}, ${marker.eventCount ?? 1},
      ${sourceMax}, ${utc(NOW)}, ${utc(NOW)}
    )
  `);
}

/**
 * 装一个只拦截指定键值的 BEFORE DELETE 触发器：DELETE 语句命中该行时整句抛错，
 * 用来制造「第一批已提交、第二批失败」。返回的清理函数只删本用例创建的 function/trigger。
 */
async function installDeleteBlocker(
  client: PrismaClient,
  spec: { table: string; column: string; value: string },
): Promise<() => Promise<void>> {
  const suffix = randomBytes(3).toString('hex');
  const fn = `m5t11_block_${suffix}`;
  const trg = `m5t11_trg_${suffix}`;
  const literal = `'${spec.value.replaceAll("'", "''")}'`;
  await client.$executeRawUnsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger AS $m5t11$
BEGIN
  IF OLD."${spec.column}" = ${literal} THEN
    RAISE EXCEPTION 'm5t11_blocked_batch';
  END IF;
  RETURN OLD;
END
$m5t11$ LANGUAGE plpgsql`);
  await client.$executeRawUnsafe(
    `CREATE TRIGGER "${trg}" BEFORE DELETE ON "${spec.table}" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`,
  );
  return async () => {
    await client.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trg}" ON "${spec.table}"`);
    await client.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`);
  };
}

/** 读当前站点时区代次（只用于断言）。 */
async function revisionOf(client: PrismaClient): Promise<number> {
  const rows = await client.$queryRaw<{ value: unknown }[]>`
    SELECT "value" FROM "SiteSetting" WHERE "key" = 'analytics.settings'
  `;
  assert.equal(rows.length, 1, 'SiteSetting analytics.settings 必须存在');
  const raw = rows[0].value;
  const json = typeof raw === 'string' ? JSON.parse(raw) as { timezoneRevision?: number } : raw as { timezoneRevision?: number };
  return Number(json.timezoneRevision);
}

/** 用另一条连接把 revision 改成指定值（模拟设置服务并发提交）。 */
async function setRevision(client: PrismaClient, to: number): Promise<void> {
  await client.$executeRaw(Prisma.sql`
    UPDATE "SiteSetting"
    SET "value" = jsonb_set("value", '{timezoneRevision}', ${String(to)}::jsonb)
    WHERE "key" = 'analytics.settings'
  `);
}

/**
 * BEFORE DELETE 触发器：命中指定行时在**同一事务内**把 SiteSetting revision 改成 `to`。
 * 用来制造「本批先合法提交、后续批次/删后聚合在写前才发现 revision 已变」。
 */
async function installRevisionBumpTrigger(
  client: PrismaClient,
  spec: { table: string; column: string; value: string; to: number },
): Promise<() => Promise<void>> {
  const suffix = randomBytes(3).toString('hex');
  const fn = `m5t11_bump_${suffix}`;
  const trg = `m5t11_bump_trg_${suffix}`;
  const literal = `'${spec.value.replaceAll("'", "''")}'`;
  const bumpLiteral = `'${spec.to}'::jsonb`;
  await client.$executeRawUnsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger AS $m5t11$
BEGIN
  IF OLD."${spec.column}" = ${literal} THEN
    UPDATE "SiteSetting"
    SET "value" = jsonb_set("value", '{timezoneRevision}', ${bumpLiteral})
    WHERE "key" = 'analytics.settings';
  END IF;
  RETURN OLD;
END
$m5t11$ LANGUAGE plpgsql`);
  await client.$executeRawUnsafe(
    `CREATE TRIGGER "${trg}" BEFORE DELETE ON "${spec.table}" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`,
  );
  return async () => {
    await client.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trg}" ON "${spec.table}"`);
    await client.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`);
  };
}

/**
 * 测试用事务包装：产品的每条事务照常打开，但在「候选事件查询」执行前，用另一条连接提交一次
 * revision 变化，模拟「预检开始前设置已被改」。产品源码零改动。
 */
function dbThatBumpsBeforePreflight(client: PrismaClient, bump: () => Promise<void>): PrismaClient {
  let fired = false;
  // Prisma 的 $queryRaw 既接受 tagged template，也接受单个 Prisma.Sql 对象；两种都取正文。
  const sqlText = (query: unknown): string => {
    if (Array.isArray(query)) return query.map(String).join(' ');
    if (query && typeof query === 'object') {
      const inline = (query as { text?: unknown }).text ?? (query as { sql?: unknown }).sql;
      if (typeof inline === 'string') return inline;
      const parts = (query as { strings?: unknown }).strings;
      if (Array.isArray(parts)) return parts.map(String).join(' ');
    }
    return '';
  };
  const wrapped = {
    $queryRaw: client.$queryRaw.bind(client),
    $executeRaw: client.$executeRaw.bind(client),
    $transaction: (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => client.$transaction(async (tx) => {
      const proxy = new Proxy(tx, {
        get(target, prop) {
          if (prop === '$queryRaw') {
            return async (query: unknown, ...values: unknown[]) => {
              const text = sqlText(query);
              if (!fired && text.includes('FROM "AnalyticsEvent"') && text.includes('ORDER BY "receivedAt"')) {
                fired = true;
                await bump();
              }
              return (target.$queryRaw as unknown as (input: unknown, ...args: unknown[]) => Promise<unknown>)(query, ...values);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return fn(proxy as Prisma.TransactionClient);
    }, options),
  };
  return wrapped as unknown as PrismaClient;
}

describe('analytics retention job', { concurrency: false, skip, timeout: 180_000 }, () => {
  before(async () => {
    assert.ok(db);
    assert.ok(url);
    assert.match(SCHEMA, /^m5t11_[0-9a-f]{12}$/);
    ownedSchema = await createOwnedSchema(db, SCHEMA);
    if (!ownedSchema) throw new Error(`schema ${SCHEMA} already exists; refusing to claim it`);
    const { execFileSync } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  beforeEach(async () => {
    assert.ok(db);
    await seed(db);
  });

  after(async () => {
    if (!db) return;
    try {
      // 只有本进程 CREATE 成功才允许 DROP；预存或创建失败时什么都不做。
      if (!ownedSchema) return;
      assert.match(SCHEMA, /^m5t11_[0-9a-f]{12}$/);
      await db.$executeRawUnsafe(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    } catch (error) {
      console.error('[m5t11] schema cleanup failed', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      await db.$disconnect();
    }
  });

  test('默认 dry-run：只数候选、删 0 行，JobState 记 SUCCEEDED 与候选/实际计数', async () => {
    assert.ok(db);
    const run = await runAnalyticsRetention({ db, context: context(NOW), clock: () => NOW, deleteAuthorized: false });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(run.errorCode, null);
    assert.equal(run.report.mode, 'dry-run');
    assert.deepEqual(run.report.candidates, { events: 1, rollupDailyRows: 2, rollupDays: 2, total: 5 });
    assert.equal(run.report.deletedEvents, 0);
    assert.equal(run.report.deletedRollupDailyRows, 0);
    assert.equal(run.report.deletedRollupDays, 0);
    assert.equal(run.report.coverage, 'complete');
    assert.equal(run.counts.candidateCount, 5);
    assert.equal(run.counts.deletedCount, 0);

    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay"`), 3);

    const jobRows = await db.$queryRaw<{ lastStatus: string; summary: unknown; lastErrorCode: string | null }[]>`
      SELECT "lastStatus"::text AS "lastStatus", "summary", "lastErrorCode"
      FROM "JobState" WHERE "key" = ${ANALYTICS_RETENTION_KEY}
    `;
    assert.equal(jobRows.length, 1);
    assert.equal(jobRows[0].lastStatus, 'SUCCEEDED');
    assert.equal(jobRows[0].lastErrorCode, null);
    const summary = jobRows[0].summary as { counts?: { candidateCount?: number; deletedCount?: number }; versions?: { timezoneRevision?: number } };
    assert.equal(summary.counts?.candidateCount, 5);
    assert.equal(summary.counts?.deletedCount, 0);
    assert.equal(summary.versions?.timezoneRevision, 1);
  });

  test('未授权删除请求：记 FAILED/forbidden，删 0 行，只返回候选计数', async () => {
    assert.ok(db);
    const run = await runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: false });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.equal(run.status, 'FAILED');
    assert.equal(run.errorCode, 'forbidden');
    assert.equal(run.report.mode, 'dry-run');
    assert.equal(run.report.requestedDelete, true);
    assert.equal(run.report.authorized, false);
    assert.equal(run.counts.deletedCount, 0);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);

    const jobRows = await db.$queryRaw<{ lastStatus: string; lastErrorCode: string | null }[]>`
      SELECT "lastStatus"::text AS "lastStatus", "lastErrorCode"
      FROM "JobState" WHERE "key" = ${ANALYTICS_RETENTION_KEY}
    `;
    assert.equal(jobRows[0]?.lastStatus, 'FAILED');
    assert.equal(jobRows[0]?.lastErrorCode, 'forbidden');
  });

  test('已授权删除：只删到期行（等号到期），历史缺口显式上报、近期 complete 不得掩盖', async () => {
    assert.ok(db);
    const run = await runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    // 2027-02-13 是 cutoff 所在日：无旧聚合、也不在可整日重算范围，必须记 gap。
    assert.equal(run.status, 'PARTIAL');
    assert.equal(run.errorCode, 'source_unavailable');
    assert.equal(run.report.mode, 'delete');
    assert.equal(run.report.deletedEvents, 1);
    assert.equal(run.report.deletedRollupDailyRows, 2);
    assert.equal(run.report.deletedRollupDays, 2);
    assert.equal(run.report.batches, 3);
    assert.equal(run.counts.candidateCount, 5);
    assert.equal(run.counts.deletedCount, 5);
    assert.equal(run.report.coverage, 'unavailable');
    assert.deepEqual(run.report.history.affectedDays, ['2027-02-13']);
    assert.deepEqual(run.report.history.gapDays, ['2027-02-13']);
    assert.deepEqual(run.report.history.retainedAggregateDays, []);
    assert.deepEqual(run.report.history.recomputedDays, []);
    // 近期三天仍然完整重算，但不能把历史 gap 抹成 complete。
    assert.equal(run.report.recomputedDays, 3);
    assert.deepEqual(run.report.skippedDays, []);

    // 过期行消失，未过期行原样保留；去标识意义上的浏览器哈希只剩未过期的两个。
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-expired'`), 0);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 2);
    assert.deepEqual(
      (await db.$queryRaw<{ browserHash: string }[]>`SELECT "browserHash" FROM "AnalyticsEvent" ORDER BY "browserHash"`).map((row) => row.browserHash),
      ['bh-fresh', 'bh-today'],
    );

    // 13 个自然月边界：等号那天也删，次日保留。
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" <= ${ROLLUP_CUTOFF}`),
      0,
    );
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${shiftDate(ROLLUP_CUTOFF, 1)}`),
      1,
    );
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsDailyRollup" WHERE "siteDate" <= ${ROLLUP_CUTOFF}`),
      0,
    );

    // 清理后调用既有聚合服务：今天的水位与日聚合被重写，且不会把过期的日期补回来。
    const today = siteLocalDate(NOW, TZ);
    const watermark = await db.$queryRaw<{ timezoneRevision: number; eventCount: number }[]>`
      SELECT "timezoneRevision", "eventCount" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${today}
    `;
    assert.equal(watermark.length, 1);
    assert.equal(Number(watermark[0].timezoneRevision), 1);
    assert.equal(Number(watermark[0].eventCount), 1);
    assert.equal(run.report.recomputedDays, 3);
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" <= ${ROLLUP_CUTOFF}`),
      0,
    );
    // 已过期事件不会被重算补回（原始行已删，聚合只覆盖今天与 48h 窗口）。
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-expired'`), 0);

    // 终态如实记 PARTIAL + 数据源不可用，而不是 SUCCEEDED。
    const state = await retentionState(db);
    assert.equal(state.status, 'PARTIAL');
    assert.equal(state.errorCode, 'source_unavailable');
    assert.equal(state.deletedCount, 5);
  });

  test('D1 无 settle 上界：旧行看似完整也只记 gap，实物保留不冒充当前口径', async () => {
    assert.ok(db);
    // 默认夹具里 cutoff 所在日（无标记）会在本用例里制造 gap，先移除；
    // 只留一个「有完整旧聚合」的历史到期日，验证保留而非重写。
    await db.$executeRaw`DELETE FROM "AnalyticsEvent" WHERE "eventId" = 'ev-expired'`;
    const oldDay = '2026-12-01';
    const oldReceivedAt = new Date('2026-12-01T00:00:00.000Z');
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${'ev-old-day'}, ${'sk-old-day'}, ${'p'.repeat(64)}, ${'bh-old-day'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(oldReceivedAt)}, ${utc(oldReceivedAt)}
      )
    `);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsRollupDay" (
        "siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt"
      ) VALUES (${oldDay}, 1, ${utc(NOW)}, 7, ${utc(oldReceivedAt)}, ${utc(NOW)}, ${utc(NOW)})
    `);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsDailyRollup" ("siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers", "createdAt", "updatedAt")
      VALUES (${oldDay}, 'page_view'::"AnalyticsEventKind", 'en', '', 7, 3, ${utc(NOW)}, ${utc(NOW)})
    `);

    const run = await runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    // 没有可证明的提交闭集：旧行只按「实物仍在」报 retained/partial，不宣称完整；
    // 旧聚合不删、不覆盖、不改 revision。
    assert.equal(run.status, 'PARTIAL');
    assert.equal(run.errorCode, 'source_unavailable');
    assert.equal(run.report.deletedEvents, 1);
    assert.deepEqual(run.report.history.affectedDays, [oldDay]);
    assert.deepEqual(run.report.history.retainedAggregateDays, [oldDay]);
    assert.deepEqual(run.report.history.gapDays, []);
    assert.equal(run.report.history.coverage, 'partial');
    assert.equal(run.report.coverage, 'partial');

    // 旧聚合原样保留：标记与日聚合行内容不变，没有被残片重写。
    const marker = await db.$queryRaw<{ eventCount: number; sourceMaxReceivedAt: string | null }[]>`
      SELECT "eventCount", to_char("sourceMaxReceivedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceMaxReceivedAt"
      FROM "AnalyticsRollupDay" WHERE "siteDate" = ${oldDay}
    `;
    assert.equal(marker.length, 1);
    assert.equal(Number(marker[0].eventCount), 7);
    assert.equal(marker[0].sourceMaxReceivedAt, '2026-12-01T00:00:00.000Z');
    const daily = await db.$queryRaw<{ count: number; uniqueBrowsers: number }[]>`
      SELECT "count", "uniqueBrowsers" FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${oldDay}
    `;
    assert.equal(daily.length, 1);
    assert.equal(Number(daily[0].count), 7);
    assert.equal(Number(daily[0].uniqueBrowsers), 3);
    // 原始行仍按 30 天规则删除，不延长保留。
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-old-day'`), 0);

    const state = await retentionState(db);
    assert.equal(state.status, 'PARTIAL');
    assert.equal(state.errorCode, 'source_unavailable');
  });

  test('D1 旧 revision 的行只作 retained 观察：不冒充完整/当前口径，旧行不动', async () => {
    assert.ok(db);
    await db.$executeRaw(Prisma.sql`DELETE FROM "AnalyticsEvent" WHERE "receivedAt" <= ${utc(EVENT_CUTOFF)}`);
    const day = '2026-12-01';
    await seedOldDay(db, {
      day,
      eventId: 'ev-rev',
      receivedAt: new Date('2026-12-01T00:00:00.000Z'),
      marker: { timezoneRevision: 2, sourceMaxReceivedAt: new Date('2026-12-01T00:00:00.000Z') },
    });
    const run = await runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.deepEqual(run.report.history.affectedDays, [day]);
    // 行仍在只说明旧结果实物没删；revision 不再被读来判完整性，也不会产生「完整」结论。
    assert.deepEqual(run.report.history.retainedAggregateDays, [day]);
    assert.deepEqual(run.report.history.gapDays, []);
    assert.equal(run.report.coverage, 'partial');
    const marker = await db.$queryRaw<{ timezoneRevision: number }[]>`
      SELECT "timezoneRevision" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day}
    `;
    assert.equal(marker.length, 1);
    assert.equal(Number(marker[0].timezoneRevision), 2);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-rev'`), 0);
  });

  test('D1 watermark 落后于迟到事实：完整性无法确认，只作 retained 观察', async () => {
    assert.ok(db);
    await db.$executeRaw(Prisma.sql`DELETE FROM "AnalyticsEvent" WHERE "receivedAt" <= ${utc(EVENT_CUTOFF)}`);
    const day = '2026-12-02';
    await seedOldDay(db, {
      day,
      eventId: 'ev-late-old',
      receivedAt: new Date('2026-12-02T06:00:00.000Z'),
      marker: { timezoneRevision: 1, sourceMaxReceivedAt: new Date('2026-12-02T00:00:00.000Z') },
    });
    const run = await runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.deepEqual(run.report.history.retainedAggregateDays, [day]);
    assert.deepEqual(run.report.history.gapDays, []);
    assert.equal(run.report.coverage, 'partial');
    // 旧聚合实物不动，只是不再被当完整口径。
    const marker = await db.$queryRaw<{ sourceMaxReceivedAt: string | null }[]>`
      SELECT to_char("sourceMaxReceivedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceMaxReceivedAt"
      FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day}
    `;
    assert.equal(marker[0]?.sourceMaxReceivedAt, '2026-12-02T00:00:00.000Z');
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-late-old'`), 0);
  });

  test('D1 闭集前写入的旧行：只作 retained 观察，不判完整（核心反例）', async () => {
    assert.ok(db);
    await db.$executeRaw(Prisma.sql`DELETE FROM "AnalyticsEvent" WHERE "receivedAt" <= ${utc(EVENT_CUTOFF)}`);
    const day = '2026-12-03';
    const receivedAt = new Date('2026-12-03T02:00:00.000Z');
    // 站点日终 2026-12-03T16:00Z + 48h = 2026-12-05T16:00Z；该行在 2026-12-04 写入，闭集之前。
    // 旧实现会把它判成「完整」；现在没有任何完整性判定，只报「旧行仍在、完整性未确认」。
    await seedOldDay(db, {
      day,
      eventId: 'ev-closed-before',
      receivedAt,
      marker: {
        timezoneRevision: 1,
        sourceMaxReceivedAt: receivedAt,
        eventCount: 1,
        completedAt: new Date('2026-12-04T00:00:00.000Z'),
      },
    });
    const run = await runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.deepEqual(run.report.history.retainedAggregateDays, [day]);
    assert.deepEqual(run.report.history.gapDays, []);
    assert.equal(run.report.coverage, 'partial');
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-closed-before'`), 0);
  });

  test('D2 候选同源：删除按 receivedAt 排序，分类覆盖同一批事件的 occurredAt 日', async () => {
    assert.ok(db);
    await db.$executeRaw(Prisma.sql`DELETE FROM "AnalyticsEvent" WHERE "receivedAt" <= ${utc(EVENT_CUTOFF)}`);
    // 统计日更晚的先入库、统计日更早的后入库：日序与接收序相反。
    await seedOldDay(db, {
      day: '2027-02-11',
      eventId: 'ev-day-late',
      occurredAt: new Date('2027-02-11T02:00:00.000Z'),
      receivedAt: new Date('2027-02-12T00:00:00.000Z'),
      marker: null,
    });
    await seedOldDay(db, {
      day: '2027-02-10',
      eventId: 'ev-day-early',
      occurredAt: new Date('2027-02-10T02:00:00.000Z'),
      receivedAt: new Date('2027-02-13T00:00:00.000Z'),
      marker: null,
    });
    const run = await runAnalyticsRetention({
      db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true, batchSize: 1, maxPerRun: 10,
    });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.equal(run.report.deletedEvents, 2);
    assert.deepEqual(run.report.history.affectedDays, ['2027-02-10', '2027-02-11']);
    assert.deepEqual(run.report.history.gapDays, ['2027-02-10', '2027-02-11']);
    for (const eventId of ['ev-day-late', 'ev-day-early']) {
      assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = ${eventId}`), 0);
    }
  });

  test('D2 候选超上限：只分类并删除同一批前 N 个事件，不滑入未分类日', async () => {
    assert.ok(db);
    await db.$executeRaw(Prisma.sql`DELETE FROM "AnalyticsEvent" WHERE "receivedAt" <= ${utc(EVENT_CUTOFF)}`);
    await seedOldDay(db, { day: '2027-02-05', eventId: 'ev-cap-1', occurredAt: new Date('2027-02-05T02:00:00.000Z'), receivedAt: new Date('2027-02-13T00:00:00.000Z'), marker: null });
    await seedOldDay(db, { day: '2027-02-06', eventId: 'ev-cap-2', occurredAt: new Date('2027-02-06T02:00:00.000Z'), receivedAt: new Date('2027-02-13T01:00:00.000Z'), marker: null });
    await seedOldDay(db, { day: '2027-02-07', eventId: 'ev-cap-3', occurredAt: new Date('2027-02-07T02:00:00.000Z'), receivedAt: new Date('2027-02-13T02:00:00.000Z'), marker: null });
    const run = await runAnalyticsRetention({
      db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true, batchSize: 1, maxPerRun: 2,
    });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.equal(run.report.deletedEvents, 2);
    assert.deepEqual(run.report.history.affectedDays, ['2027-02-05', '2027-02-06']);
    assert.deepEqual(run.report.history.gapDays, ['2027-02-05', '2027-02-06']);
    // 第 3 条既没被删，也没被分类。
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-cap-3'`), 1);
    assert.equal(run.report.history.affectedDays.includes('2027-02-07'), false);
  });

  test('D3 旧行仍在 + 单日聚合失败：记 gap，不从 retained 回退、旧行原样保留', async () => {
    assert.ok(db);
    const edgeNow = new Date('2027-03-15T15:58:00.000Z');
    await db.$executeRaw`DELETE FROM "AnalyticsEvent"`;
    const day = '2027-02-14';
    const edgeReceivedAt = new Date('2027-02-13T15:58:00.000Z');
    await seedOldDay(db, {
      day,
      eventId: 'ev-edge',
      occurredAt: new Date('2027-02-13T16:03:00.000Z'),
      receivedAt: edgeReceivedAt,
      marker: { timezoneRevision: 1, sourceMaxReceivedAt: edgeReceivedAt },
    });
    const cleanup = await installInsertBlocker(db, { table: 'AnalyticsDailyRollup', column: 'siteDate', value: day });
    try {
      const run = await runAnalyticsRetention({ db, context: context(edgeNow, false), clock: () => edgeNow, deleteAuthorized: true });
      assert.equal(run.kind, 'completed');
      if (run.kind !== 'completed') return;
      assert.equal(run.status, 'PARTIAL');
      assert.deepEqual(run.report.history.recomputedDays, []);
      // 聚合尝试失败：即使旧行仍在也不能当可用结果，记 gap；旧聚合物件不删、不覆盖、不改 revision。
      assert.deepEqual(run.report.history.retainedAggregateDays, []);
      assert.deepEqual(run.report.history.gapDays, [day]);
      assert.equal(run.report.coverage, 'unavailable');
      const kept = await db.$queryRaw<{ eventCount: number }[]>`
        SELECT "eventCount" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day}
      `;
      assert.equal(kept.length, 1);
      assert.equal(Number(kept[0].eventCount), 1);
      assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-edge'`), 0);
    } finally {
      await cleanup();
    }
  });

  test('D3 旧结果不完整 + 单日聚合失败：记 gap，不冒充 retained', async () => {
    assert.ok(db);
    const edgeNow = new Date('2027-03-15T15:58:00.000Z');
    await db.$executeRaw`DELETE FROM "AnalyticsEvent"`;
    const day = '2027-02-14';
    const edgeReceivedAt = new Date('2027-02-13T15:58:00.000Z');
    await seedOldDay(db, {
      day,
      eventId: 'ev-edge',
      occurredAt: new Date('2027-02-13T16:03:00.000Z'),
      receivedAt: edgeReceivedAt,
      marker: { timezoneRevision: 1, sourceMaxReceivedAt: new Date('2027-02-13T00:00:00.000Z') },
    });
    const cleanup = await installInsertBlocker(db, { table: 'AnalyticsDailyRollup', column: 'siteDate', value: day });
    try {
      const run = await runAnalyticsRetention({ db, context: context(edgeNow, false), clock: () => edgeNow, deleteAuthorized: true });
      assert.equal(run.kind, 'completed');
      if (run.kind !== 'completed') return;
      assert.equal(run.status, 'PARTIAL');
      assert.deepEqual(run.report.history.recomputedDays, []);
      assert.deepEqual(run.report.history.retainedAggregateDays, []);
      assert.deepEqual(run.report.history.gapDays, [day]);
      assert.equal(run.report.coverage, 'unavailable');
      // 未证完整的旧行保留原地，不被当当前口径。
      const kept = await db.$queryRaw<{ sourceMaxReceivedAt: string | null }[]>`
        SELECT to_char("sourceMaxReceivedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceMaxReceivedAt"
        FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day}
      `;
      assert.equal(kept[0]?.sourceMaxReceivedAt, '2027-02-13T00:00:00.000Z');
      assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-edge'`), 0);
    } finally {
      await cleanup();
    }
  });

  test('跨日迟到：缺口按 occurredAt 的站点日归属，不按 receivedAt', async () => {
    assert.ok(db);
    // 只留一条「前一天发生、cutoff 当天才入库」的迟到事件：
    // 删除资格看 receivedAt，聚合归属日必须看 occurredAt。
    await db.$executeRaw`DELETE FROM "AnalyticsEvent"`;
    const occurredAt = new Date('2027-02-10T02:00:00.000Z'); // 上海 2027-02-10 10:00
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${'ev-late'}, ${'sk-late'}, ${'p'.repeat(64)}, ${'bh-late'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(occurredAt)}, ${utc(EVENT_CUTOFF)}
      )
    `);
    const run = await runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.deepEqual(run.report.history.affectedDays, ['2027-02-10']);
    assert.deepEqual(run.report.history.gapDays, ['2027-02-10']);
    assert.equal(run.report.coverage, 'unavailable');
    // 删除仍按 receivedAt：这条迟到事件照常被删。
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-late'`), 0);
  });

  test('可整日重算的到期日：删除前用剩余预算做单日聚合，成功后才删且不记 gap', async () => {
    assert.ok(db);
    // cutoff 落在本地 23:58，事件 receivedAt 在 cutoff，occurredAt 到次日 00:03：
    // 归属日 = 2027-02-14，其日界正好等于完整原始覆盖起点（可整日重算）。
    const edgeNow = new Date('2027-03-15T15:58:00.000Z');
    await db.$executeRaw`DELETE FROM "AnalyticsEvent"`;
    const edgeReceivedAt = new Date('2027-02-13T15:58:00.000Z');
    const edgeOccurredAt = new Date('2027-02-13T16:03:00.000Z');
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${'ev-edge'}, ${'sk-edge'}, ${'p'.repeat(64)}, ${'bh-edge'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(edgeOccurredAt)}, ${utc(edgeReceivedAt)}
      )
    `);
    const run = await runAnalyticsRetention({ db, context: context(edgeNow, false), clock: () => edgeNow, deleteAuthorized: true });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.equal(run.status, 'SUCCEEDED');
    assert.deepEqual(run.report.history.affectedDays, ['2027-02-14']);
    // 删除前先整日聚合：该日进入 recomputed，不是 gap；近期也 complete。
    assert.deepEqual(run.report.history.recomputedDays, ['2027-02-14']);
    assert.deepEqual(run.report.history.gapDays, []);
    assert.equal(run.report.history.coverage, 'complete');
    assert.equal(run.report.coverage, 'complete');
    // 聚合在删除前完成：raw 行被删，但该日的完整聚合仍在。
    const kept = await db.$queryRaw<{ eventCount: number }[]>`
      SELECT "eventCount" FROM "AnalyticsRollupDay" WHERE "siteDate" = '2027-02-14'
    `;
    assert.equal(kept.length, 1);
    assert.equal(Number(kept[0].eventCount), 1);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-edge'`), 0);
  });

  test('B2 计数：原始事件第二批失败，已提交批次仍计入 FAILED 摘要与实际差量', async () => {
    assert.ok(db);
    // 比默认夹具更早到期的一条：batchSize=1 时第一批删它，第二批撞触发器。
    const earlier = new Date(EVENT_CUTOFF.getTime() - 3_600_000);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${'ev-expired-first'}, ${'sk-expired-first'}, ${'p'.repeat(64)}, ${'bh-expired-first'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(earlier)}, ${utc(earlier)}
      )
    `);
    const cleanup = await installDeleteBlocker(db, { table: 'AnalyticsEvent', column: 'eventId', value: 'ev-expired' });
    try {
      const run = await runAnalyticsRetention({
        db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true, batchSize: 1, maxPerRun: 10,
      });
      assert.equal(run.kind, 'completed');
      if (run.kind !== 'completed') return;
      assert.equal(run.status, 'FAILED');
      assert.equal(run.errorCode, 'internal_error');
      assert.equal(run.report.deletedEvents, 1);
      assert.equal(run.report.deletedRollupDailyRows, 0);
      assert.equal(run.report.deletedRollupDays, 0);
      assert.equal(run.report.batches, 1);
      assert.equal(run.counts.deletedCount, 1);

      // 实际差量：第一批已提交，被拦截那条仍在。
      assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-expired-first'`), 0);
      assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-expired'`), 1);

      const state = await retentionState(db);
      assert.equal(state.status, 'FAILED');
      assert.equal(state.errorCode, 'internal_error');
      assert.equal(state.deletedCount, 1);
    } finally {
      await cleanup();
    }
  });

  test('B2 计数：日聚合第二批失败，三类阶段计数分别累计', async () => {
    assert.ok(db);
    const cleanup = await installDeleteBlocker(db, { table: 'AnalyticsDailyRollup', column: 'siteDate', value: ROLLUP_CUTOFF });
    try {
      const run = await runAnalyticsRetention({
        db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true, batchSize: 1, maxPerRun: 10,
      });
      assert.equal(run.kind, 'completed');
      if (run.kind !== 'completed') return;
      assert.equal(run.status, 'FAILED');
      // 事件阶段删掉 1 条到期事件；日聚合阶段第一批提交 1 行，第二批被拦截。
      assert.equal(run.report.deletedEvents, 1);
      assert.equal(run.report.deletedRollupDailyRows, 1);
      assert.equal(run.report.deletedRollupDays, 0);
      assert.equal(run.report.batches, 2);
      assert.equal(run.counts.deletedCount, 2);

      assert.equal(
        await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${shiftDate(ROLLUP_CUTOFF, -1)}`),
        0,
      );
      assert.equal(
        await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${ROLLUP_CUTOFF}`),
        1,
      );
      const state = await retentionState(db);
      assert.equal(state.status, 'FAILED');
      assert.equal(state.deletedCount, 2);
    } finally {
      await cleanup();
    }
  });

  test('B2 计数：日水位第二批失败，事件与日聚合的已提交数不丢', async () => {
    assert.ok(db);
    const cleanup = await installDeleteBlocker(db, { table: 'AnalyticsRollupDay', column: 'siteDate', value: ROLLUP_CUTOFF });
    try {
      const run = await runAnalyticsRetention({
        db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true, batchSize: 1, maxPerRun: 10,
      });
      assert.equal(run.kind, 'completed');
      if (run.kind !== 'completed') return;
      assert.equal(run.status, 'FAILED');
      // 事件 1 条、日聚合 2 行全部提交，日水位第一批 1 行后第二批被拦截。
      assert.equal(run.report.deletedEvents, 1);
      assert.equal(run.report.deletedRollupDailyRows, 2);
      assert.equal(run.report.deletedRollupDays, 1);
      assert.equal(run.report.batches, 4);
      assert.equal(run.counts.deletedCount, 4);

      assert.equal(
        await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${shiftDate(ROLLUP_CUTOFF, -1)}`),
        0,
      );
      assert.equal(
        await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${ROLLUP_CUTOFF}`),
        1,
      );
      const state = await retentionState(db);
      assert.equal(state.status, 'FAILED');
      assert.equal(state.deletedCount, 4);
    } finally {
      await cleanup();
    }
  });

  test('D4 守卫（双连接）：更新先提交则拒绝；RR 旧快照下并发更新归一为版本冲突', async () => {
    assert.ok(db);
    // A. ReadCommitted：另一条连接先提交 revision=2，再按 1 核对 → 拒绝。
    await setRevision(db, 2);
    await assert.rejects(
      () => db!.$transaction((tx) => assertCurrentTimezoneRevision(tx, 1, NOW)),
      (error: unknown) => error instanceof AggregateVersionConflict,
    );

    // B. RepeatableRead：事务先建立快照，另一条连接随后提交 revision=3；
    //    FOR UPDATE 在旧快照上遇到并发更新会抛 40001，守卫必须归一为版本冲突，
    //    而不是刷新快照返回新值、也不是普通失败。
    await assert.rejects(
      () => db!.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS "one"`;
        await setRevision(db!, 3);
        await assertCurrentTimezoneRevision(tx, 2, NOW);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10_000 }),
      (error: unknown) => error instanceof AggregateVersionConflict,
    );
    assert.equal(await revisionOf(db), 3);
  });

  test('D4 守卫（双连接）：缺行时并发插入 revision=2 → 拒绝且不覆盖成 1', async () => {
    assert.ok(db);
    await db!.$executeRaw`DELETE FROM "SiteSetting"`;
    await assert.rejects(
      () => db!.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS "one"`;
        // 快照里没有设置行；另一条连接随后插入 revision=2 并提交。
        await db!.$executeRaw(Prisma.sql`
          INSERT INTO "SiteSetting" ("key", "value")
          VALUES ('analytics.settings', ${JSON.stringify({
            version: 0,
            timezone: 'UTC',
            timezoneRevision: 2,
            changedAt: NOW.toISOString(),
            updatedBy: null,
          })}::jsonb)
        `);
        await assertCurrentTimezoneRevision(tx, 1, NOW);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10_000 }),
      (error: unknown) => error instanceof AggregateVersionConflict,
    );
    assert.equal(await revisionOf(db), 2, '并发插入的 revision 不得被守卫覆盖成初值');
  });

  test('D4 删除批次：第一批持锁合法提交，批间 revision 变化 → 第二批不删、计数保留', async () => {
    assert.ok(db);
    // 比默认夹具更早到期的一条：batchSize=1 时第一批删它，第二批才轮到 ev-expired。
    const earlier = new Date(EVENT_CUTOFF.getTime() - 3_600_000);
    await db!.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${'ev-guard-first'}, ${'sk-guard-first'}, ${'p'.repeat(64)}, ${'bh-guard-first'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(earlier)}, ${utc(earlier)}
      )
    `);
    const cleanup = await installRevisionBumpTrigger(db!, {
      table: 'AnalyticsEvent', column: 'eventId', value: 'ev-guard-first', to: 2,
    });
    try {
      const run = await runAnalyticsRetention({
        db: db!, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true, batchSize: 1, maxPerRun: 10,
      });
      // 守卫冲突让本轮停手；revision 已变，终态也写不进旧代次 → finish_failed。
      assert.equal(run.kind, 'finish_failed');
      const report = run.kind === 'finish_failed' ? run.report : null;
      assert.ok(report);
      assert.equal(report.deletedEvents, 1, '第一批已提交的删除数必须保留');
      assert.equal(report.deletedRollupDailyRows, 0);
      assert.equal(report.deletedRollupDays, 0);
      // 第二批被拦：第二条到期事件仍在；第一批那条已删。
      assert.equal(await count(db!, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-expired'`), 1);
      assert.equal(await count(db!, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-guard-first'`), 0);
    } finally {
      await cleanup();
    }
  });

  test('D4 预检：候选读取后 revision 被并发改掉 → 守卫冲突、删 0 行、终态写不进旧代次', async () => {
    assert.ok(db);
    const edgeNow = new Date('2027-03-15T15:58:00.000Z');
    await db!.$executeRaw`DELETE FROM "AnalyticsEvent"`;
    const edgeReceivedAt = new Date('2027-02-13T15:58:00.000Z');
    const edgeOccurredAt = new Date('2027-02-13T16:03:00.000Z');
    await db!.$executeRaw(Prisma.sql`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${'ev-pf-guard'}, ${'sk-pf-guard'}, ${'p'.repeat(64)}, ${'bh-pf-guard'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(edgeOccurredAt)}, ${utc(edgeReceivedAt)}
      )
    `);
    const wrapped = dbThatBumpsBeforePreflight(db!, () => setRevision(db!, 2));
    const run = await runAnalyticsRetention({
      db: wrapped, context: context(edgeNow, false), clock: () => edgeNow, deleteAuthorized: true,
    });
    // 预检守卫冲突 → 不删除；revision 已变，终态写不进旧代次。
    assert.equal(run.kind, 'finish_failed');
    assert.equal(await count(db!, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-pf-guard'`), 1);
    assert.equal(await revisionOf(db!), 2);
  });

  test('D4 删后聚合：删除批次提交后 revision 才变化 → 聚合整组不写、已提交删除数保留', async () => {
    assert.ok(db);
    const cleanup = await installRevisionBumpTrigger(db!, {
      table: 'AnalyticsRollupDay', column: 'siteDate', value: ROLLUP_CUTOFF, to: 2,
    });
    try {
      const run = await runAnalyticsRetention({ db: db!, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true });
      assert.equal(run.kind, 'finish_failed');
      const report = run.kind === 'finish_failed' ? run.report : null;
      assert.ok(report);
      assert.equal(report.deletedEvents, 1);
      assert.equal(report.deletedRollupDailyRows, 2);
      assert.equal(report.deletedRollupDays, 2);
      // 删后聚合被守卫拦下：聚合事务整组未提交，今天没有新的 watermark。
      const today = siteLocalDate(NOW, TZ);
      assert.equal(
        await count(db!, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${today}`),
        0,
      );
    } finally {
      await cleanup();
    }
  });

  test('operations HTTP 真接线：缺省 dryRun 只数不删，dryRun:false 未授权记 FAILED/forbidden', async () => {
    assert.ok(db);
    // composition 会在模块加载时创建全局 PrismaClient；给一个不可达假地址，
    // 证明本次调用只走注入的隔离库，不回退通用 DATABASE_URL。
    process.env.DATABASE_URL ||= 'postgresql://nope:nope@127.0.0.1:1/nope';
    const { createJobServices } = await import('../src/lib/server/composition');
    const services = createJobServices({ db, clock: () => NOW, deleteAuthorized: false });
    const handler = createOperationsHandler({ services: services.jobs, secret: SECRET, clock: () => NOW });
    const post = (body: unknown) =>
      handler(new Request('http://127.0.0.1:3000/api/admin/cron/operations', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));

    const dry = await post({ jobKey: ANALYTICS_RETENTION_KEY });
    assert.equal(dry.status, 200);
    const dryBody = await dry.json() as { jobKey: string; status: string; counts: { candidateCount?: number; deletedCount?: number } };
    assert.equal(dryBody.jobKey, ANALYTICS_RETENTION_KEY);
    assert.equal(dryBody.status, 'SUCCEEDED');
    assert.equal(dryBody.counts.candidateCount, 5);
    assert.equal(dryBody.counts.deletedCount, 0);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);

    const denied = await post({ jobKey: ANALYTICS_RETENTION_KEY, dryRun: false });
    assert.equal(denied.status, 200);
    const deniedBody = await denied.json() as { status: string; counts: { candidateCount?: number; deletedCount?: number } };
    assert.equal(deniedBody.status, 'FAILED');
    assert.equal(deniedBody.counts.candidateCount, 5);
    assert.equal(deniedBody.counts.deletedCount, 0);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);
  });

  test('聚合租约被占用时返回 busy，不读不删也不写状态', async () => {
    assert.ok(db);
    const holder = createJobLeaseRepo({ db, clock: () => NOW });
    const claimed = await holder.claimPreservingStatus({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: 'other-worker' });
    assert.equal(claimed.acquired, true);

    const run = await runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true });
    assert.deepEqual(run, { kind: 'busy' });
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "JobState" WHERE "key" = ${ANALYTICS_RETENTION_KEY}`),
      0,
    );
  });

  test('租约被新代次接管：旧一轮不能写终态，也不删行', async () => {
    assert.ok(db);
    const run = await runAnalyticsRetention({
      db,
      context: context(NOW, false),
      clock: () => NOW,
      deleteAuthorized: true,
      afterClaim: async (claim) => {
        await db.$executeRaw(Prisma.sql`
          UPDATE "JobState"
          SET "leaseOwner" = ${'newer-owner'}, "generation" = ${claim.generation + 1}
          WHERE "key" = ${ANALYTICS_ROLLUP_JOB_KEY}
        `);
      },
    });
    assert.equal(run.kind, 'finish_failed');
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "JobState" WHERE "key" = ${ANALYTICS_RETENTION_KEY}`),
      0,
    );
    // 新持有者仍在租约上，旧一轮没有把它释放。
    const owner = await db.$queryRaw<{ leaseOwner: string | null }[]>`
      SELECT "leaseOwner" FROM "JobState" WHERE "key" = ${ANALYTICS_ROLLUP_JOB_KEY}
    `;
    assert.equal(owner[0]?.leaseOwner, 'newer-owner');
  });

  test('预存同名 schema 负控：不认领、不 seed、不清理，哨兵原样保留', async () => {
    assert.ok(db);
    // 哨兵由本用例自己创建、自己清理；它不进入夹具的 ownedSchema 路径。
    const sentinel = `m5t11_${randomBytes(6).toString('hex')}`;
    await db.$executeRawUnsafe(`CREATE SCHEMA "${sentinel}"`);
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "${sentinel}"."marker" ("id" int primary key)`);
      await db.$executeRawUnsafe(`INSERT INTO "${sentinel}"."marker" ("id") VALUES (1)`);

      const claimed = await createOwnedSchema(db, sentinel);
      assert.equal(claimed, false, '预存 schema 不得被认领');

      const marker = await db.$queryRawUnsafe<{ id: number }[]>(`SELECT "id" FROM "${sentinel}"."marker"`);
      assert.deepEqual(marker.map((row) => Number(row.id)), [1]);
      const present = await db.$queryRaw<{ nspname: string }[]>`
        SELECT nspname FROM pg_namespace WHERE nspname = ${sentinel}
      `;
      assert.equal(present.length, 1, '未认领的对象不得被删除');
      const tables = await db.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = ${sentinel} ORDER BY tablename
      `;
      assert.deepEqual(tables.map((row) => row.tablename), ['marker'], '未认领的对象不得被 seed');
    } finally {
      await db.$executeRawUnsafe(`DROP SCHEMA "${sentinel}" CASCADE`);
    }
  });

  test('汇总到期截止日随站点时区走：同一天在两个时区可以差一个自然日', async () => {
    assert.ok(db);
    // 站点日 2027-03-15 在 UTC 与 Shanghai 下都是同一天；换到 UTC-11 仍是 03-14，
    // 这里只校验取到的截止日确实来自传入时区，而不是固定减 13 个月。
    const shanghai = rollupExpiryCutoff(NOW, 'Asia/Shanghai');
    const utcCutoff = rollupExpiryCutoff(NOW, 'UTC');
    assert.equal(shanghai, shiftCalendarMonths('2027-03-15', -13));
    assert.equal(utcCutoff, shiftCalendarMonths('2027-03-15', -13));
    assert.equal(shanghai, ROLLUP_CUTOFF);
  });
});
