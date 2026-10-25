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

test('时区代次变了以后，原始事件已经删掉的日子不会被空汇总覆盖', () => {
  const stored = [{
    siteDate: '2026-05-17',
    timezoneRevision: 1,
    sourceMaxReceivedAt: '2026-05-17T11:00:00.000Z',
    eventCount: 4,
  }];
  const empty = [{ siteDate: '2026-05-17', sourceMaxReceivedAt: null }];
  assert.deepEqual(selectRollupDates({
    eligible: ['2026-05-17', '2026-05-18'],
    stored,
    freshness: empty,
    timezoneRevision: 2,
  }), ['2026-05-18']);
  assert.deepEqual(selectRollupDates({
    eligible: ['2026-05-17'],
    stored,
    freshness: [{ siteDate: '2026-05-17', sourceMaxReceivedAt: '2026-05-17T11:00:00.000Z' }],
    timezoneRevision: 2,
  }), ['2026-05-17']);
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
  const route = readFileSync('src/app/api/admin/cron/retention-cleanup/route.ts', 'utf8');
  assert.match(route, /secretMatches\(token, process\.env\.CRON_SECRET\)/);
  assert.match(route, /no-store/);
  assert.match(route, /ANALYTICS_ROLLUP_JOB_KEY|runRetentionCleanup/);
});

test('没带密钥或密钥不对时返回 401，响应不缓存也不回显密钥', async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'unit-test-cron-secret-not-a-real-value';
  try {
    const missing = await GET(new Request('http://127.0.0.1/api/admin/cron/retention-cleanup'));
    const wrong = await POST(new Request('http://127.0.0.1/api/admin/cron/retention-cleanup', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    }));
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.equal(wrong.headers.get('cache-control'), 'no-store');
    const body = await wrong.json() as { error: string };
    assert.equal(body.error, 'unauthorized');
    assert.equal(JSON.stringify(body).includes('unit-test-cron-secret'), false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
