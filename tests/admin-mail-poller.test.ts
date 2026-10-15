import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSendPoll, type PollEvent } from '../src/lib/admin/mail/poller';
import type { SendStatus } from '../src/lib/admin/mail/types';
import { MailError } from '../src/lib/admin/mail/types';

/** 手动时钟：run() 按时间顺序执行到期的定时器 */
function clock() {
  let t = 0; const q: { at: number; fn: () => void; id: number }[] = []; let n = 0;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = ++n; q.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (id: unknown) => { const i = q.findIndex((x) => x.id === id); if (i >= 0) q.splice(i, 1); },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at); const nx = q[0];
        if (!nx || nx.at > end) break;
        q.shift(); t = nx.at; nx.fn(); for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      t = end;
    },
    pending: () => q.length
  };
}
const S = (status: SendStatus['status'], p: Partial<SendStatus> = {}): SendStatus => ({ id: 'm', status, errorCode: null, retryable: false, retryCount: 0, maxRetries: 5, deliveryStatus: 'unknown', sentAt: null, ...p });

test('每 pollAfterMs 查一次，SENT 后停止', async () => {
  const c = clock(); const ev: PollEvent[] = []; let calls = 0;
  startSendPoll({ fetchStatus: async () => (++calls < 3 ? S('SENDING') : S('SENT')), onEvent: (e) => ev.push(e), pollAfterMs: 5000, ...c });
  await c.advance(4999); assert.equal(calls, 0);
  await c.advance(1); assert.equal(calls, 1);
  await c.advance(10_000); assert.equal(calls, 3);
  assert.equal(ev.at(-1)!.type, 'done'); assert.equal(c.pending(), 0);
  await c.advance(60_000); assert.equal(calls, 3);
});
test('FAILED / unknown_delivery 是终态', async () => {
  const c = clock(); const ev: PollEvent[] = [];
  startSendPoll({ fetchStatus: async () => S('FAILED', { errorCode: 'unknown_delivery' }), onEvent: (e) => ev.push(e), ...c });
  await c.advance(5000); assert.deepEqual(ev.map((e) => e.type), ['done']); assert.equal(c.pending(), 0);
});
test('2 分钟仍 SENDING → timeout 并停止', async () => {
  const c = clock(); const ev: PollEvent[] = []; let calls = 0;
  startSendPoll({ fetchStatus: async () => { calls++; return S('SENDING'); }, onEvent: (e) => ev.push(e), ...c });
  await c.advance(130_000);
  assert.equal(ev.at(-1)!.type, 'timeout'); assert.ok(calls <= 24); assert.equal(c.pending(), 0);
});
test('页面隐藏时暂停，回到前台立即查一次，不重置 2 分钟', async () => {
  const c = clock(); let hidden = false; let vis: () => void = () => {}; let calls = 0; const ev: PollEvent[] = [];
  startSendPoll({ fetchStatus: async () => { calls++; return S('SENDING'); }, onEvent: (e) => ev.push(e), isHidden: () => hidden, onVisibility: (fn) => { vis = fn; return () => {}; }, ...c });
  await c.advance(5000); assert.equal(calls, 1);
  hidden = true; await c.advance(60_000); assert.equal(calls, 1); assert.equal(c.pending(), 0);
  hidden = false; vis(); for (let i = 0; i < 5; i++) await Promise.resolve(); assert.equal(calls, 2);
  await c.advance(60_000); assert.equal(ev.at(-1)!.type, 'timeout');
});
test('409 anonymized / 404 → error 并停止；网络错误继续', async () => {
  const c = clock(); const ev: PollEvent[] = []; let calls = 0;
  startSendPoll({ fetchStatus: async () => { calls++; if (calls === 1) throw new TypeError('network'); throw new MailError('anonymized', 409); }, onEvent: (e) => ev.push(e), ...c });
  await c.advance(10_000);
  assert.equal(calls, 2); assert.equal(ev.length, 1); assert.ok(ev[0].type === 'error' && ev[0].error.code === 'anonymized'); assert.equal(c.pending(), 0);
});
test('stop() 之后不再请求', async () => {
  const c = clock(); let calls = 0;
  const stop = startSendPoll({ fetchStatus: async () => { calls++; return S('SENDING'); }, onEvent: () => {}, ...c });
  stop(); await c.advance(60_000); assert.equal(calls, 0);
});
