import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Prisma, PrismaClient } from '@prisma/client';
import { createJobLeaseRepo, type JobLeaseRepo, type JobLeaseTx } from '../src/lib/server/jobs/lease-repo';
import { JOB_LEASE_MS, type JobLeaseView } from '../src/lib/server/jobs/types';

const base = process.env.DATABASE_URL;
const SCHEMA = `joblease_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}&connection_limit=5&pool_timeout=10`
  : null;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no DATABASE_URL';

after(async () => {
  if (!db) return;
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

function readRepoSource(): string {
  return readFileSync('src/lib/server/jobs/lease-repo.ts', 'utf8');
}

test('JobState 进入 schema，并由 deploy.sh 现有 db push 消费', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const deploy = readFileSync('deploy/deploy.sh', 'utf8');
  assert.match(schema, /enum JobRunStatus \{[^}]*NEVER[^}]*RUNNING[^}]*SUCCEEDED[^}]*FAILED[^}]*PARTIAL/s);
  assert.match(schema, /model JobState \{[^}]*key\s+String\s+@id[^}]*leaseOwner\s+String\?[^}]*generation\s+Int[^}]*lockedUntil\s+DateTime\?[^}]*lastStartedAt\s+DateTime\?[^}]*lastSucceededAt\s+DateTime\?[^}]*lastFinishedAt\s+DateTime\?[^}]*lastStatus\s+JobRunStatus[^}]*lastErrorCode\s+String\?[^}]*summary\s+Json\?/s);
  const push = deploy.split(/\r?\n/).find((line) => line.includes('migrate db push'));
  assert.ok(push);
  assert.match(push, /db push --skip-generate --schema prisma\/schema\.prisma/);
  assert.doesNotMatch(push, /accept-data-loss/);
  const source = readRepoSource();
  assert.doesNotMatch(source, /queryRawUnsafe|child_process|\beval\s*\(|new Function\s*\(|\bspawn\s*\(|execFile|execSync/);
});

async function reset() {
  assert.ok(db);
  assert.match(SCHEMA, /^joblease_\d+$/);
  await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SCHEMA}"."JobState"`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SCHEMA}"."SiteSetting"`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SCHEMA}"."LeaseProbe"`);
  await db.$executeRawUnsafe(`DROP TYPE IF EXISTS "${SCHEMA}"."JobRunStatus"`);
  await db.$executeRawUnsafe(`CREATE TYPE "${SCHEMA}"."JobRunStatus" AS ENUM ('NEVER', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL')`);
  await db.$executeRawUnsafe(`
    CREATE TABLE "${SCHEMA}"."JobState" (
      "key" TEXT PRIMARY KEY,
      "leaseOwner" TEXT,
      "generation" INTEGER NOT NULL DEFAULT 0,
      "lockedUntil" TIMESTAMP(3),
      "lastStartedAt" TIMESTAMP(3),
      "lastSucceededAt" TIMESTAMP(3),
      "lastFinishedAt" TIMESTAMP(3),
      "lastStatus" "${SCHEMA}"."JobRunStatus" NOT NULL DEFAULT 'NEVER',
      "lastErrorCode" TEXT,
      "summary" JSONB,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL
    )
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE "${SCHEMA}"."SiteSetting" (
      "key" TEXT PRIMARY KEY,
      "value" JSONB NOT NULL
    )
  `);
}

function leaseFailure(error: unknown) {
  if (error instanceof Error && error.name === 'JobLeaseAbort') {
    switch (error.message) {
      case 'invalid': case 'stale': case 'expired': case 'revision_conflict': case 'revision_unreadable':
        return error.message;
    }
  }
  throw error;
}

