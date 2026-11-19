import { test } from 'node:test';
import { Socket } from 'node:net';
import assert from 'node:assert/strict';
import {
  notificationTestHooks, notificationBackoffMs, CHAT_NOTIFICATION_HOOK_KEYS,
  CHAT_NOTIFICATION_LEASE_MS, CHAT_SMTP_DEADLINE_MS, CHAT_NOTIFICATION_STOP_RESERVE_MS,
  notificationErrorCode, type NotificationOutcome,
} from '../src/lib/server/chat/notification-policy';
import { processChatNotifications, NotificationPreSendFailure } from '../src/lib/server/chat/notification-service';
import type { NotificationRepo, NotificationRow } from '../src/lib/server/chat/notification-repo';
import { classifyNotificationFailure, createNotificationMailer, notificationMailConfig, type NotificationMailer } from '../src/lib/server/chat/notification-mailer';

const NOW = new Date('2026-11-19T12:00:00.123Z');
function row(attempts = 1): NotificationRow {
  return { id: 'notification-1', conversationId: 'conversation-1', messageId: 'message-1',
    stableMessageId: 'stable@example.test', status: 'SENDING', attempts, availableAt: NOW,
    leaseVersion: 1, leaseOwner: 'worker-a', lockedUntil: new Date(NOW.getTime() + CHAT_NOTIFICATION_LEASE_MS),
    requestStartedAt: NOW, lastErrorCode: null, providerMessageId: null, sentAt: null, createdAt: NOW, updatedAt: NOW };
}
function fixture(attempts = 1) {
  const outcomes: NotificationOutcome[] = [];
  const calls: string[] = [];
  let claimed = false;
  let sends = 0;
  const repo: NotificationRepo = {
    async recoverExpiredLease() { calls.push('sweep'); return 0; },
    async promoteUnknown() { calls.push('promote'); return 0; },
    async disableNeverStartedQueued() { calls.push('disable'); return 1; },
    async claimDue() { calls.push('claim'); if (claimed) return null; claimed = true; return row(attempts - 1); },
    async startAttempt() { calls.push('start'); return row(attempts); },
    async loadContent() { calls.push('load'); return { conversationId: 'conversation-1', locale: 'en', receivedAt: NOW }; },
    async finish(_token, outcome) { calls.push('finish'); outcomes.push(outcome); return true; },
  };
  const mailer: NotificationMailer = { async send(mail) { calls.push('send'); sends++; assert.equal(mail.stableMessageId, 'stable@example.test'); return { kind: 'sent' }; } };
  const context = { now: NOW, budget: { deadlineAt: new Date(Date.now() + 54_750), signal: new AbortController().signal } };
  return { repo, mailer, context, outcomes, calls, get sends() { return sends; } };
}

test('通知策略：40s租约覆盖20s+写回，35s停止阈值与生产退避固定', () => {
  assert.ok(CHAT_NOTIFICATION_LEASE_MS > CHAT_SMTP_DEADLINE_MS + 5000);
  assert.equal(CHAT_NOTIFICATION_STOP_RESERVE_MS, 35000);
  assert.deepEqual([1, 2, 3].map((n) => notificationBackoffMs(n, {})), [60000, 300000, 1800000]);
  assert.throws(() => notificationBackoffMs(4, {}));
});

test('G10：只有test/build1/严格合法值同时满足才启用，其他组合关闭', () => {
  const old = process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD;
  try {
    process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD = '1';
    const keys = CHAT_NOTIFICATION_HOOK_KEYS;
    for (const APP_ENV of [undefined, '', 'staging', 'Production', ' test', 'test ', 'production']) {
      assert.deepEqual(notificationTestHooks({ APP_ENV, [keys[0]]: '1', [keys[1]]: '0.1' }), { pauseAfterAccept: false, backoffScale: 1 });
    }
    assert.deepEqual(notificationTestHooks({ APP_ENV: 'test', [keys[0]]: '1', [keys[1]]: '0.25' }), { pauseAfterAccept: true, backoffScale: 0.25 });
    for (const bad of ['0x1', '1e0', '+1', ' 1', '1 ', '.5', '0', 'NaN', 'Infinity', '00.5']) {
      assert.deepEqual(notificationTestHooks({ APP_ENV: 'test', [keys[0]]: '1', [keys[1]]: bad }), { pauseAfterAccept: false, backoffScale: 1 });
    }
    for (const bad of ['', 'true', ' 1', '1 ', '0']) assert.equal(notificationTestHooks({ APP_ENV: 'test', [keys[0]]: bad }).pauseAfterAccept, false);
    process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD = '';
    assert.deepEqual(notificationTestHooks({ APP_ENV: 'test', [keys[0]]: '1' }), { pauseAfterAccept: false, backoffScale: 1 });
  } finally {
    if (old === undefined) delete process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD;
    else process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD = old;
  }
});

