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
import { createOperationsHandler, executeJobRequest } from '../src/lib/server/jobs/registry';
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
import { createMailDb } from './fixtures/mail-db';

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

// B1 分类回归：无库假 db，经 deliver/processMailQueue 公开入口；不连 PG、不发 SMTP。
// 只断言 close_* 事件与 stage，不把未知写成已回滚。
describe('B1 close classification（无库假 db）', { concurrency: false }, () => {
  type CloseError = { code: string; meta?: { code?: string } };

  function b1Row(over: Partial<MailRow> = {}): MailRow {
    return {
      id: 'b1-mail-1', inquiryId: 'inq-b1', messageId: '<b1@example.test>', sendKey: 'b1-key',
      inReplyTo: null, references: null, toAddr: 'buyer@example.test', subject: 's', bodyHtml: 'h', bodyText: 'b',
      errorCode: null, retryable: false, retryCount: 0, deliveryStatus: 'UNKNOWN', sentAt: null,
      deferredUntil: new Date(NOW.getTime() + 86_400_000), createdAt: new Date(NOW.getTime() - 3_600_000),
      lockedUntil: new Date(NOW.getTime() + 60_000), capDay: null, attempts: 1, redactedAt: null,
      status: 'SENDING',
      ...over,
    } as MailRow;
  }

  async function withMailLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
    const logs: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    const origInfo = console.info;
    const push = (...args: unknown[]) => { logs.push(args.map((a) => String(a)).join(' ')); };
    console.error = push as typeof console.error;
    console.warn = push as typeof console.warn;
    console.info = push as typeof console.info;
    try {
      return { value: await fn(), logs };
    } finally {
      console.error = origError;
      console.warn = origWarn;
      console.info = origInfo;
    }
  }

  const closeLogs = (logs: string[]) => logs.filter((l) => l.includes('[mail] mail.close_'));
  function expectClose(logs: string[], event: string, stage: string) {
    // mailLog 的 SAFE_KEYS 不含 stage，日志只保留 event/mailId；callback/commit 由用例模式区分，不在此断言 stage。
    const line = closeLogs(logs).find((l) => l.includes(event));
    assert.ok(line, `expected ${event} (${stage}); got ${closeLogs(logs).join(' | ') || '(none)'}`);
  }

  function terminalDb(mode: 'success' | 'callback' | 'commit' | 'pre_tx', error?: CloseError, counter?: { tx: number }) {
    const tx = {
      $executeRawUnsafe: async () => 0,
      mailMessage: {
        updateMany: async () => {
          if (mode === 'callback') throw Object.assign(new Error('injected callback'), error);
          return { count: 1 };
        },
        findUnique: async () => null,
      },
    };
    return {
      mailMessage: { findUnique: async () => null },
      inquiry: {},
      async $transaction(fn: (tx: unknown) => Promise<unknown>) {
        if (counter) counter.tx += 1;
        if (mode === 'pre_tx') throw Object.assign(new Error('injected pre-tx'), error);
        const value = await fn(tx);
        if (mode === 'commit') throw Object.assign(new Error('injected commit'), error);
        return value;
      },
    };
  }

  async function runTerminal(
    mode: 'success' | 'callback' | 'commit' | 'pre_tx',
    error?: CloseError,
    opts: { closeMs?: number; counter?: { tx: number } } = {},
  ) {
    const adapter = fakeAdapter(OK);
    const { budget } = budgetIn(400);
    const close = closeIn(opts.closeMs ?? 2_000);
    const { value, logs } = await withMailLogs(() => deliver(
      { db: terminalDb(mode, error, opts.counter) as never, adapter: adapter.api, now: () => new Date(NOW) },
      b1Row({ inquiryId: null }), cfg, 'tok0000000000001', () => new Date(NOW),
      { attempts: 1, budget, close },
    ));
    return { value, logs, close };
  }

  test('B1-1 terminal 回调 P2028 → unconfirmed/callback', async () => {
    const { value, logs } = await runTerminal('callback', { code: 'P2028' });
    assert.equal(value.counted, null);
    expectClose(logs, 'mail.close_unconfirmed', 'callback');
  });

  test('B1-2 terminal 回调 P1017 连接类 → unconfirmed/callback', async () => {
    const { value, logs } = await runTerminal('callback', { code: 'P1017' });
    assert.equal(value.counted, null);
    expectClose(logs, 'mail.close_unconfirmed', 'callback');
  });

  test('B1-3 terminal 回调未识别错误 → unconfirmed/callback', async () => {
    const { value, logs } = await runTerminal('callback', { code: 'E_UNEXPECTED' });
    assert.equal(value.counted, null);
    expectClose(logs, 'mail.close_unconfirmed', 'callback');
  });

  test('B1-4 terminal 回调 P2034 → rolled_back/callback', async () => {
    const { value, logs } = await runTerminal('callback', { code: 'P2034' });
    assert.equal(value.counted, null);
    expectClose(logs, 'mail.close_rolled_back', 'callback');
  });

  test('B1-5 terminal 回调 P2010+40001 → rolled_back/callback', async () => {
    const { value, logs } = await runTerminal('callback', { code: 'P2010', meta: { code: '40001' } });
    assert.equal(value.counted, null);
    expectClose(logs, 'mail.close_rolled_back', 'callback');
  });

  test('B1-6 terminal 提交阶段 P2028 → unconfirmed/commit', async () => {
    const { value, logs } = await runTerminal('commit', { code: 'P2028' });
    assert.equal(value.counted, null);
    expectClose(logs, 'mail.close_unconfirmed', 'commit');
  });

  test('B1-7 terminal 提交阶段 P2034 → rolled_back/commit', async () => {
    const { value, logs } = await runTerminal('commit', { code: 'P2034' });
    assert.equal(value.counted, null);
    expectClose(logs, 'mail.close_rolled_back', 'commit');
  });

  test('B1-8 terminal 本地校验失败（收尾窗不足）→ close_skipped、未调用 $transaction', async () => {
    const counter = { tx: 0 };
    const { value, logs } = await runTerminal('success', undefined, { closeMs: 10, counter });
    assert.equal(value.counted, null);
    assert.equal(counter.tx, 0, '本地校验失败不得调用 $transaction');
    assert.ok(closeLogs(logs).some((l) => l.includes('mail.close_skipped')));
    assert.ok(!closeLogs(logs).some((l) => l.includes('mail.close_unconfirmed') || l.includes('mail.close_rolled_back')));
  });

  test('B1-8b terminal $transaction 在回调前 reject 未知错误 → unconfirmed/callback（不降 skipped）', async () => {
    const counter = { tx: 0 };
    const { value, logs } = await runTerminal('pre_tx', { code: 'P1001' }, { counter });
    assert.equal(value.counted, null);
    assert.equal(counter.tx, 1, '$transaction 已调用');
    expectClose(logs, 'mail.close_unconfirmed', 'callback');
  });

  test('B1-9 terminal 成功 → counted sent、无 close_*', async () => {
    const { value, logs } = await runTerminal('success');
    assert.equal(value.counted, 'sent');
    assert.equal(closeLogs(logs).length, 0);
  });

  function queueDb(
    mode: 'success' | 'callback' | 'commit' | 'pre_tx',
    error: CloseError | undefined,
    controller: AbortController,
    stats?: { tx: number },
  ) {
    let calls = 0;
    const inquiry = {
      findFirst: async (args: { where?: Record<string, unknown> }) => {
        if (args.where && 'AND' in args.where) return { id: 'inq-b1', replyToken: 'tok0000000000001', anonymizedAt: null };
        if (args.where && 'replyToken' in args.where) return { id: 'inq-b1', ref: 'PJ-B1', locale: 'en' };
        if (args.where && 'id' in args.where) return { contact: { email: 'buyer@example.test' } };
        return null;
      },
    };
    const txFor = (n: number) => ({
      $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async () => [{ ok: '1' }],
      inquiry,
      mailMessage: {
        updateMany: async () => {
          if (n === 5 && mode === 'callback') throw Object.assign(new Error('injected callback'), error);
          return { count: n === 4 || n === 5 ? 1 : 0 };
        },
        findMany: async () => [b1Row()],
        count: async () => 0,
        findUnique: async () => ({ attempts: 1, lockedUntil: new Date(NOW.getTime() + 60_000) }),
      },
    });
    return {
      inquiry,
      mailMessage: { findUnique: async () => null },
      async $transaction(fn: (tx: unknown) => Promise<unknown>) {
        calls += 1;
        if (stats) stats.tx += 1;
        const n = calls;
        if (n === 5 && mode === 'pre_tx') throw Object.assign(new Error('injected pre-tx'), error);
        const value = await fn(txFor(n));
        if (n === 4) controller.abort();
        if (n === 5 && mode === 'commit') throw Object.assign(new Error('injected commit'), error);
        return value;
      },
    };
  }

  async function runQueue(
    mode: 'success' | 'callback' | 'commit' | 'pre_tx',
    error?: CloseError,
    opts: { closeMs?: number; stats?: { tx: number } } = {},
  ) {
    const adapter = fakeAdapter(OK);
    const controller = new AbortController();
    const { budget } = budgetIn(60_000, controller);
    const { value, logs } = await withMailLogs(() => processMailQueue(
      { db: queueDb(mode, error, controller, opts.stats) as never, adapter: adapter.api, env: ENV, now: () => new Date(NOW) },
      { limit: 10, budget, close: closeIn(opts.closeMs ?? 2_000) },
    ));
    return { value, logs };
  }

  test('B1-10 D回退成功 → deferred、无 close_*', async () => {
    const { value, logs } = await runQueue('success');
    assert.equal(value.deferred, 1);
    assert.equal(closeLogs(logs).length, 0);
  });

  test('B1-11 D回退回调 P2028 → unconfirmed/callback、不计数', async () => {
    const { value, logs } = await runQueue('callback', { code: 'P2028' });
    assert.equal(value.deferred, 0);
    expectClose(logs, 'mail.close_unconfirmed', 'callback');
  });

  test('B1-12 D回退回调 P1017 连接类 → unconfirmed/callback', async () => {
    const { value, logs } = await runQueue('callback', { code: 'P1017' });
    assert.equal(value.deferred, 0);
    expectClose(logs, 'mail.close_unconfirmed', 'callback');
  });

  test('B1-13 D回退回调未识别错误 → unconfirmed/callback', async () => {
    const { value, logs } = await runQueue('callback', { code: 'E_UNEXPECTED' });
    assert.equal(value.deferred, 0);
    expectClose(logs, 'mail.close_unconfirmed', 'callback');
  });

  test('B1-14 D回退回调 P2034 → rolled_back/callback', async () => {
    const { value, logs } = await runQueue('callback', { code: 'P2034' });
    assert.equal(value.deferred, 0);
    expectClose(logs, 'mail.close_rolled_back', 'callback');
  });

  test('B1-15 D回退回调 P2010+40001 → rolled_back/callback', async () => {
    const { value, logs } = await runQueue('callback', { code: 'P2010', meta: { code: '40001' } });
    assert.equal(value.deferred, 0);
    expectClose(logs, 'mail.close_rolled_back', 'callback');
  });

  test('B1-16 D回退提交阶段 P2028 → unconfirmed/commit', async () => {
    const { value, logs } = await runQueue('commit', { code: 'P2028' });
    assert.equal(value.deferred, 0);
    expectClose(logs, 'mail.close_unconfirmed', 'commit');
  });

  test('B1-17 D回退提交阶段 P2034 → rolled_back/commit', async () => {
    const { value, logs } = await runQueue('commit', { code: 'P2034' });
    assert.equal(value.deferred, 0);
    expectClose(logs, 'mail.close_rolled_back', 'commit');
  });

  test('B1-18 D回退 $transaction 在回调前 reject 未知错误 → unconfirmed/callback、不计数', async () => {
    const stats = { tx: 0 };
    const { value, logs } = await runQueue('pre_tx', { code: 'P1001' }, { stats });
    assert.equal(value.deferred, 0);
    assert.equal(stats.tx, 5, '$transaction 已调用');
    expectClose(logs, 'mail.close_unconfirmed', 'callback');
  });

  test('B1-19 D回退本地校验失败（收尾窗不足）→ close_skipped、未开第 5 个事务', async () => {
    const stats = { tx: 0 };
    const { value, logs } = await runQueue('success', undefined, { closeMs: 10, stats });
    assert.equal(value.deferred, 0);
    assert.equal(stats.tx, 4, '本地校验失败不得开收尾事务');
    assert.ok(closeLogs(logs).some((l) => l.includes('mail.close_skipped')));
    assert.ok(!closeLogs(logs).some((l) => l.includes('mail.close_unconfirmed') || l.includes('mail.close_rolled_back')));
  });
});

