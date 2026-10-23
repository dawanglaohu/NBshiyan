// #74 前端：后台邮件界面状态（对接 #315 接口）——状态码 / 响应体 → 界面状态、预计发送时间格式、429 倒计时、开关关闭隐藏入口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import * as L from '../src/lib/admin/mail/logic';
import { fetchMailGate, mailGateFrom, MAIL_CONFIG_PATH, MAIL_OFF_TEXT, showSendEntry } from '../src/lib/admin/mail/gate';
import { toMailError, toSendResult } from '../src/lib/admin/mail/http';
import { futureTime, tzAbbr } from '../src/components/admin/format';
import { MailOffNote } from '../src/components/admin/mail/MailGate';
import { RateText } from '../src/components/admin/mail/MailParts';

const lf = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const src = (p: string) => lf(readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8'));
const st = (o: Partial<Parameters<typeof L.outboundView>[0]>) => L.outboundView({ status: 'FAILED', errorCode: null, retryable: false, retryCount: 0, sentAt: null, ...o });

// —— 开关：GET /api/admin/mail/config ——
test('config：404 → off；200 { sendingEnabled } → on；其他状态 / 坏响应 → on（不提前隐藏，由服务端判定）', () => {
  assert.deepEqual(mailGateFrom(404, { error: 'not_found' }), { state: 'off' });
  assert.deepEqual(mailGateFrom(200, { sendingEnabled: true }), { state: 'on', sendingEnabled: true });
  assert.deepEqual(mailGateFrom(200, { sendingEnabled: false }), { state: 'on', sendingEnabled: false });
  for (const [s, b] of [[401, { error: 'unauthorized' }], [500, null], [200, { sendingEnabled: 'yes' }], [200, null], [0, null]] as const) assert.deepEqual(mailGateFrom(s, b), { state: 'on', sendingEnabled: true });
  assert.equal(showSendEntry({ state: 'off' }), false);
  assert.equal(showSendEntry({ state: 'loading' }), false, '加载中也不显示，避免先出现再消失');
  assert.equal(showSendEntry({ state: 'on', sendingEnabled: false }), true, '开关开但没配好 SMTP：仍显示回复框（带「发信功能尚未开通」说明）');
});
test('config：fetchMailGate 请求同源 /api/admin/mail/config（no-store）；404 → off；网络错误 → on', async () => {
  const calls: [string, RequestInit | undefined][] = [];
  const g = await fetchMailGate(async (u, i) => { calls.push([u, i]); return { status: 404, json: async () => ({ error: 'not_found' }) }; });
  assert.deepEqual(g, { state: 'off' });
  assert.equal(calls[0][0], MAIL_CONFIG_PATH); assert.equal(MAIL_CONFIG_PATH, '/api/admin/mail/config');
  assert.equal(calls[0][1]?.credentials, 'same-origin'); assert.equal(calls[0][1]?.cache, 'no-store');
  assert.deepEqual(await fetchMailGate(async () => ({ status: 200, json: async () => ({ sendingEnabled: false }) })), { state: 'on', sendingEnabled: false });
  assert.deepEqual(await fetchMailGate(async () => { throw new TypeError('offline'); }), { state: 'on', sendingEnabled: true });
});
test('config 404 → 详情页隐藏所有发信入口，只显示一行灰色「邮件功能未开启」', () => {
  assert.equal(MAIL_OFF_TEXT, '邮件功能未开启');
  assert.equal(renderToStaticMarkup(React.createElement(MailOffNote)), '<p class="adm-mail-off" data-testid="mail-off">邮件功能未开启</p>');
  const d = src('components/admin/InquiryDetail.tsx');
  assert.match(d, /const mailOff = gate\.state === 'off';/);
  assert.match(d, /\{mailOff && !anon && <MailOffNote \/>\}/);
  assert.match(d, /\{mailEnabled && canSend && <MailThread/, '新回复框（MailThread）');
  assert.match(d, /\{ctl\.showReply && !mailEnabled && canSend && <section className="adm-sec">/, '旧回复区');
  const shell = src('components/admin/AdminShell.tsx');
  assert.match(shell, /const mailGate = useMailGateFetch\(\);/);
  assert.match(shell, /<MailGateContext\.Provider value=\{mailGate\}>/);
  assert.match(shell, /mailEnabled && mailGate\.state !== 'off' && role === 'ADMIN' && <UnassignedNav/);
  // MailThread 不再自己请求 config，读 AdminShell 的结果
  const t = src('components/admin/mail/MailThread.tsx');
  assert.doesNotMatch(t, /getConfig\(/);
  assert.match(t, /const gate = useMailGate\(\);/);
  assert.match(src('app/admin/admin.css'), /\.adm-mail-off\{color:var\(--ink-2\);font-size:13px/);
});

// —— 202 daily_cap_deferred ——
test('202 QUEUED + daily_cap_deferred（#315 SendResponse deferred）→ 排队，不轮询；提示带预计发送时间', () => {
  const r = toSendResult(202, { id: 'm1', status: 'QUEUED', errorCode: 'daily_cap_deferred', deferredUntil: '2026-10-18T07:00:00.000Z' });
  assert.deepEqual(r, { kind: 'sending', id: 'm1', pollAfterMs: 5000, deferred: true, deferredUntil: '2026-10-18T07:00:00.000Z' });
  assert.deepEqual(st({ status: 'QUEUED', errorCode: 'daily_cap_deferred' }), { kind: 'deferred' });
  assert.equal(L.QUEUED_TAG, '已排队');
  const now = Date.parse('2026-10-17T08:00:00Z'); // 10/17 01:00 PT
  assert.equal(L.deferredHint('2026-10-18T07:00:00.000Z', now, 'America/Los_Angeles'), '今天发信已达上限，已排队，预计 10/18 00:00 PT 发出');
  const t = src('components/admin/mail/MailThread.tsx');
  assert.match(t, /if \(deferred\) return;/, '排队的信不启动轮询（不会无限转圈）');
  // 线程里：「已排队」标签 + 提示；没有「刷新」/ 重发按钮
  const deferredLine = t.split('\n').find((l) => l.includes("if (v.kind === 'deferred')"))!;
  assert.match(deferredLine, /role="status"/); assert.match(deferredLine, /\{QUEUED_TAG\}/); assert.doesNotMatch(deferredLine, /<button/);
  // 回复框：提示在发送按钮下面，role=status
  const send = t.indexOf("{busy ? '正在发送…' : '发送'}"), hint = t.indexOf('data-testid="deferred-hint"');
  assert.ok(send > 0 && hint > send, '提示在发送按钮之后');
  assert.match(t, /<div className="ml-status ml-warn" role="status" data-testid="deferred-hint">/);
});
test('deferredUntil 格式：管理员本地时区 MM/DD HH:mm + 时区缩写；跨年补年份；固定时钟、不依赖机器时区', () => {
  const now = Date.parse('2026-10-17T08:00:00Z');
  const until = '2026-10-18T07:00:00.000Z';
  assert.equal(futureTime(until, { now, timeZone: 'America/Los_Angeles' }), '10/18 00:00 PT');
  assert.equal(futureTime(until, { now, timeZone: 'Asia/Shanghai' }), '10/18 15:00 GMT+8');
  assert.equal(futureTime(until, { now, timeZone: 'UTC' }), '10/18 07:00 UTC');
  assert.equal(futureTime(until, { now, timeZone: 'Europe/Moscow' }), '10/18 10:00 GMT+3');
  // 冬令时同样是 PT（不是 PDT / PST）
  assert.equal(tzAbbr(new Date('2026-01-10T08:00:00Z'), 'America/Los_Angeles'), 'PT');
  // 跨年：12/31 晚上排队、1/1 发出 → 带年份
  const nye = Date.parse('2027-01-01T06:00:00Z'); // 12/31 22:00 PT
  assert.equal(futureTime('2027-01-01T08:00:00Z', { now: nye, timeZone: 'America/Los_Angeles' }), '2027/01/01 00:00 PT');
  // 同一个时刻在上海已经是 1/1 → 同一年，不补年份
  assert.equal(futureTime('2027-01-01T08:00:00Z', { now: nye, timeZone: 'Asia/Shanghai' }), '01/01 16:00 GMT+8');
  assert.equal(futureTime('garbage', { now }), null);
  // 缺失 deferredUntil → 下一个 UTC 零点
  assert.equal(L.deferredHint(undefined, now, 'America/Los_Angeles'), '今天发信已达上限，已排队，预计 10/17 17:00 PT 发出');
});

// —— GET /api/admin/mail/[id]/status 状态卡片 ——
test('provider_throttled：黄色（不是红色）、「邮件服务暂时繁忙，请稍后重试」、可重试', () => {
  const v = st({ errorCode: 'provider_throttled', retryable: true, retryCount: 1 });
  assert.ok(v.kind === 'failed');
  assert.equal(v.tone, 'warn'); assert.equal(v.text, '邮件服务暂时繁忙，请稍后重试'); assert.equal(v.canRetry, true); assert.equal(v.code, 'provider_throttled');
  // 重试满 5 次 → 红色 + 不能再重试
  const lim = st({ errorCode: 'provider_throttled', retryable: true, retryCount: 5 });
  assert.ok(lim.kind === 'failed' && lim.tone === 'error' && lim.retryLimit && !lim.canRetry);
  const t = src('components/admin/mail/MailThread.tsx');
  assert.match(t, /className=\{`ml-status \$\{warn \? 'ml-warn' : 'err'\}`\} role=\{warn \? 'status' : 'alert'\}/);
  assert.match(t, /const warn = v\.tone === 'warn' \|\| limited;/);
  // 重试按钮调用 POST /api/admin/mail/{id}/retry（#315 路由 [messageId]/retry）
  assert.match(src('lib/admin/mail/http.ts'), /retry: \(mid, key\) => post\(`\/mail\/\$\{enc\(mid\)\}\/retry`, \{\}, key\)/);
  assert.match(src('app/admin/mail.css'), /\.ml-status\.ml-warn\{background:var\(--warnb\)/);
});
test('send_auth：红色 role=alert、「发信配置有误，已通知运维」、没有重试、只露出错误码', () => {
  for (const code of ['send_auth', 'smtp_auth']) {
    const v = st({ errorCode: code, retryable: true, retryCount: 0 });
    assert.ok(v.kind === 'failed');
    assert.equal(v.tone, 'error'); assert.equal(v.text, '发信配置有误，已通知运维'); assert.equal(v.canRetry, false);
    assert.deepEqual(L.retryButton({ canRetry: v.canRetry, rateLeft: 0, retrying: false, canSend: true }).show, false);
  }
  const t = src('components/admin/mail/MailThread.tsx');
  assert.match(t, /\{v\.code === 'send_auth' && <span className="ml-code">错误代码：\{v\.code\}<\/span>\}/);
  // 未知原因：不显示接口给的任何文字
  const u = st({ errorCode: 'smtp 535 5.7.8 Username and Password not accepted', retryable: true });
  assert.ok(u.kind === 'failed' && u.text === L.UNKNOWN_FAIL && u.code === null && !u.canRetry);
});
test('429：Retry-After 头 / retryAfterSec → rate_limited；黄色提示，按钮禁用到时间点后恢复', () => {
  const e1 = toMailError(429, { error: 'rate_limited', scope: 'admin', retryAfterSec: 90, limit: 30, windowSec: 3600 }, '90');
  assert.equal(e1.code, 'rate_limited'); assert.equal(e1.body.retryAfterSec, 90); assert.equal(e1.body.scope, 'admin');
  assert.equal(toMailError(429, {}, '42').body.retryAfterSec, 42, '只有 Retry-After 头');
  assert.equal(toMailError(429, {}, null).body.retryAfterSec, 60, '都没有 → 60 秒兜底');
  const t = src('components/admin/mail/MailThread.tsx');
  assert.match(t, /retryButton\(\{ canRetry: v\.canRetry, rateLeft: limited \? left : 0, retrying, canSend \}\)/);
  assert.match(t, /<div className="ml-status ml-warn" role="status" data-testid="rate-limited">/, '回复框里的 429 提示同样黄色 role=status');
});
/** 假时钟：手动推进时间、按时间顺序触发 interval（Node 20 的 mock.timers 在回调里 clearInterval 不生效，这里自己实现） */
function fakeClock(start: number) {
  let now = start, seq = 0;
  const timers = new Map<number, { f: () => void; ms: number; next: number }>();
  return {
    now: () => now,
    setInterval: (f: () => void, ms: number) => { const id = ++seq; timers.set(id, { f, ms, next: now + ms }); return id; },
    clearInterval: (id: never) => { timers.delete(id as unknown as number); },
    active: () => timers.size,
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.next <= end).sort((a, b) => a[1].next - b[1].next)[0];
        if (!due) break;
        now = due[1].next; due[1].next += due[1].ms; due[1].f();
      }
      now = end;
    }
  };
}
test('429 倒计时（假时钟）：禁用 → Retry-After 到点 → 重新可用，并停止计时', () => {
  const clock = fakeClock(1_000_000);
  const seen: number[] = [];
  const stop = L.startCountdown(clock.now() + 3000, (left) => seen.push(left), clock);
  const btn = () => L.retryButton({ canRetry: true, rateLeft: seen.at(-1)!, retrying: false, canSend: true });
  assert.deepEqual(seen, [3]); assert.deepEqual(btn(), { show: true, disabled: true }); assert.equal(clock.active(), 1);
  clock.tick(1000); assert.deepEqual(seen, [3, 2]); assert.equal(btn().disabled, true);
  clock.tick(1999); assert.deepEqual(seen, [3, 2, 1]); assert.equal(btn().disabled, true, '还差 1ms 仍禁用');
  clock.tick(1); assert.deepEqual(seen, [3, 2, 1, 0]); assert.deepEqual(btn(), { show: true, disabled: false });
  assert.equal(clock.active(), 0, '到 0 后计时器已清掉');
  clock.tick(10_000); assert.deepEqual(seen, [3, 2, 1, 0]);
  stop();
  // 中途卸载：stop() 清掉计时器
  const s3: number[] = []; const stop3 = L.startCountdown(clock.now() + 60_000, (l) => s3.push(l), clock);
  assert.equal(clock.active(), 1); stop3(); assert.equal(clock.active(), 0);
  // 已过期的 until：立即回调 0，不建计时器
  const s2: number[] = []; L.startCountdown(clock.now() - 1, (l) => s2.push(l), clock); assert.deepEqual(s2, [0]); assert.equal(clock.active(), 0);
  assert.equal(L.retryButton({ canRetry: true, rateLeft: 0, retrying: true, canSend: true }).disabled, true, '重试中禁用');
  assert.equal(L.retryButton({ canRetry: true, rateLeft: 0, retrying: false, canSend: false }).disabled, true, '发信未开通禁用');
  assert.equal(L.retryButton({ canRetry: false, rateLeft: 0, retrying: false, canSend: true }).show, false);
});

// —— 390：提示滚进视口 ——
test('提示出现时滚进视口：block nearest，减少动态效果时 behavior auto', () => {
  const p = src('components/admin/mail/MailParts.tsx');
  assert.match(p, /scrollIntoView\?\.\(\{ block: 'nearest', behavior: scrollBehaviorFor\(prefersReducedMotion\(window\)\) \}\)/);
  const t = src('components/admin/mail/MailThread.tsx');
  assert.match(t, /useRevealOnChange\(hintRef,/); assert.match(t, /useRevealOnChange\(ref, reveal \?/);
  assert.match(t, /<div ref=\{hintRef\} className="ml-hints">/);
});

// —— 同一提交里的两条 UX P3 ——
test('P3：详情副标题行开头没有「·」；没填规格显示「未填写规格」，「暂无记录」只用于空列表', () => {
  const d = src('components/admin/InquiryDetail.tsx');
  assert.match(d, /<span className="muted">\{c\.region\} · <AdminTime iso=\{inq\.createdAt\} \/><\/span>/);
  assert.doesNotMatch(d, /<span className="muted">· /);
  assert.match(d, /const NO_SPECS_TEXT = '未填写规格';/);
  assert.match(d, /: <span className="adm-empty-note">\{NO_SPECS_TEXT\}<\/span>\}/);
  assert.doesNotMatch(d, /<span className="adm-empty-note">\{EMPTY_TEXT\}<\/span>/);
});
test('没有 dangerouslySetInnerHTML', () => {
  for (const f of ['components/admin/mail/MailThread.tsx', 'components/admin/mail/MailGate.tsx', 'components/admin/mail/MailParts.tsx', 'components/admin/InquiryDetail.tsx', 'components/admin/AdminShell.tsx']) assert.doesNotMatch(src(f), /dangerouslySetInnerHTML/, f);
});
test('429 文案：倒计时在句中原位', () => {
  const html = renderToStaticMarkup(React.createElement(RateText, { scope: 'admin', limit: 30, left: 42 }));
  assert.equal(html, '你本小时已发 30 封，达到上限。<span aria-live="off">00:42</span> 后可以再发。内容已保留在输入框里。');
  const g = renderToStaticMarkup(React.createElement(RateText, { scope: 'global', limit: 450, left: 5 }));
  assert.match(g, /为保护域名信誉暂停发送。<span aria-live="off">00:05<\/span> 后可以再发。$/);
});
test('回复框：往来记录刷新之后才显示提示（滚进视口时位置准确）', () => {
  const t = src('components/admin/mail/MailThread.tsx');
  const sent = 'await onSent();\n      // 往来记录刷新';
  const i = t.indexOf(sent), j = t.indexOf('if (r.deferred) setDeferred(');
  assert.ok(i > 0 && j > i);
  const crlfThread = lf(readFileSync(new URL('../src/components/admin/mail/MailThread.tsx', import.meta.url), 'utf8')).replace(/\n/g, '\r\n');
  assert.equal(crlfThread.indexOf(sent), -1);
  assert.ok(lf(crlfThread).indexOf(sent) > 0 && lf(crlfThread).indexOf(sent) < lf(crlfThread).indexOf('if (r.deferred) setDeferred('));
  assert.equal(lf(crlfThread).replace('await onSent();', 'await skipSent();').indexOf(sent), -1);
});