test('PM-P2：DATA后或阶段未知ECONNRESET不能变成第四次确知失败', () => {
  assert.deepEqual(classifyNotificationFailure({ code: 'ECONNRESET', command: 'DATA' }, false), { kind: 'unknown', code: 'CHAT_SMTP_UNKNOWN' });
  assert.deepEqual(classifyNotificationFailure({ code: 'ECONNRESET' }, false), { kind: 'unknown', code: 'CHAT_SMTP_UNKNOWN' });
  assert.deepEqual(classifyNotificationFailure({ code: 'ECONNREFUSED' }, true), { kind: 'retry', code: 'CHAT_SMTP_UNAVAILABLE' });
  assert.deepEqual(classifyNotificationFailure({ responseCode: 451, command: 'RCPT' }, false), { kind: 'retry', code: 'CHAT_SMTP_TEMPORARY' });
  assert.deepEqual(classifyNotificationFailure({ code: 'ESOCKET', command: 'CONN', originalCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, false), { kind: 'failed', code: 'CHAT_SMTP_TLS' });
  assert.deepEqual(classifyNotificationFailure({ code: 'ETLS', command: 'STARTTLS' }, false), { kind: 'failed', code: 'CHAT_SMTP_TLS' });
  assert.deepEqual(classifyNotificationFailure({ code: 'ESOCKET', originalCode: 'ECONNRESET', message: 'CERT_HAS_EXPIRED' }, false), { kind: 'unknown', code: 'CHAT_SMTP_UNKNOWN' });
});

test('脱敏：未列入安全码的响应、地址和原始错误只得到固定fallback', () => {
  assert.equal(notificationErrorCode('451 mailbox@example.test private-body'), 'CHAT_WORKER_UNKNOWN');
  assert.equal(notificationErrorCode(new Error('private')), 'CHAT_WORKER_UNKNOWN');
});

test('真实编排：pre-send后才读内容，发送成功后写回；稳定ID原样传递', async () => {
  const f = fixture();
  const counts = await processChatNotifications({ repo: f.repo, getMailer: async () => f.mailer, owner: 'worker-a' }, f.context);
  assert.equal(counts.sent, 1);
  assert.equal(f.sends, 1);
  assert.deepEqual(f.calls.slice(0, 7), ['sweep', 'promote', 'claim', 'start', 'load', 'send', 'finish']);
});

test('发送前CAS为0行时不读内容、不调用SMTP、不写终态', async () => {
  const f = fixture(); f.repo.startAttempt = async () => null;
  await processChatNotifications({ repo: f.repo, getMailer: async () => f.mailer, owner: 'worker-a', limit: 1 }, f.context);
  assert.equal(f.sends, 0); assert.equal(f.calls.includes('load'), false); assert.equal(f.outcomes.length, 0);
});

test('缺配置先sweep再仅禁用从未尝试行，不提升UNKNOWN或发送', async () => {
  const f = fixture();
  const counts = await processChatNotifications({ repo: f.repo, getMailer: async () => null, owner: 'worker-a' }, f.context);
  assert.deepEqual(f.calls, ['sweep', 'disable']); assert.equal(counts.dropped, 1); assert.equal(f.sends, 0);
});

test('F09：内容不可用N03永久失败；读取故障UNKNOWN，均不调用SMTP', async () => {
  const f = fixture(); f.repo.loadContent = async () => null;
  await processChatNotifications({ repo: f.repo, getMailer: async () => f.mailer, owner: 'worker-a' }, f.context);
  assert.deepEqual(f.outcomes, [{ kind: 'failed', code: 'CHAT_LOCAL_INVALID' }]); assert.equal(f.sends, 0);
  const g = fixture(); g.repo.loadContent = async () => { throw new Error('database-body-token-probe'); };
  const logs: unknown[] = [];
  await processChatNotifications({ repo: g.repo, getMailer: async () => g.mailer, owner: 'worker-a', log: (x) => logs.push(x) }, g.context);
  assert.deepEqual(g.outcomes, [{ kind: 'unknown', code: 'CHAT_WORKER_UNKNOWN' }]); assert.equal(g.sends, 0);
  assert.ok(!JSON.stringify(logs).includes('database-body-token-probe'));
});

test('G08：具名未调用故障与未知异常分开，第4次计数已耗但SMTP不调用', async () => {
  const f = fixture(4);
  const counts = await processChatNotifications({ repo: f.repo, getMailer: async () => f.mailer, owner: 'worker-a', beforeSend: async () => { throw new NotificationPreSendFailure(); } }, f.context);
  assert.equal(f.sends, 0); assert.equal(counts.failed, 1); assert.equal(f.outcomes[0].kind, 'retry');
  const g = fixture();
  await processChatNotifications({ repo: g.repo, getMailer: async () => g.mailer, owner: 'worker-a', beforeSend: async () => { throw new Error('unclassified'); } }, g.context);
  assert.equal(g.outcomes[0].kind, 'unknown');
});

test('剩余预算34999ms停止，35000ms允许领取一行', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const remaining of [34_999, 35_000]) {
    const f = fixture(); f.context.budget.deadlineAt = new Date(now + remaining);
    await processChatNotifications({ repo: f.repo, getMailer: async () => f.mailer, owner: 'worker-a', limit: 1 }, f.context);
    assert.equal(f.calls.includes('claim'), remaining === 35_000);
    assert.equal(f.sends, remaining === 35_000 ? 1 : 0);
  }
});

