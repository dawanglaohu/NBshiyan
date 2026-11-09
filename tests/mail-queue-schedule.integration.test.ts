// M4-T12 邮件队列调度真库验收：租约/预算/attempt/CAS/D 回退/收尾窗/告警。
// 只在显式提供 M4T12_TEST_DATABASE_URL 时运行；M4T12_REQUIRE_DATABASE=true 时缺库直接失败，不 skip 记绿。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { PrismaClient, type MailMessage } from '@prisma/client';
import { JobCountsSchema } from '../src/lib/contracts/ops';
import { createMailQueueJob, MAIL_QUEUE_KEY } from '../src/lib/server/mail/queue-job';
import { createOperationsHandler } from '../src/lib/server/jobs/registry';
import {
  deliver,
  processMailQueue,
  reserveAndStart,
  sendInquiryMail,
  type MailCloseWindow,
  type MailRow,
} from '../src/lib/server/mail/send';
import { sendAdminAlert, setMailTransportFactory } from '../src/lib/server/mail';
import { smtpConfig, type SmtpConfig } from '../src/lib/server/mail/config';
import type { MailSendAdapter, OutboundMail, SendOutcome } from '../src/lib/server/mail/adapter';
import type { JobBudget } from '../src/lib/server/jobs/registry';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

const REQUIRE = process.env.M4T12_REQUIRE_DATABASE === 'true';
const SCHEMA = 'm4t12';
const NOW = new Date('2026-03-01T10:00:00.000Z');
const ENV = {
  APP_ENV: 'test',
  NEXT_PUBLIC_ADMIN_MAIL: 'http',
  MAIL_SEND_ADAPTER: 'mock',
  SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_USER: 'fake-user@example.test',
  SMTP_PASS: 'fake-pass', MAIL_FROM: 'PackJoyU <no-reply@mail.example.test>', REPLY_DOMAIN: 'reply.example.test',
  MAIL_DAILY_CAP: '450',
} as const;

function validateDatabaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('M4T12_TEST_DATABASE_URL must be a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new Error('M4T12_TEST_DATABASE_URL must use postgres');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('M4T12_TEST_DATABASE_URL must point at loopback');
  if (parsed.pathname.replace(/^\//, '') !== 'b9_m4t12_20261109') throw new Error('M4T12_TEST_DATABASE_URL must name b9_m4t12_20261109');
  const existing = parsed.searchParams.get('schema');
  if (existing !== null && existing !== SCHEMA) throw new Error('M4T12_TEST_DATABASE_URL must carry schema=m4t12');
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
}

const url = validateDatabaseUrl(process.env.M4T12_TEST_DATABASE_URL);
if (REQUIRE && !url) throw new Error('M4T12_TEST_DATABASE_URL is required when M4T12_REQUIRE_DATABASE=true');
const skip = !url && 'no M4T12_TEST_DATABASE_URL';
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const requireDb = (): PrismaClient => {
  if (!db) assert.fail('M4-T12 集成验收必须连真实 PostgreSQL：M4T12_TEST_DATABASE_URL 未设置');
  return db;
};
const cfg = (smtpConfig(ENV) as { ok: true; cfg: SmtpConfig }).cfg;

type FakeAdapter = { sent: OutboundMail[]; api: MailSendAdapter };
function fakeAdapter(result: SendOutcome | ((mail: OutboundMail) => Promise<SendOutcome> | SendOutcome)): FakeAdapter {
  const sent: OutboundMail[] = [];
  const api: MailSendAdapter = {
    kind: 'mock',
    async send(mail) {
      sent.push(mail);
      return typeof result === 'function' ? await result(mail) : result;
    },
  };
  return { sent, api };
}
const OK: SendOutcome = { ok: true, messageId: '<ok@example.test>' };

async function reset() {
  if (!db) return;
  await db.$executeRawUnsafe('TRUNCATE "MailMessage", "Inquiry", "Contact", "JobState", "SiteSetting", "AuditLog" CASCADE');
}

let seq = 0;
async function seedInquiry(over: { anonymizedAt?: Date | null } = {}) {
  const conn = requireDb();
  const n = ++seq;
  const contact = await conn.contact.create({ data: { region: 'US', name: 'Buyer', email: `buyer${n}@example.test` } });
  return conn.inquiry.create({
    data: {
      ref: `PJ-M4T12-${n}`, replyToken: `tok${String(n).padStart(13, '0')}`,
      contactId: contact.id, locale: 'en', source: 'FORM',
      retainUntil: new Date(NOW.getTime() + 30 * 86_400_000), anonymizedAt: over.anonymizedAt ?? null,
    },
  });
}

async function seedDue(inquiryId: string, over: Partial<MailMessage> = {}) {
  const conn = requireDb();
  return conn.mailMessage.create({
    data: {
      direction: 'OUTBOUND', status: 'QUEUED', inquiryId,
      fromAddr: 'no-reply@example.test', toAddr: 'buyer@example.test', subject: 's', bodyHtml: 'h', bodyText: 'b',
      errorCode: 'daily_cap_deferred', retryable: false, deferredUntil: new Date(NOW.getTime() - 3_600_000),
      createdAt: new Date(NOW.getTime() - 7_200_000), capDay: null, lockedUntil: null,
      ...over,
    },
  });
}

async function row(id: string): Promise<MailRow> {
  return requireDb().mailMessage.findUniqueOrThrow({ where: { id } }) as unknown as MailRow;
}

function budgetIn(ms: number, controller = new AbortController()): { budget: JobBudget; controller: AbortController } {
  return { budget: { deadlineAt: new Date(Date.now() + ms), signal: controller.signal }, controller };
}

function closeIn(ms = 2_000): MailCloseWindow {
  return { used: false, deadlineAt: new Date(Date.now() + ms) };
}

function jobContext(ms = 30_000) {
  return { now: new Date(NOW), deadlineAt: new Date(Date.now() + ms), signal: new AbortController().signal };
}

before(async () => {
  if (!db) return;
  const conn = requireDb();
  await conn.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url! }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await reset();
}, { timeout: 180_000 });

beforeEach(async () => {
  setRateLimitStore(new MemoryStore());
  await reset();
});

after(async () => {
  if (!db) return;
  await reset();
  await db.$disconnect();
});

describe('M4-T12 mail queue（真实 PG）', { concurrency: false, skip, timeout: 180_000 }, () => {
  test('1. reserve 返回本次 attempts；第二次同 attempt 领取 busy 且令牌不变', async () => {
    const inq = await seedInquiry();
    const mail = await seedDue(inq.id);
    const first = await reserveAndStart(requireDb(), mail.id, ['QUEUED'], { now: new Date(NOW), env: ENV });
    assert.equal(first.kind, 'started');
    if (first.kind !== 'started') return;
    assert.ok(Number.isInteger(first.attempts) && first.attempts > 0);
    assert.equal((await row(mail.id)).attempts, first.attempts);
    const second = await reserveAndStart(requireDb(), mail.id, ['QUEUED'], { now: new Date(NOW), env: ENV });
    assert.equal(second.kind, 'busy');
    assert.equal((await row(mail.id)).attempts, first.attempts, 'busy 不产生新 attempt');
  });

  test('2. 剩余预算 ≤1s 不再领取：零计数、无 SMTP、行保持 QUEUED', async () => {
    const inq = await seedInquiry();
    const mail = await seedDue(inq.id);
    const adapter = fakeAdapter(OK);
    const { budget } = budgetIn(900);
    const out = await processMailQueue({ db: requireDb(), adapter: adapter.api, env: ENV, now: () => new Date(NOW) }, { limit: 10, budget });
    assert.deepEqual(JobCountsSchema.parse(out), { stale: 0, sent: 0, failed: 0, deferred: 0, dropped: 0 });
    assert.equal(adapter.sent.length, 0);
    const after = await row(mail.id);
    assert.equal(after.status, 'QUEUED');
    assert.equal(after.attempts, 0);
  });

  test('3. advisory 锁被占满预算：reserve 被 lock_timeout 截断，无写入、零计数', async () => {
    const inq = await seedInquiry();
    const mail = await seedDue(inq.id);
    const adapter = fakeAdapter(OK);
    const holder = requireDb().$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(740017)::text AS ok');
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }, { maxWait: 5_000, timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const { budget } = budgetIn(2_000);
    const out = await processMailQueue({ db: requireDb(), adapter: adapter.api, env: ENV, now: () => new Date(NOW) }, { limit: 10, budget });
    assert.equal(out.sent, 0);
    assert.equal(adapter.sent.length, 0);
    assert.equal((await row(mail.id)).attempts, 0, '锁等待超时不得占用 attempt');
    await holder.catch(() => {});
  });

  test('4. 截止落在 reserve 后、SMTP 前：D 回退一次，QUEUED 且 attempts/deferredUntil 保留', async () => {
    const inq = await seedInquiry();
    const mail = await seedDue(inq.id);
    const adapter = fakeAdapter(OK);
    const controller = new AbortController();
    // 第 3 个事务是 reserve；它提交后模拟预算耗尽，触发 D 回退（第 4 个收尾事务）。
    let txs = 0;
    const proxy = new Proxy(requireDb(), {
      get(target, prop) {
        if (prop === '$transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
            const value = await target.$transaction(fn as never, options as never);
            txs += 1;
            if (txs === 4) controller.abort();
            return value;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as PrismaClient;
    const before = await row(mail.id);
    const out = await processMailQueue({ db: proxy, adapter: adapter.api, env: ENV, now: () => new Date(NOW) }, {
      limit: 10, budget: { deadlineAt: new Date(Date.now() + 60_000), signal: controller.signal }, close: closeIn(3_000),
    });
    assert.equal(out.deferred, 1);
    assert.equal(adapter.sent.length, 0, 'D 回退后不得再进 SMTP');
    const after = await row(mail.id);
    assert.equal(after.status, 'QUEUED');
    assert.equal(after.errorCode, 'daily_cap_deferred');
    assert.equal(after.attempts, before.attempts + 1, 'attempt 保留');
    assert.equal(after.retryCount, before.retryCount);
    assert.equal(after.capDay, null);
    assert.equal(after.lockedUntil, null);
    assert.equal(after.deferredUntil?.toISOString(), before.deferredUntil?.toISOString());
  });

  test('5. SMTP 期间被匿名化：终态 0 行不写 SENT、不延长保留期、不计数', async () => {
    const inq = await seedInquiry();
    const mail = await seedDue(inq.id);
    const retainBefore = (await requireDb().inquiry.findUniqueOrThrow({ where: { id: inq.id } })).retainUntil.toISOString();
    const adapter = fakeAdapter(async () => {
      await requireDb().mailMessage.update({
        where: { id: mail.id },
        data: { redactedAt: new Date(), toAddr: '[deleted]', subject: '[deleted]', bodyHtml: '', bodyText: '' },
      });
      return OK;
    });
    const out = await processMailQueue({ db: requireDb(), adapter: adapter.api, env: ENV, now: () => new Date(NOW) }, { limit: 10 });
    assert.equal(out.sent, 0);
    assert.equal(out.failed, 0);
    const after = await row(mail.id);
    assert.notEqual(after.status, 'SENT');
    assert.ok(after.redactedAt);
    const retainAfter = (await requireDb().inquiry.findUniqueOrThrow({ where: { id: inq.id } })).retainUntil.toISOString();
    assert.equal(retainAfter, retainBefore, '0 行不得延长保留期');
  });

  test('6. 失败终态 0 行：不计数、不发配置告警', async () => {
    const inq = await seedInquiry();
    const mail = await seedDue(inq.id);
    const alerts: unknown[] = [];
    const adapter = fakeAdapter(async () => {
      await requireDb().mailMessage.update({ where: { id: mail.id }, data: { redactedAt: new Date() } });
      return { ok: false, reason: 'send_auth', retryable: false, code: '535', alert: true };
    });
    const out = await processMailQueue({
      db: requireDb(), adapter: adapter.api, env: ENV, now: () => new Date(NOW),
      alert: async (...args: unknown[]) => { alerts.push(args); return 'sent'; },
    }, { limit: 10 });
    assert.equal(out.failed, 0);
    assert.equal(alerts.length, 0, '0 行失败不发配置告警');
  });

  test('7. stale 后晚到成功：同 attempt 升级 SENT 一次并审计 reconciled', async () => {
    const inq = await seedInquiry();
    const created = await requireDb().mailMessage.create({
      data: {
        direction: 'OUTBOUND', status: 'FAILED', errorCode: 'unknown_delivery', retryable: false, attempts: 1,
        inquiryId: inq.id, fromAddr: 'no-reply@example.test', toAddr: 'buyer@example.test',
        subject: 's', bodyHtml: 'h', bodyText: 'b', lockedUntil: null, createdAt: new Date(NOW.getTime() - 3_600_000),
      },
    });
    const audits: { action: string }[] = [];
    const adapter = fakeAdapter(OK);
    const result = await deliver(
      { db: requireDb(), adapter: adapter.api, now: () => new Date(NOW), auditInTx: async (_tx, e) => { audits.push(e); } },
      await row(created.id), cfg, inq.replyToken, () => new Date(NOW), { attempts: 1 },
    );
    assert.equal(result.counted, 'sent');
    assert.equal((await row(created.id)).status, 'SENT');
    assert.deepEqual(audits.map((a) => a.action), ['mail.delivery_reconciled']);
  });

  test('8. attempt 缺失 fail closed：不调用 SMTP、不写终态', async () => {
    const inq = await seedInquiry();
    const created = await seedDue(inq.id, { status: 'SENDING', attempts: 1, lockedUntil: new Date(NOW.getTime() + 60_000) });
    const adapter = fakeAdapter(OK);
    const current = await row(created.id);
    await assert.rejects(
      () => deliver({ db: requireDb(), adapter: adapter.api, now: () => new Date(NOW) }, current, cfg, inq.replyToken, () => new Date(NOW), { attempts: 0 }),
      /mail_attempt_token_missing/,
    );
    assert.equal(adapter.sent.length, 0);
    assert.equal((await row(created.id)).attempts, 1);
  });

  test('9. 收尾事务 COMMIT 未知：不重放、不计数、closeUsed 只进一次', async () => {
    const inq = await seedInquiry();
    const created = await seedDue(inq.id, { status: 'SENDING', attempts: 1, lockedUntil: new Date(NOW.getTime() + 60_000) });
    const adapter = fakeAdapter(OK);
    let closeTx = 0;
    const stale = new Proxy(requireDb(), {
      get(target, prop) {
        if (prop === '$transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
            closeTx += 1;
            await target.$transaction(fn as never, options as never);
            throw Object.assign(new Error('commit outcome unknown'), { code: 'P2028' });
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as PrismaClient;
    const close = closeIn(2_000);
    const result = await deliver(
      { db: stale, adapter: adapter.api, now: () => new Date(NOW) },
      await row(created.id), cfg, inq.replyToken, () => new Date(NOW),
      { attempts: 1, budget: { deadlineAt: new Date(Date.now() + 500), signal: new AbortController().signal }, close },
    );
    assert.equal(result.counted, null);
    assert.equal(closeTx, 1, '提交未知不得重放');
    assert.equal(close.used, true);
  });

  test('10. 两个并发 run：同一 JobState 租约只一个执行，另一个 busy', async () => {
    const inq = await seedInquiry();
    await seedDue(inq.id);
    const adapter = fakeAdapter(OK);
    const mk = () => createMailQueueJob({ db: requireDb(), clock: () => new Date(NOW), getAdapter: async () => adapter.api, env: ENV, limit: 10 });
    const [a, b] = await Promise.all([mk().run(jobContext()), mk().run(jobContext())]);
    const kinds = [a.kind, b.kind].sort();
    assert.deepEqual(kinds, ['busy', 'ran']);
    const state = await requireDb().jobState.findUniqueOrThrow({ where: { key: MAIL_QUEUE_KEY } });
    assert.equal(state.lastStatus, 'SUCCEEDED');
    assert.equal(state.leaseOwner, null);
  });

  test('11. adapter 为 null：零计数、JobState SUCCEEDED、不调用 SMTP', async () => {
    const inq = await seedInquiry();
    await seedDue(inq.id);
    const job = createMailQueueJob({ db: requireDb(), clock: () => new Date(NOW), getAdapter: async () => null, env: ENV });
    const outcome = await job.run(jobContext());
    assert.equal(outcome.kind, 'ran');
    if (outcome.kind !== 'ran') return;
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.deepEqual(outcome.counts, { stale: 0, sent: 0, failed: 0, deferred: 0, dropped: 0 });
  });

  test('12. 告警映射：未配 SMTP→skipped、非法配置→failed、deadline 过→不调 transport', async () => {
    const previous = { ...process.env };
    const calls: unknown[] = [];
    setMailTransportFactory(((opts: unknown) => {
      calls.push(opts);
      return { sendMail: async () => ({ messageId: '<x@example.test>' }) };
    }) as never);
    try {
      process.env.ADMIN_ALERT_EMAIL = 'ops@example.test';
      for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[key];
      assert.equal(await sendAdminAlert('测试告警', { a: 1 }, 't-missing'), 'skipped');
      assert.equal(calls.length, 0);

      Object.assign(process.env, ENV);
      process.env.MAIL_FROM = 'not-an-email';
      assert.equal(await sendAdminAlert('测试告警', { a: 1 }, 't-invalid'), 'failed');
      assert.equal(calls.length, 0);

      Object.assign(process.env, ENV);
      assert.equal(await sendAdminAlert('测试告警', { a: 1 }, 't-deadline', { deadlineAt: new Date(Date.now() - 1) }), 'skipped');
      assert.equal(calls.length, 0, 'deadline 已过不得启动 transport');
    } finally {
      setMailTransportFactory(undefined);
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  test('13. cron 文件：每分钟 POST 旧入口、55s、409 不重试', () => {
    const text = readFileSync('deploy/cron.nbshiyan', 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.includes('/api/admin/cron/mail-queue'));
    assert.ok(line, '必须注册 mail-queue cron 行');
    assert.match(line!, /^\* \* \* \* \*/);
    assert.match(line!, /method:'POST'/);
    assert.match(line!, /AbortSignal\.timeout\(55000\)/);
    assert.match(line!, /r\.status===409\?0:1/);
    assert.ok(!/method:'GET'/.test(line!));
  });

  test('14. 直发不受队列预算影响：SENT、不产生 JobState', async () => {
    const inq = await seedInquiry();
    const adapter = fakeAdapter(OK);
    const response = await sendInquiryMail(
      { db: requireDb(), adapter: adapter.api, env: ENV, now: () => new Date(NOW) },
      { userId: 'admin-a', inquiryId: inq.id, scope: {}, subject: 'hi', body: 'body' },
    );
    assert.equal(response.status, 201);
    assert.equal(adapter.sent.length, 1);
    assert.equal(await requireDb().jobState.count(), 0);
  });

  test('15. executeJobRequest 未知 jobKey 由上层拒绝；mail-queue 允许且五键平铺', async () => {
    const adapter = fakeAdapter(OK);
    const services = createMailQueueJob({ db: requireDb(), clock: () => new Date(NOW), getAdapter: async () => adapter.api, env: ENV });
    const registry = { has: (k: string) => k === 'mail-queue', keys: () => ['mail-queue' as const], run: (_k: string, context: never) => services.run(context) };
    const handler = createOperationsHandler({ services: registry as never, clock: () => new Date(NOW), secret: 'c'.repeat(40) });
    const res = await handler(new Request('http://127.0.0.1:3000/api/admin/cron/operations', {
      method: 'POST', headers: { authorization: `Bearer ${'c'.repeat(40)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobKey: 'mail-queue' }),
    }));
    assert.equal(res.status, 200);
    const body = await res.json() as { jobKey: string; status: string; counts: Record<string, number> };
    assert.equal(body.jobKey, 'mail-queue');
    assert.equal(body.status, 'SUCCEEDED');
    assert.deepEqual(Object.keys(body.counts).sort(), ['deferred', 'dropped', 'failed', 'sent', 'stale']);
    assert.deepEqual(Object.values(body.counts), [0, 0, 0, 0, 0]);
  });
});
