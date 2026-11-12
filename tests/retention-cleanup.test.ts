import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recomputableFrom, siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { selectRollupDates } from '../src/lib/analytics/rollup-plan';
import {
  chatAndInquiryRetentionDays,
  RAW_EVENT_RETENTION_MS,
  retention,
  ROLLUP_RETENTION_MONTHS,
} from '../src/lib/server/retention';
import { retainUntilFromNow } from '../src/lib/server/admin/inquiries';
import { anonymizeInquiriesTx } from '../src/lib/server/privacy';
import {
  classifyRetentionDays,
  deletionBatchSizes,
  eventDeletionFloorLocalDate,
  rawEventCutoff,
  RETENTION_CLEANUP_BATCH_SIZE,
  RETENTION_CLEANUP_MAX_PER_RUN,
  retentionCleanupMode,
  rollupDeletionBefore,
} from '../src/lib/server/analytics/retention-plan';
import { GET, POST } from '../src/app/api/admin/cron/retention-cleanup/route';
import { createRetentionCleanupHandler } from '../src/lib/server/analytics/retention-cleanup-handler';
import type { RetentionCleanupResult } from '../src/lib/server/analytics/retention-cleanup';
import { alertRetentionCleanupIssue } from '../src/lib/server/cron-alert';

const NOW = new Date('2026-06-15T03:30:00.000Z');