test('单行串行：首封仍在SMTP时不预领下一行', async () => {
  const f = fixture();
  let release!: () => void; let entered!: () => void;
  const barrier = new Promise<void>((r) => { release = r; });
  const ready = new Promise<void>((r) => { entered = r; });
  f.mailer.send = async () => { entered(); await barrier; return { kind: 'sent' }; };
  const pending = processChatNotifications({ repo: f.repo, getMailer: async () => f.mailer, owner: 'worker-a' }, f.context);
  await ready;
  assert.equal(f.calls.filter((x) => x === 'claim').length, 1);
  release(); await pending;
});

test('chat配置独立于旧mail UI开关，缺少专属收件目标保持不可用', () => {
  const env = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_USER: 'unit', SMTP_PASS: 'unit', MAIL_FROM: 'sender@example.test', NEXT_PUBLIC_SITE_URL: 'https://example.test', CHAT_NOTIFICATION_TO: 'ops@example.test', NEXT_PUBLIC_ADMIN_MAIL: 'off' };
  assert.ok(notificationMailConfig(env));
  assert.equal(notificationMailConfig({ ...env, CHAT_NOTIFICATION_TO: undefined }), null);
  assert.equal(notificationMailConfig({ ...env, SMTP_PORT: '25' }), null);
  const host = { ...env, APP_ENV: 'test', SMTP_HOST: 'smtp.evidence.test' };
  const prev = process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD;
  try {
    process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD = '';
    assert.equal(notificationMailConfig(host), null);
    process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD = '1';
    assert.ok(notificationMailConfig(host));
    assert.equal(notificationMailConfig({ ...host, APP_ENV: 'production' }), null);
  } finally {
    if (prev === undefined) delete process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD;
    else process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD = prev;
  }
});

test('SMTP截止：已有连接在20s封成UNKNOWN并销毁，迟到回调不更改结果', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cfg = notificationMailConfig({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_USER: 'unit', SMTP_PASS: 'unit', MAIL_FROM: 'sender@example.test', NEXT_PUBLIC_SITE_URL: 'https://example.test', CHAT_NOTIFICATION_TO: 'ops@example.test' });
  assert.ok(cfg);
  const socket = new Socket();
  let current = 0, closed = 0;
  let after!: () => void;
  const lateReply = new Promise<void>((resolve) => { after = resolve; });
  const mailer = createNotificationMailer(cfg, { monotonic: () => current, connect: () => socket, createTransport: (options) => ({
    async sendMail(mail) {
      assert.equal(mail.messageId, 'stable@example.test');
      assert.match(String(mail.text), /https:\/\/example\.test\/admin\/chat\/conversation-1/);
      await new Promise<void>((resolve, reject) => options.getSocket({}, (err) => err ? reject(err) : resolve()));
      return lateReply;
    },
    close() { closed++; },
  }) });
  const result = mailer.send({ stableMessageId: 'stable@example.test', conversationId: 'conversation-1', locale: 'en', receivedAt: NOW }, new AbortController().signal);
  socket.emit('connect');
  current = CHAT_SMTP_DEADLINE_MS;
  t.mock.timers.tick(CHAT_SMTP_DEADLINE_MS);
  assert.deepEqual(await result, { kind: 'unknown', code: 'CHAT_SMTP_DEADLINE' });
  assert.equal(socket.destroyed, true);
  after(); await Promise.resolve();
  assert.equal(closed, 1);
});

test('SMTP截止：完成回调先于计时器时仍按19999ms/20000ms区分', async () => {
  const cfg = notificationMailConfig({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'unit', SMTP_PASS: 'unit', MAIL_FROM: 'sender@example.test', NEXT_PUBLIC_SITE_URL: 'https://example.test', CHAT_NOTIFICATION_TO: 'ops@example.test' });
  assert.ok(cfg);
  for (const elapsed of [19_999, 20_000]) {
    let now = 0;
    const mailer = createNotificationMailer(cfg, { monotonic: () => now, createTransport: () => ({ async sendMail() { now = elapsed; } }) });
    const result = await mailer.send({ stableMessageId: 'stable@example.test', conversationId: 'conversation-1', locale: 'en', receivedAt: NOW }, new AbortController().signal);
    assert.deepEqual(result, elapsed < CHAT_SMTP_DEADLINE_MS ? { kind: 'sent' } : { kind: 'unknown', code: 'CHAT_SMTP_DEADLINE' });
  }
});
