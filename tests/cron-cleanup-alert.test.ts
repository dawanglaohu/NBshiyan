import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCleanupSteps } from '../src/lib/server/retention';
import { alertCleanupIssues } from '../src/lib/server/cron-alert';
import { errorSummary } from '../src/lib/server/mail';

type Call = { kind: string; lines: Record<string, string | number>; key: string };
const now = new Date('2026-10-14T03:00:00Z');

/** 和 route.ts 一样的流程：跑步骤、收集错误码、汇总告警 */
async function run(steps: [string, () => Promise<number>][], send: (k: string, l: Record<string, string | number>, d: string) => Promise<void>, clock = () => 0) {
  const errors: Record<string, string> = {};
  const audits: unknown[] = [];
  const s = await runCleanupSteps(steps.map(([n, f]) => [n, () => f()]), 100, async (name, e) => {
    const sum = errorSummary(e);
    errors[name] = `${sum['错误类型']}:${sum['错误码']}`;
  }, clock);
  const sent = await alertCleanupIssues(s, errors, send, async (e) => { audits.push(e); }, now);
  return { s, sent, audits };
}

test('all steps ok -> no alert, no audit', async () => {
  const calls: Call[] = [];
  const r = await run([['designs', async () => 1], ['inquiries', async () => 2]], async (kind, lines, key) => { calls.push({ kind, lines, key }); });
  assert.equal(r.sent, false);
  assert.equal(calls.length, 0);
  assert.equal(r.audits.length, 0);
  assert.deepEqual(r.s.result, { designs: 1, inquiries: 2 });
});

test('one step throws -> one alert with only step name + error code, daily dedupe key', async () => {
  const calls: Call[] = [];
  const err = Object.assign(new Error('connect postgres://u:secret@db/x failed for alice@example.com id=ck123'), { name: 'PrismaClientKnownRequestError', code: 'P1001', stack: 'at /secret/path.ts:1' });
  const r = await run([
    ['designs', async () => 1],
    ['inquiries', async () => { throw err; }],
    ['auditLogs', async () => 3],
  ], async (kind, lines, key) => { calls.push({ kind, lines, key }); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'cron-cleanup:2026-10-14');
  assert.deepEqual(calls[0].lines, { 任务: 'cleanup-uploads', 失败步骤数: 1, 跳过步骤数: 0, 失败步骤: 'inquiries=PrismaClientKnownRequestError:P1001' });
  const text = JSON.stringify(calls) + JSON.stringify(r.audits);
  for (const bad of ['secret', 'alice', '@example', 'ck123', 'postgres', 'path.ts', 'connect']) assert.ok(!text.includes(bad), bad);
  assert.deepEqual(r.audits, [{ action: 'cron.cleanup.alert', meta: { failed: ['inquiries'], skipped: [], codes: ['inquiries=PrismaClientKnownRequestError:P1001'] } }]);
  assert.deepEqual(r.s.result, { designs: 1, auditLogs: 3 });
});

test('steps skipped by deadline -> alert lists skipped names', async () => {
  const calls: Call[] = [];
  let t = 0;
  await run([['designs', async () => { t = 200; return 1; }], ['inquiries', async () => 2]], async (kind, lines, key) => { calls.push({ kind, lines, key }); }, () => t);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lines['因截止时间跳过'], 'inquiries');
  assert.equal(calls[0].lines['跳过步骤数'], 1);
});

test('alert send failing does not throw; run summary unchanged', async () => {
  const r = await run([['designs', async () => { throw new TypeError('x'); }], ['inquiries', async () => 2]], async () => { throw new Error('resend down'); });
  assert.equal(r.sent, true);
  assert.deepEqual(r.s.failed, ['designs']);
  assert.deepEqual(r.s.result, { inquiries: 2 });
  // audit failing too is swallowed
  await assert.doesNotReject(alertCleanupIssues({ failed: ['a'], skipped: [], deadlineReached: false }, {}, async () => { throw new Error('x'); }, async () => { throw new Error('y'); }, now));
});