function harness() {
  assert.ok(db);
  const client = db;
  let now = Date.parse('2026-01-15T00:00:00.000Z');
  const raw = createJobLeaseRepo({ db: client, clock: () => new Date(now) });
  // 测试用顶层 use-case 拥有事务；传入业务 tx 时直接复用并让拒绝异常退出。
  const repo = {
    ...raw,
    async complete(input: Parameters<JobLeaseRepo['complete']>[0], tx?: JobLeaseTx) {
      if (tx) return raw.complete(input, tx);
      try {
        return await client.$transaction((current) => raw.complete(input, current), { timeout: 15_000 });
      } catch (error) {
        return { committed: false as const, reason: leaseFailure(error) };
      }
    },
    async renew(input: Parameters<JobLeaseRepo['renew']>[0], tx?: JobLeaseTx) {
      if (tx) return raw.renew(input, tx);
      try {
        return await client.$transaction((current) => raw.renew(input, current), { timeout: 15_000 });
      } catch (error) {
        const reason = leaseFailure(error);
        if (reason !== 'invalid' && reason !== 'stale' && reason !== 'expired') throw error;
        return { renewed: false as const, reason };
      }
    },
  };
  return { repo, now: () => now, advance: (ms: number) => { now += ms; } };
}

async function setRevision(value: unknown | null) {
  assert.ok(db);
  if (value === null) {
    await db.$executeRaw`DELETE FROM "SiteSetting" WHERE "key" = 'analytics.settings'`;
    return;
  }
  await db.$executeRaw`
    INSERT INTO "SiteSetting" ("key", "value")
    VALUES ('analytics.settings', ${JSON.stringify(value)}::jsonb)
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"
  `;
}

async function storedOwner(key: string): Promise<string | null> {
  assert.ok(db);
  const rows = await db.$queryRaw<{ leaseOwner: string | null }[]>`
    SELECT "leaseOwner" FROM "JobState" WHERE "key" = ${key}
  `;
  return rows[0]?.leaseOwner ?? null;
}

function succeeded(view: JobLeaseView, summarySent: number, at: number) {
  assert.equal(view.lastStatus, 'SUCCEEDED');
  assert.equal(view.summary?.counts?.sent, summarySent);
  assert.equal(view.lastSucceededAt, new Date(at).toISOString());
  assert.equal(view.leaseActive, false);
  assert.equal(view.lockedUntil, null);
  assert.equal('leaseOwner' in view, false);
}

