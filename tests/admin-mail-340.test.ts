// #340 P1 hotfix（前端）：未归类邮件入口关闭、附件入口关闭、重试卡片 429 文案、回复框失败保留草稿、往来记录加载失败的错误条。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import * as L from '../src/lib/admin/mail/logic';
import { MAIL_ATTACHMENTS_LIVE, UNASSIGNED_MAIL_LIVE } from '../src/lib/admin/mail/features';
import { httpMailApi } from '../src/lib/admin/mail/http';
import { MailError } from '../src/lib/admin/mail/types';
import UnassignedNav from '../src/components/admin/mail/UnassignedNav';
import { MailThreadView } from '../src/components/admin/mail/MailThread';
import { MailGateContext } from '../src/components/admin/mail/MailGate';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const noop = () => {};

// —— 1. 未归类邮件：整体关闭 ——
test('#340 flags: unassigned + attachments are off this round', () => {
  assert.equal(UNASSIGNED_MAIL_LIVE, false);
  assert.equal(MAIL_ATTACHMENTS_LIVE, false);
});
test('#340 unassigned: nav renders nothing (no link, no badge, no placeholder) and AdminShell does not mount it', () => {
  assert.equal(renderToStaticMarkup(React.createElement(UnassignedNav, { active: false })), '');
  assert.equal(renderToStaticMarkup(React.createElement(UnassignedNav, { active: true })), '');
  assert.match(src('components/admin/AdminShell.tsx'), /\{UNASSIGNED_MAIL_LIVE && mailEnabled && mailGate\.state !== 'off' && role === 'ADMIN' && <UnassignedNav/);
  // 60 秒轮询只在 LiveNav 里，开关关时 LiveNav 不挂载
  const nav = src('components/admin/mail/UnassignedNav.tsx');
  assert.match(nav, /return UNASSIGNED_MAIL_LIVE \? <LiveNav active=\{active\} \/> : null;/);
  assert.equal((nav.match(/unassignedCount\(/g) ?? []).length, 1);
  assert.ok(nav.indexOf('unassignedCount(') > nav.indexOf('function LiveNav'));
  // 除了 UnassignedNav（已关闭）以外，没有别的地方链到未归类页面
  for (const f of ['components/admin/AdminShell.tsx', 'components/admin/InquiryList.tsx', 'components/admin/mail/MailThread.tsx']) assert.doesNotMatch(src(f), /\/admin\/mail\/unassigned/, f);
});
test('#340 unassigned: page is notFound() while the flag is off (after the server-side auth check)', () => {
  const p = src('app/admin/mail/unassigned/page.tsx');
  assert.match(p, /await enforceAdminPage\(\['ADMIN'\], '\/admin\/mail\/unassigned'\);[\s\S]*if \(!UNASSIGNED_MAIL_LIVE\) notFound\(\);[\s\S]*return <UnassignedInbox \/>/);
});
test('#340 http client: no request to /mail/unassigned*, /mail/:id, assign*, ignore, attachments while flags are off; thread GET unchanged', async () => {
  const calls: string[] = [];
  const g = globalThis as { fetch: typeof fetch };
  const orig = g.fetch;
  g.fetch = (async (u: string | URL) => { calls.push(String(u)); return new Response(JSON.stringify({ anonymizedAt: null, items: [], nextCursor: null }), { status: 200 }); }) as typeof fetch;
  try {
    const off: [string, () => Promise<unknown>][] = [
      ['unassignedCount', () => httpMailApi.unassignedCount()], ['listUnassigned', () => httpMailApi.listUnassigned('UNASSIGNED')],
      ['getUnassigned', () => httpMailApi.getUnassigned('m1')], ['assignLookup', () => httpMailApi.assignLookup('PJ-2026-0001')],
      ['assign', () => httpMailApi.assign('m1', 'PJ-2026-0001')], ['ignore', () => httpMailApi.ignore('m1')], ['unignore', () => httpMailApi.unignore('m1')],
      ['refreshLinks', () => httpMailApi.refreshLinks(['a1'])], ['download', () => httpMailApi.download('/api/admin/mail/attachments/a1')]
    ];
    for (const [n, f] of off) {
      await assert.rejects(f(), (e: unknown) => e instanceof MailError && e.code === 'not_found', n);
    }
    assert.deepEqual(calls, [], 'no network request at all');
    await httpMailApi.getThread('iq 1');
    assert.deepEqual(calls, ['/api/admin/inquiries/iq%201/mail?limit=50'], 'GET /inquiries/:id/mail is still called as before');
  } finally { g.fetch = orig; }
});

// —— 2. 429 / 发送失败 ——
test('#340 retry card 429: final UX copy with #322 time (MM/DD HH:mm + zone), rounded up to the minute, no 「输入框」 claim', () => {
  const now = Date.parse('2026-10-18T02:00:00Z');
  const until = Date.parse('2026-10-18T02:12:34Z');
  assert.equal(L.retryRateText(until, now, 'America/Los_Angeles'), '发送太频繁，10/17 19:13 PT 后可重试；重试会重新发送原邮件，无需重填。');
  assert.equal(L.retryRateText(until, now, 'Asia/Shanghai'), '发送太频繁，10/18 10:13 GMT+8 后可重试；重试会重新发送原邮件，无需重填。');
  assert.equal(L.retryRateText(Date.parse('2026-10-18T02:13:00Z'), now, 'UTC'), '发送太频繁，10/18 02:13 UTC 后可重试；重试会重新发送原邮件，无需重填。');
  assert.doesNotMatch(L.retryRateText(until, now, 'UTC'), /输入框|已保留/);
  const t = src('components/admin/mail/MailThread.tsx');
  const out = t.slice(t.indexOf('function OutStatus'), t.indexOf('type FieldErrs'));
  assert.match(out, /\{limited && <span className="t" data-testid="rate-limited">\{retryRateText\(rate!\.until\)\}<\/span>\}/);
  assert.doesNotMatch(out, /<RateText/);
});
test('#340 composer 429 copy: 「内容已保留在输入框里」 only while the box really has text', () => {
  assert.match(L.rateLimitText('admin', 30, '12:34'), /内容已保留在输入框里。$/);
  assert.doesNotMatch(L.rateLimitText('admin', 30, '12:34', false), /已保留/);
  assert.match(src('components/admin/mail/MailThread.tsx'), /<RateText scope=\{rate!\.scope\} limit=\{rate!\.limit\} left=\{left\} kept=\{!!body\.trim\(\)\} \/>/);
});
test('#340 composer: subject + body survive 429 and every other failure; cleared only when accepted / queued', () => {
  const E = (code: string, body: Record<string, unknown> = {}) => new MailError(code, 0, body);
  for (const e of [E('rate_limited', { scope: 'admin', retryAfterSec: 754 }), E('rate_limited', { scope: 'global' }), E('mail_failed', { reason: 'provider_throttled', id: 'm9' }),
    E('mail_failed', { reason: 'send_auth', id: 'm9' }), E('mail_failed', {}), E('sending_disabled'), E('unknown'), E('invalid', { fields: { subject: 'too_long' } }), E('rate_limiter_unavailable')]) {
    assert.equal(L.draftAfterSendError(e), 'keep', `${e.code} ${JSON.stringify(e.body)}`);
  }
  assert.equal(L.draftAfterSendError(E('mail_failed', { reason: 'daily_cap_deferred', id: 'm9' })), 'clear', '已排队 = 服务端已接受');
  // 组件接线：发送前快照；catch 之后按 draftAfterSendError 恢复；只有成功 / 排队两处清空正文，主题从不清空
  const c = src('components/admin/mail/MailThread.tsx');
  const comp = c.slice(c.indexOf('function Composer'));
  assert.match(comp, /const snap = \{ subject, body \};/);
  assert.match(comp, /if \(draftAfterSendError\(err\) === 'keep'\) \{ setSubject\(\(s\) => s \|\| snap\.subject\); setBody\(\(b\) => b \|\| snap\.body\); \}/);
  assert.equal((comp.match(/setBody\(''\)/g) ?? []).length, 3, '成功、已排队、卡片重试成功且草稿没改过（见下面的测试）');
  assert.match(comp, /key\.current = undefined; setBody\(''\);\s*if \(r\.kind === 'sending'\)/, '成功（201/202）后清空');
  assert.match(comp, /const queued = draftAfterSendError\(err\) === 'clear';\s*if \(queued\) setBody\(''\);/, '已排队清空，其他 mail_failed 保留');
  assert.doesNotMatch(comp, /setSubject\(''\)/);
  // 安全：收件人不由前端拼，发信请求体里没有收件人字段
  assert.match(comp, /mailApi\.send\(inquiryId, \{ subject: subject\.trim\(\), body, \.\.\.\(inReplyToId \? \{ inReplyToId \} : \{\}\) \}, key\.current\)/);
});

// —— 3. 往来记录加载失败 ——
const view = (o: Partial<Parameters<typeof MailThreadView>[0]>) => renderToStaticMarkup(React.createElement(MailGateContext.Provider, { value: { state: 'on', sendingEnabled: true } },
  React.createElement(MailThreadView, { page: undefined, reloading: false, onReload: noop, cfg: { sendingEnabled: true }, inquiryId: 'iq1', recipient: 'buyer@acme.test',
    live: {}, itemNote: {}, onRetry: noop, onSent: noop, onFailedItem: noop, poll: noop, onAnonymized: noop, ...o })));
test('#340 thread load error (405 / 5xx / network / unknown): role=alert bar 「邮件记录加载失败」 + 重试, compose area still visible', () => {
  for (const code of ['unknown', 'mail_not_configured', 'unauthorized', 'forbidden']) {
    const h = view({ loadErr: code });
    assert.match(h, /<div class="ml-status err" role="alert" data-testid="thread-load-error"[^>]*><span class="t">⚠ 邮件记录加载失败<\/span><button type="button" class="ml-btn">重试<\/button><\/div>/, code);
    assert.match(h, /aria-label="回复客户"/, `${code}: compose stays`);
    assert.match(h, /id="ml-body"/);
  }
  assert.match(view({ loadErr: 'unknown', reloading: true }), /<button type="button" class="ml-btn" disabled="">重试中…<\/button>/);
  // 已加载过的记录在刷新失败时不清空
  const page = L.normalizeThread({ anonymizedAt: null, nextCursor: null, items: [{ id: 'm1', direction: 'INBOUND', subject: 'Hello', bodyText: 'hi', createdAt: '2026-10-17T00:00:00Z' }] });
  const h = view({ page, loadErr: 'unknown' });
  assert.match(h, /thread-load-error/); assert.match(h, /Hello/); assert.match(h, /aria-label="回复客户"/);
  // 正常加载：没有错误条
  assert.doesNotMatch(view({ page }), /thread-load-error/);
  // 405 在客户端映射成 unknown → 走错误条
  assert.equal(new MailError('unknown', 405).code, 'unknown');
  const t = src('components/admin/mail/MailThread.tsx');
  assert.match(t, /if \(c === 'not_found'\) setPage\(null\); else setLoadErr\(c\);/);
  assert.match(t, /const reload = async \(\) => \{ setReloading\(true\); try \{ await load\(\); \} finally \{ setReloading\(false\); \} \};/);
});
test('#340 thread 404: whole mail section collapses (unchanged behaviour)', () => {
  assert.equal(view({ page: null }), '');
});

// —— 4. 后端新行：legacy / redacted / 缺省字段 ——
test('#340 normalizeThread: legacy + redacted rows with missing fields render without crashing', () => {
  const page = L.normalizeThread({ items: [
    { id: 'l1', source: 'legacy', direction: 'OUTBOUND', bodyText: 'old note', createdAt: '2025-01-01T00:00:00Z' } as never,
    { id: 'r1', redacted: true, direction: 'INBOUND', createdAt: '2026-01-01T00:00:00Z' } as never,
    { id: 'x1', source: 'weird', flags: null, attachments: null } as never
  ] });
  assert.equal(page.anonymizedAt, null); assert.equal(page.nextCursor, null);
  assert.deepEqual(page.items.map((m) => [m.source, m.redacted, m.flags, m.attachments]), [['legacy', false, [], []], ['mail', true, [], []], ['mail', false, [], []]]);
  const h = view({ page });
  assert.match(h, /旧记录/);
  assert.match(h, /data-testid="deleted-body">内容已删除</);
  assert.doesNotMatch(h, /ml-att/, '附件卡片关闭');
  assert.deepEqual(L.normalizeThread({}).items, []);
});

// —— 5. PM：失败卡片上「重试 / 发送」的区别说明 ——
test('#340 failed card hint (UX final copy): exact copy, muted (not role=alert), only on failed cards that show 「重试」', () => {
  assert.equal(L.RETRY_VS_SEND_HINT, '发送失败。点「重试」重发这封；如需修改，请在下方编辑后发送新邮件。');
  const out = (id: string, o: Record<string, unknown>) => ({ id, source: 'mail', direction: 'OUTBOUND', subject: 'Re: hi', bodyText: 'body', createdAt: '2026-10-17T00:00:00Z', ...o }) as never;
  const page = L.normalizeThread({ items: [
    out('f1', { status: 'FAILED', errorCode: 'provider_throttled', retryable: true, retryCount: 1 }),
    out('f2', { status: 'FAILED', errorCode: 'send_auth', retryable: true, retryCount: 0 }),
    out('n1', { status: 'FAILED', errorCode: 'provider_throttled', retryable: false, retryCount: 0 }),
    out('l1', { status: 'FAILED', errorCode: 'provider_throttled', retryable: true, retryCount: 5, maxRetries: 5 }),
    out('s1', { status: 'SENT', sentAt: '2026-10-17T00:01:00Z' }),
    out('p1', { status: 'SENDING' }),
    { id: 'i1', direction: 'INBOUND', subject: 'hi', bodyText: 'x', createdAt: '2026-10-16T00:00:00Z' } as never
  ] });
  const h = view({ page });
  const cards = h.split('<article').slice(1);
  const byId = Object.fromEntries(cards.map((c) => [c.match(/data-id="([^"]+)"/)![1], c]));
  const hint = '<span class="ml-note ml-retry-hint" data-testid="retry-hint">发送失败。点「重试」重发这封；如需修改，请在下方编辑后发送新邮件。</span>';
  for (const id of Object.keys(byId)) {
    const hasRetry = /<button type="button" class="ml-btn"[^>]*>重试<\/button>/.test(byId[id]);
    assert.equal(byId[id].includes(hint), hasRetry, `${id}: hint iff 重试 button`);
  }
  assert.ok(byId.f1.includes(hint), 'retryable failed card has the hint');
  for (const id of ['n1', 'l1', 's1', 'p1', 'i1']) assert.ok(!byId[id].includes('retry-hint'), id);
  assert.equal((h.match(/data-testid="retry-hint"/g) ?? []).length, cards.filter((c) => c.includes(hint)).length);
  assert.doesNotMatch(hint, /role=/);
  assert.match(readFileSync(new URL('../src/app/admin/mail.css', import.meta.url), 'utf8'), /\.ml-note\{font-size:13px;color:var\(--ink-2\)\}/);
});

// —— 6. 卡片「重试」成功后回复框草稿 ——
test('#340 card retry success: unchanged draft (same subject + body as the failed mail) → clear body; edited → keep', () => {
  const failed = { subject: 'Re: Quote for gift boxes', bodyText: 'Hello Anna,\nprice attached.' };
  assert.equal(L.draftAfterCardRetry({ subject: 'Re: Quote for gift boxes', body: 'Hello Anna,\nprice attached.' }, failed), 'clear');
  assert.equal(L.draftAfterCardRetry({ subject: '  Re: Quote for gift boxes ', body: 'Hello Anna,\nprice attached.\n' }, failed), 'clear', '只差首尾空白（发送时会 trim）算没改');
  assert.equal(L.draftAfterCardRetry({ subject: 'Re: Quote for gift boxes', body: 'Hello Anna,\nprice attached. Thanks!' }, failed), 'keep', '正文改过');
  assert.equal(L.draftAfterCardRetry({ subject: 'Re: Quote — updated', body: 'Hello Anna,\nprice attached.' }, failed), 'keep', '主题改过');
  assert.equal(L.draftAfterCardRetry({ subject: 'Re: Quote for gift boxes', body: '' }, failed), 'keep', '已经是空的：不用动');
  assert.equal(L.draftAfterCardRetry({ subject: '', body: 'x' }, { subject: null, bodyText: null }), 'keep');
  // 接线：只在 retry 成功（await 之后、没抛错）时通知回复框；回复框清空正文、不动主题
  const c = src('components/admin/mail/MailThread.tsx');
  const retry = c.slice(c.indexOf('const retry = async'), c.indexOf('} finally { setRetrying(undefined); }'));
  const ok = retry.slice(0, retry.indexOf('} catch'));
  assert.match(ok, /const r = await mailApi\.retry\(m\.id, uuid\(\)\);\s*setRetried\(\(p\) => \(\{ subject: m\.subject, bodyText: m\.bodyText, n: \(p\?\.n \?\? 0\) \+ 1 \}\)\);/);
  assert.doesNotMatch(retry.slice(retry.indexOf('} catch')), /setRetried/, '重试失败不清空');
  const comp = c.slice(c.indexOf('function Composer'));
  assert.match(comp, /if \(draftAfterCardRetry\(draftRef\.current, retried\) === 'clear'\) \{ setBody\(''\); key\.current = undefined; \}/);
  assert.doesNotMatch(comp, /setSubject\(''\)/);
  assert.match(c, /<Composer retried=\{retried\}/);
});
test('#340 card retry: POST /api/admin/mail/:mid/retry for that message only; never calls send', async () => {
  const calls: { url: string; method?: string; body?: unknown; key?: string | null }[] = [];
  const g = globalThis as { fetch: typeof fetch };
  const orig = g.fetch;
  g.fetch = (async (u: string | URL, init?: RequestInit) => {
    calls.push({ url: String(u), method: init?.method, body: init?.body, key: new Headers(init?.headers).get('Idempotency-Key') });
    return new Response(JSON.stringify({ id: 'cmfailed0001', pollAfterMs: 5000 }), { status: 202 });
  }) as typeof fetch;
  try {
    const r = await httpMailApi.retry('cmfailed0001', 'k-1');
    assert.deepEqual(calls, [{ url: '/api/admin/mail/cmfailed0001/retry', method: 'POST', body: '{}', key: 'k-1' }], '空请求体：服务端按库里的原文重发同一封');
    assert.equal(r.kind, 'sending'); assert.equal(r.id, 'cmfailed0001');
  } finally { g.fetch = orig; }
  const c = src('components/admin/mail/MailThread.tsx');
  const retry = c.slice(c.indexOf('const retry = async'), c.indexOf('} finally { setRetrying(undefined); }'));
  assert.match(retry, /mailApi\.retry\(m\.id, uuid\(\)\)/);
  assert.doesNotMatch(retry, /mailApi\.send|key\.current/, '不调 send，也不碰回复框的 Idempotency-Key');
});