test('三个保留期：原始事件复用 30 天常量，汇总 13 个月，询盘沿用 730 天', () => {
  const previous = process.env.INQUIRY_RETAIN_DAYS;
  delete process.env.INQUIRY_RETAIN_DAYS;
  try {
    assert.equal(RAW_EVENT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
    assert.equal(ROLLUP_RETENTION_MONTHS, 13);
    assert.equal(chatAndInquiryRetentionDays(), 730);
    assert.equal(chatAndInquiryRetentionDays(), retention.inquiryDays);
    assert.equal(retainUntilFromNow(NOW).toISOString(), '2028-06-14T03:30:00.000Z');
  } finally {
    if (previous === undefined) delete process.env.INQUIRY_RETAIN_DAYS;
    else process.env.INQUIRY_RETAIN_DAYS = previous;
  }
});

test('原始事件截止点跨过站点日界，只允许删除重算下限之前的本地日', () => {
  assert.equal(siteLocalDate(NOW, 'America/New_York'), '2026-06-14');
  assert.notEqual(siteLocalDate(NOW, 'America/New_York'), NOW.toISOString().slice(0, 10));
  assert.equal(rawEventCutoff(NOW).toISOString(), '2026-05-16T03:30:00.000Z');
  assert.equal(recomputableFrom(NOW, 'America/New_York'), '2026-05-16T04:00:00.000Z');
  assert.equal(eventDeletionFloorLocalDate(NOW, 'America/New_York'), '2026-05-16');
  assert.equal(eventDeletionFloorLocalDate(NOW, 'UTC'), '2026-05-17');
  const plan = classifyRetentionDays({
    floorLocalDate: eventDeletionFloorLocalDate(NOW, 'America/New_York'),
    contiguousThrough: '2026-05-15',
    currentRevision: 4,
    days: [
      { siteDate: '2026-05-14', timezoneRevision: 4 },
      { siteDate: '2026-05-15', timezoneRevision: 3 },
      { siteDate: '2026-05-16', timezoneRevision: 4 },
      { siteDate: '2026-05-13', timezoneRevision: 4 },
    ],
  });
  assert.deepEqual(plan.deletable, ['2026-05-14', '2026-05-13']);
  assert.equal(plan.skippedRevisionMismatchDays, 1);
  assert.equal(plan.skippedAfterGapDays, 0);
});

test('连续汇总只作为上界，代次不符的日子不因为落在上界内就被删除', () => {
  const plan = classifyRetentionDays({
    floorLocalDate: '2026-05-20',
    contiguousThrough: '2026-05-18',
    currentRevision: 2,
    days: [
      { siteDate: '2026-05-18', timezoneRevision: 2 },
      { siteDate: '2026-05-19', timezoneRevision: 2 },
      { siteDate: '2026-05-17', timezoneRevision: 1 },
    ],
  });
  assert.deepEqual(plan.deletable, ['2026-05-18']);
  assert.equal(plan.skippedAfterGapDays, 1);
  assert.equal(plan.skippedRevisionMismatchDays, 1);
  assert.equal(classifyRetentionDays({
    floorLocalDate: '2026-05-20',
    contiguousThrough: null,
    currentRevision: 2,
    days: [{ siteDate: '2026-05-18', timezoneRevision: 2 }],
  }).deletable.length, 0);
});

test('分批上限：每批 5000，每次运行停在 20000', () => {
  assert.equal(RETENTION_CLEANUP_BATCH_SIZE, 5_000);
  assert.equal(RETENTION_CLEANUP_MAX_PER_RUN, 20_000);
  assert.deepEqual(deletionBatchSizes(23_000, 5_000, 20_000), [5_000, 5_000, 5_000, 5_000]);
  assert.deepEqual(deletionBatchSizes(3, 2, 3), [2, 1]);
  assert.deepEqual(deletionBatchSizes(0, 5_000, 20_000), []);
});

test('汇总保留按站点本地日计算 13 个日历月，到期日当天不删', () => {
  assert.equal(rollupDeletionBefore(new Date('2026-06-15T12:00:00.000Z'), 'UTC'), '2025-05-15');
  assert.equal(rollupDeletionBefore(NOW, 'America/New_York'), '2025-05-14');
  assert.equal(rollupDeletionBefore(new Date('2026-03-31T00:00:00.000Z'), 'UTC'), '2025-02-28');
  assert.equal('2025-05-14' < '2025-05-15', true);
  assert.equal('2025-05-15' < '2025-05-15', false);
});

test('清理模式默认 dry-run，只有精确的 delete 会删', () => {
  assert.equal(retentionCleanupMode({}), 'dry-run');
  assert.equal(retentionCleanupMode({ RETENTION_CLEANUP_MODE: 'dry-run' }), 'dry-run');
  assert.equal(retentionCleanupMode({ RETENTION_CLEANUP_MODE: 'delete' }), 'delete');
  assert.equal(retentionCleanupMode({ RETENTION_CLEANUP_MODE: 'DELETE' }), 'dry-run');
});

test('时区代次变了以后，窗口外的旧日不会被选中，窗口里的空日仍会重算', () => {
  const outside = [{
    siteDate: '2026-05-01',
    timezoneRevision: 1,
    sourceMaxReceivedAt: '2026-05-01T12:00:00.000Z',
  }];
  assert.deepEqual(selectRollupDates({
    eligible: ['2026-05-18', '2026-05-19'],
    stored: outside,
    freshness: [],
    timezoneRevision: 2,
  }), ['2026-05-18', '2026-05-19']);
  const shifted = [{
    siteDate: '2026-05-18',
    timezoneRevision: 1,
    sourceMaxReceivedAt: '2026-05-18T02:00:00.000Z',
  }];
  assert.deepEqual(selectRollupDates({
    eligible: ['2026-05-18', '2026-05-19'],
    stored: shifted,
    freshness: [{ siteDate: '2026-05-18', sourceMaxReceivedAt: null }],
    timezoneRevision: 2,
  }), ['2026-05-18', '2026-05-19']);
  assert.deepEqual(selectRollupDates({
    eligible: ['2026-05-18'],
    stored: shifted,
    freshness: [{ siteDate: '2026-05-18', sourceMaxReceivedAt: '2026-05-18T02:00:00.000Z' }],
    timezoneRevision: 2,
  }), ['2026-05-18']);
});

test('询盘匿名化仍写 [deleted]，清理任务不删除询盘或聊天行', async () => {
  const notes: string[] = [];
  const subjects: string[] = [];
  let deletedInquiry = false;
  const tx = {
    logoUpload: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    inquiryItem: { findMany: async () => [], updateMany: async () => ({ count: 0 }), update: async () => ({}) },
    inquiry: {
      updateMany: async (input: { data: { message: null; anonymizedAt: Date } }) => {
        assert.equal(input.data.message, null);
        assert.ok(input.data.anonymizedAt);
        return { count: 1 };
      },
      update: async () => ({}),
      delete: async () => { deletedInquiry = true; },
      deleteMany: async () => { deletedInquiry = true; return { count: 1 }; },
    },
    inquiryMessage: {
      updateMany: async (input: { data: { subject: string; bodyHtml: string } }) => {
        subjects.push(input.data.subject);
        assert.equal(input.data.bodyHtml, '[deleted]');
        return { count: 1 };
      },
    },
    inquiryNote: {
      updateMany: async (input: { data: { body: string } }) => {
        notes.push(input.data.body);
        return { count: 1 };
      },
    },
    mailMessage: { updateMany: async () => ({ count: 0 }), findMany: async () => [] },
    sampleRequest: { updateMany: async () => ({ count: 0 }) },
  };
  await anonymizeInquiriesTx(tx as never, ['inq1'], NOW);
  assert.deepEqual(notes, ['[deleted]']);
  assert.deepEqual(subjects, ['[deleted]']);
  assert.equal(deletedInquiry, false);
  const privacy = readFileSync('src/lib/server/privacy.ts', 'utf8');
  const replyStart = privacy.indexOf('export async function findInquiryForReply');
  assert.match(privacy.slice(replyStart, replyStart + 600), /anonymizedAt:\s*null/);
  const cleanup = readFileSync('src/lib/server/analytics/retention-cleanup.ts', 'utf8');
  assert.doesNotMatch(cleanup, /DELETE FROM "Inquiry"|DELETE FROM "Chat|inquiry\.delete|chatVisitorSession\.delete/);
  assert.match(cleanup, /isSiteDateRolledUp/);
  assert.match(cleanup, /latestContiguousRolledUpDate/);
  assert.match(cleanup, /::timestamptz AT TIME ZONE 'UTC'/);
  assert.match(cleanup, /\$transaction/);
  assert.match(cleanup, /claimPreservingStatus/);
  assert.match(cleanup, /analytics-retention/);
  assert.match(cleanup, /"occurredAt" < /);
  assert.match(cleanup, /"receivedAt" < /);
  assert.doesNotMatch(cleanup, /repo\.complete\(/);
  assert.doesNotMatch(cleanup, /queryRawUnsafe/);
});

test('retention-cleanup cron 在 03:30 调本机，命令行没有密钥，409 算跳过', () => {
  const text = readFileSync('deploy/cron.nbshiyan', 'utf8');
  const line = text.split(/\r?\n/).find((row) => row.includes('/api/admin/cron/retention-cleanup'));
  assert.ok(line);
  assert.match(line, /^30 3 \* \* \* /);
  assert.match(line, /http:\/\/127\.0\.0\.1:3000\/api\/admin\/cron\/retention-cleanup/);
  assert.match(line, /process\.env\.CRON_SECRET/);
  assert.equal(line.replaceAll('process.env.CRON_SECRET', '').includes('CRON_SECRET'), false);
  assert.match(line, /AbortSignal\.timeout\(300000\)/);
  assert.match(line, /r\.status===409/);
  assert.match(line, /normal skip, not a failure/);
  assert.match(line, /no retry/);
  assert.doesNotMatch(line, /\bmethod\s*:/);
  assert.doesNotMatch(line, /RETENTION_CLEANUP_MODE/);
  assert.match(line, />> @DATA_DIR@\/cron-retention-cleanup\.log 2>&1$/);
  assert.match(text, /dry-run/);
  // route 只是薄接线：唯一的 handler 来自 server 内部模块，并且绑定真实 prisma/服务/告警去重。
  const route = readFileSync('src/app/api/admin/cron/retention-cleanup/route.ts', 'utf8');
  assert.match(route, /createRetentionCleanupHandler\(\{/);
  assert.match(route, /runCleanup: \(\) => runRetentionCleanup\(\{ db: prisma \}\)/);
  assert.match(route, /reportFailure: reportRetentionFailure/);
  assert.equal((route.match(/alertRetentionCleanupIssue\(/g) ?? []).length, 1);
  // Next 路由导出白名单：route 不得再导出构造器/处理器。
  const exported = [...route.matchAll(/^export (?:const|async function|function) (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), ['GET', 'POST', 'maxDuration', 'runtime']);
  // 分支与鉴权都在 handler 模块里（行为由本文件后半段的真实调用覆盖）。
  const handler = readFileSync('src/lib/server/analytics/retention-cleanup-handler.ts', 'utf8');
  assert.match(handler, /secretMatches\(token, process\.env\.CRON_SECRET\)/);
  assert.match(handler, /no-store/);
  assert.match(handler, /result\.status === 'unknown'/);
  assert.match(handler, /reportFailure\('commit_unknown'\)/);
  const busy = handler.slice(handler.indexOf("result.status === 'busy'"), handler.indexOf("result.status === 'unknown'"));
  assert.equal(busy.includes('reportFailure'), false);
});

test('route 入口防线：无 token/错 token 直接 401，不触达清理服务也不告警', async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'unit-test-cron-secret-not-a-real-value';
  // 入口防线命中时，handler 的日志（服务调用/告警路径）一条都不该出现。
  const logged: string[] = [];
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  console.info = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const missing = await GET(new Request('http://127.0.0.1/api/admin/cron/retention-cleanup'));
    const wrong = await POST(new Request('http://127.0.0.1/api/admin/cron/retention-cleanup', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    }));
    for (const response of [missing, wrong]) {
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
    }
    assert.deepEqual(logged, [], '未授权不得走到 handler 的任何分支（无服务调用、无告警、无成功日志）');
    assert.equal(JSON.stringify(logged).includes('unit-test-cron-secret'), false);
  } finally {
    console.error = originalError;
    console.info = originalInfo;
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test('保留清理失败告警只含任务名和错误码，发送失败不抛出', async () => {
  const calls: { kind: string; lines: Record<string, string | number>; key: string }[] = [];
  const sent = await alertRetentionCleanupIssue(
    { errorCode: 'internal_error' },
    async (kind, lines, key) => { calls.push({ kind, lines, key }); },
    new Date('2026-06-16T03:30:00.000Z'),
  );
  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind, '保留清理异常');
  assert.equal(calls[0]?.key, 'cron-retention-cleanup:2026-06-16');
  assert.deepEqual(calls[0]?.lines, { 任务: 'retention-cleanup', 错误码: 'internal_error' });
  const dirty: { lines: Record<string, string | number> }[] = [];
  await alertRetentionCleanupIssue(
    { errorCode: 'internal_error postgres://secret' },
    async (_kind, lines) => { dirty.push({ lines }); },
  );
  assert.equal(JSON.stringify(dirty).includes('postgres://'), false);
  assert.equal(dirty[0]?.lines['错误码'], 'internal_errorpostgres:secret');
  await assert.doesNotReject(alertRetentionCleanupIssue({ errorCode: 'invalid' }, async () => { throw new Error('down'); }));
});

const TEST_CRON_SECRET = 'unit-test-cron-secret-not-a-real-value';

async function withCronSecret<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
}

function authorizedRequest(method = 'GET') {
  return new Request('http://127.0.0.1/api/admin/cron/retention-cleanup', {
    method,
    headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
  });
}

/** 真实 handler + 注入的清理服务/告警记录器：分支必须实跑，不看源码字符串。 */
function cronHandler(runCleanup: () => Promise<RetentionCleanupResult>, alerts: string[]) {
  return createRetentionCleanupHandler({
    runCleanup,
    reportFailure: async (errorCode) => { alerts.push(errorCode); },
  });
}

test('真实 handler：COMMIT 未知返回 500，phase/targets 不被折叠，不写 success/假 FAILED', async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  try {
    await withCronSecret(async () => {
      const alerts: string[] = [];
      const handle = cronHandler(async () => ({
        status: 'unknown',
        phase: 'metrics',
        targets: ['RawEvent', 'AnalyticsDailyRollup'],
        deletedEvents: 3,
        deletedRollupRows: 7,
      }), alerts);
      const response = await handle(authorizedRequest());
      assert.equal(response.status, 500);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json() as Record<string, unknown>;
      // 兼容既有 HTTP 错误形状：只有 error；没有 status/committed，也不假装已回滚。
      assert.deepEqual(body, { error: 'retention_cleanup_failed' });
      assert.equal('committed' in body, false);
      assert.equal('status' in body, false);
      // 走既有告警通道，但分类是 commit_unknown（HTTP 500 不等于事务已回滚）。
      assert.deepEqual(alerts, ['commit_unknown']);
      const logged = errors.join('\n');
      assert.match(logged, /commit_unknown/);
      assert.match(logged, /"phase":"metrics"/);
      assert.match(logged, /"targets":2/);
      assert.match(logged, /"confirmedDeletedEvents":3/);
      assert.match(logged, /"confirmedDeletedRollupRows":7/);
    });
  } finally {
    console.error = original;
  }
});

test('真实 handler：未授权返回 401，不调用清理服务也不告警', async () => {
  await withCronSecret(async () => {
    const alerts: string[] = [];
    let ran = 0;
    const handle = createRetentionCleanupHandler({
      runCleanup: async () => { ran += 1; return { status: 'busy' }; },
      reportFailure: async (errorCode) => { alerts.push(errorCode); },
    });
    const missing = await handle(new Request('http://127.0.0.1/api/admin/cron/retention-cleanup'));
    const wrong = await handle(new Request('http://127.0.0.1/api/admin/cron/retention-cleanup', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    }));
    for (const response of [missing, wrong]) {
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
    }
    assert.equal(ran, 0);
    assert.deepEqual(alerts, []);
  });
});

test('真实 handler：租约被占用返回 409，且不告警', async () => {
  await withCronSecret(async () => {
    const alerts: string[] = [];
    const handle = cronHandler(async () => ({ status: 'busy' }), alerts);
    const response = await handle(authorizedRequest());
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'job_busy' });
    assert.deepEqual(alerts, []);
  });
});

test('真实 handler：普通失败沿原告警通道返回 500', async () => {
  await withCronSecret(async () => {
    const alerts: string[] = [];
    const handle = cronHandler(async () => ({
      status: 'failed',
      errorCode: 'service_unavailable',
      deletedEvents: 2,
      deletedRollupRows: 1,
    }), alerts);
    const response = await handle(authorizedRequest());
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'retention_cleanup_failed' });
    assert.deepEqual(alerts, ['service_unavailable']);
  });
});

