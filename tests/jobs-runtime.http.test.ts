// M5-T8 固定作业运行时与 cron 入口的真实 PostgreSQL 验收。
//
// 只在本文件被显式提供 M5T8_TEST_DATABASE_URL（或 DATABASE_URL 且
// M5T8_REQUIRE_DATABASE=true）时执行；CI 尚未接线前不冒充已跑。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { createOperationsHandler, JOB_DEADLINE_MS, JOB_MAX_BATCH } from '../src/lib/server/jobs/registry';
import { createJobServices } from '../src/lib/server/composition';
import { AGGREGATE_JOB_KEY } from '../src/lib/server/analytics/aggregate-repo';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';

const base = process.env.M5T8_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const SCHEMA = `m5t8_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}`
  : null;
if (process.env.M5T8_REQUIRE_DATABASE === 'true' && !url) {
  throw new Error('M5T8_TEST_DATABASE_URL must be a postgres URL when M5T8_REQUIRE_DATABASE=true');
}
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no M5T8_TEST_DATABASE_URL';
const SECRET = 'm5t8-local-cron-secret-32-characters';
const NOW = new Date('2026-03-01T10:00:00.000Z');
const TZ = 'Asia/Shanghai';

function requireDb(): PrismaClient {
  if (!db) assert.fail('M5-T8 PG 回归必须连真实 PostgreSQL：M5T8_TEST_DATABASE_URL 未设置');
  return db;
}