describe('JobState 租约', { concurrency: false, skip }, () => {
  test('并发领取同一 key 只有一个成功，另一 key 互不阻塞', async () => {
    await reset();
    const { repo, now } = harness();
    for (let round = 0; round < 5; round += 1) {
      await reset();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) => repo.claim({ key: 'analytics-aggregate', owner: `worker-${index}` })),
      );
      const won = results.filter((result) => result.acquired);
      assert.equal(won.length, 1, `round ${round}`);
      assert.equal(won[0] && won[0].acquired && won[0].generation, 1);
      assert.equal(won[0] && won[0].acquired && won[0].timezoneRevision, 1);
      assert.equal(won[0] && won[0].acquired && Date.parse(won[0].lockedUntil) - now(), JOB_LEASE_MS);
      assert.equal(results.filter((result) => !result.acquired && result.reason === 'busy').length, 7);
      const again = await repo.claim({ key: 'analytics-aggregate', owner: 'worker-late' });
      assert.deepEqual(again, { acquired: false, reason: 'busy' });
    }
    const other = harness().repo.claim({ key: 'mail-queue', owner: 'mail-worker' });
    const claimed = await other;
    assert.equal(claimed.acquired, true);
    assert.equal(await storedOwner('mail-queue'), 'mail-worker');
    if (claimed.acquired) assert.equal('leaseOwner' in claimed.view, false);
  });

  test('满 90 秒才能以新代次领取；旧 owner 不能续租或覆盖新结果', async () => {
    await reset();
    const { repo, now, advance } = harness();
    const first = await repo.claim({ key: 'chat-notifications', owner: 'owner-a' });
    assert.equal(first.acquired, true);
    if (!first.acquired) return;
    advance(JOB_LEASE_MS - 1);
    assert.deepEqual(
      await repo.claim({ key: 'chat-notifications', owner: 'owner-b' }),
      { acquired: false, reason: 'busy' },
    );
    const renewed = await repo.renew({ key: 'chat-notifications', owner: 'owner-a', generation: first.generation });
    assert.equal(renewed.renewed, true);
    if (renewed.renewed) assert.equal(Date.parse(renewed.lockedUntil) - now(), JOB_LEASE_MS);
    assert.deepEqual(
      await repo.renew({ key: 'chat-notifications', owner: 'owner-b', generation: first.generation }),
      { renewed: false, reason: 'stale' },
    );
    advance(JOB_LEASE_MS);
    assert.deepEqual(
      await repo.renew({ key: 'chat-notifications', owner: 'owner-a', generation: first.generation }),
      { renewed: false, reason: 'expired' },
    );
    assert.deepEqual(await repo.complete({
      key: 'chat-notifications', owner: 'owner-a', generation: first.generation,
      status: 'SUCCEEDED', summary: { counts: { sent: 1 } }, timezoneRevision: 1,
    }), { committed: false, reason: 'expired' });
    const second = await repo.claim({ key: 'chat-notifications', owner: 'owner-b' });
    assert.equal(second.acquired && second.generation, 2);
    if (!second.acquired) return;
    const committed = await repo.complete({
      key: 'chat-notifications', owner: 'owner-b', generation: second.generation,
      status: 'SUCCEEDED', summary: { counts: { sent: 2 } }, timezoneRevision: second.timezoneRevision,
    });
    assert.equal(committed.committed, true);
    if (!committed.committed) return;
    succeeded(committed.view, 2, now());
    const late = await repo.complete({
      key: 'chat-notifications', owner: 'owner-a', generation: first.generation,
      status: 'SUCCEEDED', summary: { counts: { sent: 9 } }, timezoneRevision: 1,
    });
    assert.equal(late.committed, false);
    const current = await repo.read('chat-notifications');
    assert.equal(current.ok, true);
    if (current.ok) succeeded(current.view, 2, now());
    assert.notEqual(await storedOwner('chat-notifications'), 'owner-a');
  });

  test('成功才推进 lastSucceededAt；失败、部分完成和重复提交保留原成功时间', async () => {
    await reset();
    const { repo, now, advance } = harness();
    const claimed = await repo.claim({ key: 'ops-sample', owner: 'sampler' });
    assert.equal(claimed.acquired, true);
    if (!claimed.acquired) return;
    const done = await repo.complete({
      key: 'ops-sample', owner: 'sampler', generation: claimed.generation,
      status: 'SUCCEEDED', summary: { counts: { sent: 1 }, times: { measuredAt: '2026-01-15T00:00:00.000Z' }, versions: { timezoneRevision: 1 } },
      timezoneRevision: claimed.timezoneRevision,
    });
    assert.equal(done.committed, true);
    if (!done.committed) return;
    const succeededAt = done.view.lastSucceededAt;
    assert.equal(succeededAt, new Date(now()).toISOString());
    const duplicate = await repo.complete({
      key: 'ops-sample', owner: 'sampler', generation: claimed.generation,
      status: 'FAILED', summary: { counts: { failed: 4 } }, errorCode: 'internal_error',
      timezoneRevision: 1,
    });
    assert.equal(duplicate.committed, false);
    advance(JOB_LEASE_MS);
    const next = await repo.claim({ key: 'ops-sample', owner: 'sampler-2' });
    assert.equal(next.acquired && next.generation, 2);
    if (!next.acquired) return;
    advance(1_000);
    const failed = await repo.complete({
      key: 'ops-sample', owner: 'sampler-2', generation: next.generation,
      status: 'FAILED', summary: { counts: { failed: 2 } }, errorCode: 'service_unavailable',
      timezoneRevision: next.timezoneRevision,
    });
    assert.equal(failed.committed, true);
    if (!failed.committed) return;
    assert.equal(failed.view.lastStatus, 'FAILED');
    assert.equal(failed.view.lastSucceededAt, succeededAt);
    assert.equal(failed.view.lastErrorCode, 'service_unavailable');
    assert.equal(failed.view.summary?.counts?.failed, 2);
    assert.equal(failed.view.lastFinishedAt, new Date(now()).toISOString());
    advance(JOB_LEASE_MS);
    const third = await repo.claim({ key: 'ops-sample', owner: 'sampler-3' });
    assert.equal(third.acquired, true);
    if (!third.acquired) return;
    const partial = await repo.complete({
      key: 'ops-sample', owner: 'sampler-3', generation: third.generation,
      status: 'PARTIAL', summary: { counts: { stale: 1 } }, errorCode: 'source_unavailable',
      timezoneRevision: third.timezoneRevision,
    });
    assert.equal(partial.committed, true);
    if (partial.committed) {
      assert.equal(partial.view.lastStatus, 'PARTIAL');
      assert.equal(partial.view.lastSucceededAt, succeededAt);
    }
  });

  test('同一代次并发完成只有一个写入', async () => {
    await reset();
    const { repo } = harness();
    const claimed = await repo.claim({ key: 'analytics-retention', owner: 'keeper' });
    assert.equal(claimed.acquired, true);
    if (!claimed.acquired) return;
    const [left, right] = await Promise.all([
      repo.complete({
        key: 'analytics-retention', owner: 'keeper', generation: claimed.generation,
        status: 'SUCCEEDED', summary: { counts: { candidateCount: 3 } }, timezoneRevision: claimed.timezoneRevision,
      }),
      repo.complete({
        key: 'analytics-retention', owner: 'keeper', generation: claimed.generation,
        status: 'FAILED', summary: { counts: { deletedCount: 8 } }, errorCode: 'internal_error',
        timezoneRevision: claimed.timezoneRevision,
      }),
    ]);
    const committed = [left, right].filter((result) => result.committed);
    assert.equal(committed.length, 1);
    const current = await repo.read('analytics-retention');
    assert.equal(current.ok, true);
    if (!current.ok || !committed[0]?.committed) return;
    assert.equal(current.view.lastStatus, committed[0].view.lastStatus);
    assert.deepEqual(current.view.summary, committed[0].view.summary);
    if (current.view.lastStatus === 'SUCCEEDED') assert.equal(current.view.summary?.counts?.candidateCount, 3);
    if (current.view.lastStatus === 'FAILED') {
      assert.equal(current.view.lastSucceededAt, null);
      assert.equal(current.view.summary?.counts?.deletedCount, 8);
    }
  });

  test('summary 只接受白名单；空输入、脚本字段和脏错误码不写库', async () => {
    await reset();
    const { repo } = harness();
    assert.deepEqual(await repo.claim({ key: '', owner: 'worker-a' }), { acquired: false, reason: 'invalid' });
    assert.deepEqual(await repo.claim({ key: 'analytics-aggregate', owner: '' }), { acquired: false, reason: 'invalid' });
    assert.deepEqual(await repo.claim({ key: 'not-a-job', owner: 'worker-a' }), { acquired: false, reason: 'invalid' });
    assert.deepEqual(
      await repo.claim({ key: 'analytics-aggregate; drop table', owner: 'worker-a' }),
      { acquired: false, reason: 'invalid' },
    );
    const claimed = await repo.claim({ key: 'mail-queue', owner: 'mailer' });
    assert.equal(claimed.acquired, true);
    if (!claimed.acquired) return;
    const rejected = [
      { summary: { counts: { sent: 1 }, script: 'process.exit(1)' } },
      { summary: { counts: { sent: -1 } } },
      { summary: { counts: { command: 'rm -rf /' } } },
      { summary: { times: { measuredAt: 'yesterday' } } },
      { summary: { versions: { timezoneRevision: 0 } } },
      { summary: undefined },
      { status: 'FAILED', summary: { counts: { failed: 1 } }, errorCode: 'Error: postgres://user:secret@db/app' },
      { status: 'SUCCEEDED', summary: { counts: { sent: 1 } }, errorCode: 'internal_error' },
    ];
    for (const attempt of rejected) {
      const result = await repo.complete({
        key: 'mail-queue',
        owner: 'mailer',
        generation: claimed.generation,
        status: attempt.status ?? 'SUCCEEDED',
        summary: attempt.summary,
        errorCode: attempt.errorCode ?? null,
        timezoneRevision: claimed.timezoneRevision,
      });
      assert.equal(result.committed, false);
      assert.equal(result.committed ? '' : result.reason, 'invalid');
    }
    const current = await repo.read('mail-queue');
    assert.equal(current.ok && current.view.lastStatus, 'RUNNING');
    assert.equal(current.ok && current.view.summary, null);
    assert.equal(current.ok && current.view.lastSucceededAt, null);
    assert.equal(await storedOwner('mail-queue'), 'mailer');
    assert.equal((await repo.read('not-a-job')).ok, false);
    const absent = await repo.read('chat-retention');
    assert.equal(absent.ok && absent.view.lastStatus, 'NEVER');
    assert.equal(absent.ok && absent.view.generation, 0);
  });

  test('旧时区代次和不可读设置拒绝提交，且不改成功时间', async () => {
    await reset();
    const { repo, now, advance } = harness();
    await setRevision({
      version: 2, timezone: 'UTC', timezoneRevision: 2, changedAt: '2026-01-01T00:00:00.000Z', updatedBy: null,
    });
    const claimed = await repo.claim({ key: 'analytics-aggregate', owner: 'aggregator' });
    assert.equal(claimed.acquired && claimed.timezoneRevision, 2);
    if (!claimed.acquired) return;
    const stale = await repo.complete({
      key: 'analytics-aggregate', owner: 'aggregator', generation: claimed.generation,
      status: 'SUCCEEDED', summary: { counts: { sent: 1 }, versions: { timezoneRevision: 1 } },
      timezoneRevision: 1,
    });
    assert.deepEqual(stale, { committed: false, reason: 'revision_conflict' });
    await setRevision({ timezone: 'UTC' });
    const unreadable = await repo.complete({
      key: 'analytics-aggregate', owner: 'aggregator', generation: claimed.generation,
      status: 'SUCCEEDED', summary: { counts: { sent: 1 } }, timezoneRevision: 2,
    });
    assert.deepEqual(unreadable, { committed: false, reason: 'revision_unreadable' });
    const running = await repo.read('analytics-aggregate');
    assert.equal(running.ok && running.view.lastStatus, 'RUNNING');
    assert.equal(running.ok && running.view.lastSucceededAt, null);
    await setRevision(null);
    advance(1_000);
    const done = await repo.complete({
      key: 'analytics-aggregate', owner: 'aggregator', generation: claimed.generation,
      status: 'SUCCEEDED', summary: null, timezoneRevision: 1,
    });
    assert.equal(done.committed, true);
    if (done.committed) assert.equal(done.view.lastSucceededAt, new Date(now()).toISOString());
    await db!.$executeRaw`
      UPDATE "JobState"
      SET "summary" = ${JSON.stringify({ log: 'stack at /secret/path.ts' })}::jsonb,
          "lastErrorCode" = 'postgres://user:secret@db/app'
      WHERE "key" = 'analytics-aggregate'
    `;
    const safe = await repo.read('analytics-aggregate');
    assert.equal(safe.ok, true);
    if (safe.ok) {
      assert.equal(safe.view.summary, null);
      assert.equal(safe.view.lastErrorCode, null);
      assert.equal(JSON.stringify(safe.view).includes('secret'), false);
      assert.equal(JSON.stringify(safe.view).includes('leaseOwner'), false);
    }
  });

  function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForUngrantedLock() {
  assert.ok(db);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
    if (Number(rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('lock wait not observed');
}

async function markerCount(id: string): Promise<number> {
  assert.ok(db);
  const rows = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "LeaseProbe" WHERE "id" = ${id}`;
  return Number(rows[0]?.n ?? 0);
}

test('外层事务回滚同时撤回 JobState 完成', async () => {
  await reset();
  assert.ok(db);
  await db.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}"."LeaseProbe" ("id" TEXT PRIMARY KEY)`);
  const { repo } = harness();
  const claimed = await repo.claim({ key: 'analytics-aggregate', owner: 'worker-a' });
  assert.equal(claimed.acquired, true);
  if (!claimed.acquired) return;
  await assert.rejects(db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "LeaseProbe" ("id") VALUES ('joint')`;
    const result = await repo.complete({
      key: 'analytics-aggregate', owner: 'worker-a', generation: claimed.generation,
      status: 'SUCCEEDED', summary: { counts: { sent: 1 } }, timezoneRevision: claimed.timezoneRevision,
    }, tx);
    assert.equal(result.committed, true);
    throw new Error('rollback-both');
  }, { timeout: 15_000 }), (error: unknown) => error instanceof Error && error.message === 'rollback-both');
  assert.equal(await markerCount('joint'), 0);
  const rolled = await repo.read('analytics-aggregate');
  assert.equal(rolled.ok && rolled.view.lastStatus, 'RUNNING');
  assert.equal(rolled.ok && rolled.view.lastSucceededAt, null);
});

test('旧代次完成会回滚同一事务里的业务结果', async () => {
  await reset();
  assert.ok(db);
  await db.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}"."LeaseProbe" ("id" TEXT PRIMARY KEY)`);
  const { repo, advance } = harness();
  const claimed = await repo.claim({ key: 'analytics-aggregate', owner: 'worker-a' });
  assert.equal(claimed.acquired, true);
  if (!claimed.acquired) return;
  advance(JOB_LEASE_MS);
  const next = await repo.claim({ key: 'analytics-aggregate', owner: 'worker-b' });
  assert.equal(next.acquired && next.generation, 2);
  if (!next.acquired) return;
  await assert.rejects(db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "LeaseProbe" ("id") VALUES ('old-gen')`;
    await repo.complete({
      key: 'analytics-aggregate', owner: 'worker-a', generation: claimed.generation,
      status: 'SUCCEEDED', summary: { counts: { sent: 9 } }, timezoneRevision: 1,
    }, tx);
  }, { timeout: 15_000 }));
  assert.equal(await markerCount('old-gen'), 0);
  const current = await repo.read('analytics-aggregate');
  assert.equal(current.ok && current.view.generation, 2);
  assert.equal(current.ok && current.view.lastStatus, 'RUNNING');
  assert.equal(current.ok && current.view.lastSucceededAt, null);
});

test('89.5s 调用、90.5s 拿到设置锁或 JobState 锁后不能完成、续租或改成功时间', async () => {
  await reset();
  await setRevision({ version: 1, timezone: 'UTC', timezoneRevision: 1, changedAt: '2026-01-15T00:00:00.000Z', updatedBy: null });
  const started = Date.parse('2026-01-15T00:00:00.000Z');
  const settings = harness();
  const claimed = await settings.repo.claim({ key: 'analytics-aggregate', owner: 'worker-a' });
  assert.equal(claimed.acquired, true);
  if (!claimed.acquired) return;
  settings.advance(89_500);
  const releaseSettings = gate();
  const settingsHeld = gate();
  const settingsHolder = db!.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "value" FROM "SiteSetting" WHERE "key" = 'analytics.settings' FOR UPDATE`;
    settingsHeld.resolve();
    await releaseSettings.promise;
  }, { timeout: 15_000 });
  await settingsHeld.promise;
  const completing = settings.repo.complete({
    key: 'analytics-aggregate', owner: 'worker-a', generation: claimed.generation,
    status: 'SUCCEEDED', summary: { counts: { sent: 1 } }, timezoneRevision: 1,
  });
  await waitForUngrantedLock();
  settings.advance(1_000);
  releaseSettings.resolve();
  const completed = await completing;
  await settingsHolder;
  assert.equal(completed.committed, false);
  const afterSettings = await settings.repo.read('analytics-aggregate');
  assert.equal(afterSettings.ok && afterSettings.view.lastStatus, 'RUNNING');
  assert.equal(afterSettings.ok && afterSettings.view.lastSucceededAt, null);
  assert.equal(afterSettings.ok && Date.parse(afterSettings.view.lockedUntil ?? ''), started + JOB_LEASE_MS);

  const job = harness();
  const jobClaim = await job.repo.claim({ key: 'mail-queue', owner: 'worker-b' });
  assert.equal(jobClaim.acquired, true);
  if (!jobClaim.acquired) return;
  job.advance(89_500);
  const releaseJob = gate();
  const jobHeld = gate();
  const jobHolder = db!.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "generation" FROM "JobState" WHERE "key" = 'mail-queue' FOR UPDATE`;
    jobHeld.resolve();
    await releaseJob.promise;
  }, { timeout: 15_000 });
  await jobHeld.promise;
  const jobComplete = job.repo.complete({
    key: 'mail-queue', owner: 'worker-b', generation: jobClaim.generation,
    status: 'SUCCEEDED', summary: { counts: { sent: 1 } }, timezoneRevision: jobClaim.timezoneRevision,
  });
  await waitForUngrantedLock();
  job.advance(1_000);
  releaseJob.resolve();
  const jobResult = await jobComplete;
  await jobHolder;
  assert.equal(jobResult.committed, false);
  const afterJob = await job.repo.read('mail-queue');
  assert.equal(afterJob.ok && afterJob.view.lastStatus, 'RUNNING');
  assert.equal(afterJob.ok && afterJob.view.lastSucceededAt, null);
  assert.equal(afterJob.ok && Date.parse(afterJob.view.lockedUntil ?? ''), started + JOB_LEASE_MS);

  const renew = harness();
  const renewClaim = await renew.repo.claim({ key: 'chat-notifications', owner: 'worker-c' });
  assert.equal(renewClaim.acquired, true);
  if (!renewClaim.acquired) return;
  renew.advance(89_500);
  const releaseRenew = gate();
  const renewHeld = gate();
  const renewHolder = db!.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "generation" FROM "JobState" WHERE "key" = 'chat-notifications' FOR UPDATE`;
    renewHeld.resolve();
    await releaseRenew.promise;
  }, { timeout: 15_000 });
  await renewHeld.promise;
  const renewing = renew.repo.renew({ key: 'chat-notifications', owner: 'worker-c', generation: renewClaim.generation });
  await waitForUngrantedLock();
  renew.advance(1_000);
  releaseRenew.resolve();
  const renewed = await renewing;
  await renewHolder;
  assert.equal(renewed.renewed, false);
  const afterRenew = await renew.repo.read('chat-notifications');
  assert.equal(afterRenew.ok && afterRenew.view.lastSucceededAt, null);
  assert.equal(afterRenew.ok && Date.parse(afterRenew.view.lockedUntil ?? ''), started + JOB_LEASE_MS);
});