// P2-A 错误传播：无库假 db；四阶段非预算错误必须上抛并停止后续调用，预算分支保持原样。
describe('P2 error propagation（无库假 db）', { concurrency: false }, () => {
  type P2Db = {
    mailMessage: {
      create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
      findMany: (args?: unknown) => Promise<unknown[]>;
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
    inquiry: { findFirst: (args: unknown) => Promise<unknown> };
    $transaction: (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
    $queryRaw: (...args: unknown[]) => Promise<unknown>;
  };

  function fixtureDb(inquiries: unknown[] = []) {
    const fixture = createMailDb({ inquiries: inquiries as never });
    const db = fixture.db as unknown as P2Db;
    let txCalls = 0;
    const origTx = db.$transaction.bind(db);
    db.$transaction = async (fn, opts) => { txCalls += 1; return origTx(fn, opts); };
    return { fixture, db, txCalls: () => txCalls };
  }

  async function seedDue(fixture: ReturnType<typeof createMailDb>, inquiryId: string | null, over: Record<string, unknown> = {}) {
    return fixture.db.mailMessage.create({
      data: {
        direction: 'OUTBOUND', status: 'QUEUED', inquiryId,
        fromAddr: 'no-reply@example.test', toAddr: 'buyer@example.test', subject: 's', bodyHtml: 'h', bodyText: 'b',
        errorCode: 'daily_cap_deferred', retryable: false,
        deferredUntil: new Date(NOW.getTime() - 3_600_000), createdAt: new Date(NOW.getTime() - 7_200_000),
        ...over,
      },
    });
  }

  async function queueOnce(db: P2Db, adapter = fakeAdapter(OK).api) {
    const { budget } = budgetIn(60_000);
    return processMailQueue(
      { db: db as never, adapter, env: ENV, now: () => new Date(NOW) },
      { limit: 10, budget, close: closeIn(2_000) },
    );
  }

  test('P2-1 stale 写错误 → 上抛并停止（只开 1 个事务）', async () => {
    const { db, txCalls } = fixtureDb();
    db.mailMessage.updateMany = async () => { throw Object.assign(new Error('injected stale'), { code: 'P1017' }); };
    await assert.rejects(queueOnce(db), /injected stale/);
    assert.equal(txCalls(), 1);
  });

  test('P2-2 due 读错误 → 上抛并停止（只开 2 个事务）', async () => {
    const { db, txCalls } = fixtureDb();
    db.mailMessage.findMany = async () => { throw Object.assign(new Error('injected due'), { code: 'P1017' }); };
    await assert.rejects(queueOnce(db), /injected due/);
    assert.equal(txCalls(), 2);
  });

  test('P2-3 收件人读错误 → 上抛并停止（只开 3 个事务）', async () => {
    const inq = { id: 'inq1', replyToken: 'tok0000000000001', anonymizedAt: null, ref: 'PJ', locale: 'en', contact: { email: 'buyer@example.test' } };
    const { fixture, db, txCalls } = fixtureDb([inq]);
    await seedDue(fixture, 'inq1');
    db.inquiry.findFirst = async () => { throw Object.assign(new Error('injected recipient'), { code: 'P1017' }); };
    await assert.rejects(queueOnce(db), /injected recipient/);
    assert.equal(txCalls(), 3);
  });

  test('P2-4 dropped 写错误 → 上抛并停止（只开 4 个事务）', async () => {
    const { fixture, db, txCalls } = fixtureDb();
    await seedDue(fixture, 'missing-inquiry');
    let updates = 0;
    db.mailMessage.updateMany = async () => {
      updates += 1;
      if (updates === 2) throw Object.assign(new Error('injected dropped'), { code: 'P1017' });
      return { count: 0 };
    };
    await assert.rejects(queueOnce(db), /injected dropped/);
    assert.equal(txCalls(), 4);
  });

  test('P2-5 预算分支不抛、零计数（未开事务）', async () => {
    const { db, txCalls } = fixtureDb();
    const controller = new AbortController();
    controller.abort();
    const { budget } = budgetIn(60_000, controller);
    const out = await processMailQueue(
      { db: db as never, adapter: fakeAdapter(OK).api, env: ENV, now: () => new Date(NOW) },
      { limit: 10, budget },
    );
    assert.deepEqual(out, { stale: 0, sent: 0, failed: 0, deferred: 0, dropped: 0 });
    assert.equal(txCalls(), 0);
  });

  test('P2-6 due 非预算错误 → createMailQueueJob→executeJobRequest failed→handler 500 job_failed', async () => {
    const { db } = fixtureDb();
    db.mailMessage.findMany = async () => { throw Object.assign(new Error('injected due'), { code: 'P1017' }); };
    const adapter = fakeAdapter(OK);
    const job = createMailQueueJob({ db: db as never, clock: () => new Date(), getAdapter: async () => adapter.api, env: ENV, limit: 10 });
    const services = {
      has: (k: string) => k === MAIL_QUEUE_KEY,
      keys: () => [MAIL_QUEUE_KEY],
      run: (_k: string, ctx: never) => job.run(ctx),
    };
    const outcome = await executeJobRequest({ services: services as never, clock: () => new Date(), deadlineMs: 5_000 }, MAIL_QUEUE_KEY);
    assert.equal(outcome.kind, 'failed');
    const handler = createOperationsHandler({ services: services as never, clock: () => new Date(), secret: 'c'.repeat(40) });
    const res = await handler(new Request('http://127.0.0.1:3000/api/admin/cron/operations', {
      method: 'POST',
      headers: { authorization: `Bearer ${'c'.repeat(40)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobKey: 'mail-queue' }),
    }));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'job_failed' });
  });

  test('P2-7 失败登记未确认 → 仍传播原错误→500，不重试', async () => {
    const { db } = fixtureDb();
    db.mailMessage.findMany = async () => { throw Object.assign(new Error('injected due'), { code: 'P1017' }); };
    let rawCalls = 0;
    const origRaw = db.$queryRaw.bind(db);
    db.$queryRaw = async (...args: unknown[]) => {
      rawCalls += 1;
      if (rawCalls > 2) throw Object.assign(new Error('fail registration unconfirmed'), { code: 'P1017' });
      return origRaw(...args);
    };
    const adapter = fakeAdapter(OK);
    const job = createMailQueueJob({ db: db as never, clock: () => new Date(), getAdapter: async () => adapter.api, env: ENV, limit: 10 });
    const services = {
      has: (k: string) => k === MAIL_QUEUE_KEY,
      keys: () => [MAIL_QUEUE_KEY],
      run: (_k: string, ctx: never) => job.run(ctx),
    };
    const handler = createOperationsHandler({ services: services as never, clock: () => new Date(), secret: 'c'.repeat(40) });
    const res = await handler(new Request('http://127.0.0.1:3000/api/admin/cron/operations', {
      method: 'POST',
      headers: { authorization: `Bearer ${'c'.repeat(40)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobKey: 'mail-queue' }),
    }));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'job_failed' });
    assert.ok(rawCalls >= 3, 'claim 后失败登记被尝试一次且未确认');
  });

  test('P2-8 早行已 SENT 保留：第二行收件人读失败不撤回/重发', async () => {
    const inq = { id: 'inq1', replyToken: 'tok0000000000001', anonymizedAt: null, ref: 'PJ', locale: 'en', contact: { email: 'buyer@example.test' } };
    const { fixture, db } = fixtureDb([inq]);
    const first = await seedDue(fixture, 'inq1');
    const second = await seedDue(fixture, 'inq1');
    const adapter = fakeAdapter(OK);
    let inqCalls = 0;
    const origFindFirst = db.inquiry.findFirst.bind(db.inquiry);
    db.inquiry.findFirst = async (args: unknown) => {
      inqCalls += 1;
      if (inqCalls === 4) throw Object.assign(new Error('injected recipient'), { code: 'P1017' });
      return origFindFirst(args as never);
    };
    await assert.rejects(queueOnce(db, adapter.api), /injected recipient/);
    const firstRow = fixture.mails.find((r) => r.id === first.id);
    const secondRow = fixture.mails.find((r) => r.id === second.id);
    assert.equal(firstRow?.status, 'SENT');
    assert.equal(adapter.sent.length, 1);
    assert.equal(secondRow?.status, 'QUEUED');
  });
});