function post(body: unknown, authorization: string | null = `Bearer ${SECRET}`) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization !== null) headers.authorization = authorization;
  return new Request('http://127.0.0.1:3000/api/admin/cron/operations', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

after(async () => {
  if (!db) return;
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

describe('M5-T8 jobs runtime + cron operations route', { concurrency: false, skip, timeout: 120_000 }, () => {
  before(async () => {
    if (!db) return;
    const conn = requireDb();
    await conn.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    const { execFileSync } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url! },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  async function reset() {
    const conn = requireDb();
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsEvent"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsDailyRollup"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsRollupDay"`);
    await conn.$executeRawUnsafe(`DELETE FROM "JobState"`);
    await conn.$executeRawUnsafe(`DELETE FROM "SiteSetting"`);
  }

  function handler() {
    const clock = () => new Date(NOW);
    return createOperationsHandler({
      services: createJobServices({ db: requireDb(), clock }).jobs,
      clock,
      secret: SECRET,
    });
  }

  test('固定 key 与租约：未凭据/错凭据 401，未知 key 与非法体 400，GET 不存在', async () => {
    await reset();
    const handle = handler();
    assert.equal((await handle(post({ jobKey: 'analytics-aggregate' }, null))).status, 401);
    assert.equal((await handle(post({ jobKey: 'analytics-aggregate' }, 'Bearer wrong'))).status, 401);
    assert.equal((await handle(post({ jobKey: 'chat-notifications' }))).status, 400);
    assert.equal((await handle(post({ jobKey: 'arbitrary-script' }))).status, 400);
    assert.equal((await handle(post({ jobKey: 'analytics-aggregate', extra: 1 }))).status, 400);
    const route = await import('../src/app/api/admin/cron/operations/route');
    assert.equal(typeof (route as { GET?: unknown }).GET, 'undefined', '看板/GET 不能触发作业');
    assert.ok(JOB_MAX_BATCH === 500);
    assert.ok(JOB_DEADLINE_MS === 55_000);
  });

  test('成功轮：领取租约、写 JobState 与 watermark，summary 只在白名单内', async () => {
    await reset();
    const conn = requireDb();
    const day = siteLocalDate(NOW, TZ);
    await conn.$executeRaw`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${`ev-${process.pid}`}, ${`sk-${process.pid}`}, ${'p'.repeat(64)}, ${'bh-1'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${null}, ${'/en'},
        ${`${day}T01:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC',
        ${`${day}T02:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC'
      )
    `;
    const res = await handler()(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 200);
    const body = await res.json() as { jobKey: string; status: string; counts: { candidateCount?: number }; finishedAt: string };
    assert.equal(body.jobKey, 'analytics-aggregate');
    assert.equal(body.status, 'SUCCEEDED');
    assert.equal(typeof body.finishedAt, 'string');
    assert.ok((body.counts.candidateCount ?? 0) >= 1);

    const state = await conn.$queryRaw<{ generation: number; lastStatus: string; summary: unknown; lastSucceededAt: Date | null }[]>`
      SELECT "generation", "lastStatus"::text AS "lastStatus", "summary", "lastSucceededAt"
      FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY}
    `;
    assert.equal(state.length, 1);
    assert.equal(state[0]!.lastStatus, 'SUCCEEDED');
    assert.ok(state[0]!.lastSucceededAt !== null);
    assert.deepEqual(Object.keys(state[0]!.summary as Record<string, unknown>).sort(), ['counts', 'times', 'versions']);
    const watermark = await conn.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay"
    `;
    assert.ok(Number(watermark[0]!.c) >= 1, '成功轮必须提交 watermark');
  });

  test('租约被占用：返回 409 job_busy，且不改 JobState/水位', async () => {
    await reset();
    const conn = requireDb();
    const until = new Date(NOW.getTime() + 60_000);
    await conn.$executeRaw`
      INSERT INTO "JobState" ("key", "leaseOwner", "generation", "lockedUntil", "lastStartedAt", "lastStatus", "createdAt", "updatedAt")
      VALUES (${AGGREGATE_JOB_KEY}, ${'other-worker'}, ${3}, ${until.toISOString()}::timestamptz AT TIME ZONE 'UTC',
              ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${'RUNNING'}::"JobRunStatus",
              ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    `;
    const res = await handler()(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 409);
    const state = await conn.$queryRaw<{ generation: number; owner: string }[]>`
      SELECT "generation", "leaseOwner" AS "owner" FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY}
    `;
    assert.equal(Number(state[0]!.generation), 3, '忙时不得推进代次');
    assert.equal(state[0]!.owner, 'other-worker', '忙时不得改租约 owner');
  });

  test('版本冲突：作业 FAILED，上一次成功 watermark 原样保留（不被覆盖）', async () => {
    await reset();
    const conn = requireDb();
    const day = siteLocalDate(NOW, TZ);
    // 已存的日聚合时区代次高于本轮（1），M5-T3 的版本校验必须让整组回滚。
    await conn.$executeRaw`
      INSERT INTO "AnalyticsRollupDay" ("siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt")
      VALUES (${day}, ${9}, ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${7}, NULL,
              ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    `;
    const before = await conn.$queryRaw<{ siteDate: string; timezoneRevision: number; eventCount: number }[]>`
      SELECT "siteDate", "timezoneRevision", "eventCount" FROM "AnalyticsRollupDay" ORDER BY "siteDate"
    `;
    const res = await handler()(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string };
    assert.equal(body.status, 'FAILED');
    const afterRows = await conn.$queryRaw<{ siteDate: string; timezoneRevision: number; eventCount: number }[]>`
      SELECT "siteDate", "timezoneRevision", "eventCount" FROM "AnalyticsRollupDay" ORDER BY "siteDate"
    `;
    assert.deepEqual(afterRows, before, '失败轮不得覆盖上一次成功 watermark');
    const state = await conn.$queryRaw<{ lastStatus: string; lastErrorCode: string | null }[]>`
      SELECT "lastStatus"::text AS "lastStatus", "lastErrorCode" FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY}
    `;
    assert.equal(state[0]!.lastStatus, 'FAILED');
    assert.equal(state[0]!.lastErrorCode, 'version_conflict');
  });

  test('cron 模板：五分钟一次 POST operations，仅 analytics-aggregate，55s 超时，不再有旧 rollup 行', () => {
    const cron = readFileSync('deploy/cron.nbshiyan', 'utf8');
    const lines = cron.split(/\r?\n/);
    const aggregate = lines.filter((line) => line.includes('/api/admin/cron/operations'));
    assert.equal(aggregate.length, 1, '必须恰有一条 operations 调度');
    assert.match(aggregate[0]!, /^\*\/5 \* \* \* \* /, '必须是每 5 分钟');
    assert.match(aggregate[0]!, /jobKey:'analytics-aggregate'/);
    assert.match(aggregate[0]!, /AbortSignal\.timeout\(55000\)/);
    assert.equal(lines.some((line) => line.includes('/api/admin/cron/analytics-rollup')), false, '不能双写旧 rollup');
    assert.equal(
      lines.some((line) => line.includes('/api/admin/cron/retention-cleanup')),
      true,
      '原有清理调度保持',
    );
  });
});