test('缺行读取后并发创建 revision 2，旧 revision 1 不能完成', async () => {
  await reset();
  const { repo } = harness();
  const claimed = await repo.claim({ key: 'analytics-aggregate', owner: 'aggregator' });
  assert.equal(claimed.acquired && claimed.timezoneRevision, 1);
  if (!claimed.acquired) return;
  const release = gate();
  const held = gate();
  const holder = db!.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "generation" FROM "JobState" WHERE "key" = 'analytics-aggregate' FOR UPDATE`;
    held.resolve();
    await release.promise;
  }, { timeout: 15_000 });
  await held.promise;
  const completing = repo.complete({
    key: 'analytics-aggregate', owner: 'aggregator', generation: claimed.generation,
    status: 'SUCCEEDED', summary: null, timezoneRevision: 1,
  });
  await waitForUngrantedLock();
  await setRevision({ version: 2, timezone: 'UTC', timezoneRevision: 2, changedAt: '2026-01-15T00:00:00.000Z', updatedBy: null });
  release.resolve();
  const result = await completing;
  await holder;
  assert.equal(result.committed, false);
  assert.equal(result.committed ? '' : result.reason, 'revision_conflict');
  const current = await repo.read('analytics-aggregate');
  assert.equal(current.ok && current.view.lastStatus, 'RUNNING');
  assert.equal(current.ok && current.view.lastSucceededAt, null);
  assert.equal(current.ok && current.view.generation, 1);
});

test('仓储不能在缺少上层事务时自行续租或完成', async () => {
  await reset();
  assert.ok(db);
  const repo = createJobLeaseRepo({ db });
  const claimed = await repo.claim({ key: 'analytics-aggregate', owner: 'transaction-required' });
  assert.equal(claimed.acquired, true);
  if (!claimed.acquired) return;
  const required = (error: unknown) => error instanceof Error && error.name === 'JobLeaseAbort' && error.message === 'transaction_required';
  await assert.rejects(Reflect.apply(repo.renew, repo, [{ key: 'analytics-aggregate', owner: 'transaction-required', generation: claimed.generation }]), required);
  await assert.rejects(Reflect.apply(repo.complete, repo, [{
    key: 'analytics-aggregate', owner: 'transaction-required', generation: claimed.generation,
    status: 'SUCCEEDED', summary: null, timezoneRevision: claimed.timezoneRevision,
  }]), required);
});

test('RepeatableRead 缺行旧快照不能在新时区代次提交后发布结果', async () => {
  await reset();
  assert.ok(db);
  await db.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}"."LeaseProbe" ("id" TEXT PRIMARY KEY)`);
  const { repo } = harness();
  const claimed = await repo.claim({ key: 'analytics-aggregate', owner: 'repeatable-read' });
  assert.equal(claimed.acquired, true);
  if (!claimed.acquired) return;
  const snapshot = gate();
  const resume = gate();
  const transaction = db.$transaction(async (tx) => {
    const settings = await tx.$queryRaw`SELECT "value" FROM "SiteSetting" WHERE "key" = 'analytics.settings'`;
    assert.deepEqual(settings, []);
    snapshot.resolve();
    await resume.promise;
    await tx.$executeRaw`INSERT INTO "LeaseProbe" ("id") VALUES ('old-snapshot')`;
    return repo.complete({
      key: 'analytics-aggregate', owner: 'repeatable-read', generation: claimed.generation,
      status: 'SUCCEEDED', summary: null, timezoneRevision: 1,
    }, tx);
  }, { isolationLevel: 'RepeatableRead', timeout: 15_000 });
  await snapshot.promise;
  await setRevision({ version: 2, timezone: 'UTC', timezoneRevision: 2, changedAt: '2026-01-15T00:00:00.000Z', updatedBy: null });
  const rejected = assert.rejects(transaction, (error: unknown) =>
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || (error.code === 'P2010' && error.meta?.code === '40001')),
  );
  resume.resolve();
  await rejected;
  assert.equal(await markerCount('old-snapshot'), 0);
  const current = await repo.read('analytics-aggregate');
  assert.equal(current.ok && current.view.lastStatus, 'RUNNING');
  assert.equal(current.ok && current.view.lastSucceededAt, null);
  const settings = await db.$queryRaw<{ value: { timezoneRevision: number } }[]>`
    SELECT "value" FROM "SiteSetting" WHERE "key" = 'analytics.settings'
  `;
  assert.equal(settings[0]?.value.timezoneRevision, 2);
});

test('不可读设置不能领取出租约', async () => {
    await reset();
    await setRevision({ timezone: 'Not/A_Zone' });
    const { repo } = harness();
    assert.deepEqual(
      await repo.claim({ key: 'analytics-aggregate', owner: 'aggregator' }),
      { acquired: false, reason: 'revision_unreadable' },
    );
    assert.equal(await storedOwner('analytics-aggregate'), null);
  });
});