const SUCCEEDED_COUNTS = {
  mode: 'delete',
  candidateEvents: 120,
  deletedEvents: 100,
  candidateRollupRows: 8,
  deletedRollupRows: 6,
  skippedUnrolledDays: 1,
  skippedRevisionMismatchDays: 2,
  skippedAfterGapDays: 0,
  keptExpiredEvents: 4,
  batches: 2,
  batchSize: 5_000,
  maxPerRun: 20_000,
} as const;

test('真实 handler：成功响应保持原字段，且不告警', async () => {
  await withCronSecret(async () => {
    const alerts: string[] = [];
    const handle = cronHandler(async () => ({ status: 'succeeded', ...SUCCEEDED_COUNTS }), alerts);
    const response = await handle(authorizedRequest('POST'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { ...SUCCEEDED_COUNTS, status: 'succeeded' });
    assert.deepEqual(alerts, []);
  });
});

test('真实 handler：清理服务抛错仍收口为 500，并按内部错误告警', async () => {
  await withCronSecret(async () => {
    const alerts: string[] = [];
    const handle = cronHandler(async () => { throw new Error('boom'); }, alerts);
    const response = await handle(authorizedRequest());
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'retention_cleanup_failed' });
    assert.deepEqual(alerts, ['internal_error']);
  });
});
