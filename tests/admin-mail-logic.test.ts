import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/lib/admin/mail/logic';
import { MailError } from '../src/lib/admin/mail/types';

const st = (p: Partial<Parameters<typeof L.outboundView>[0]>) => L.outboundView({ status: 'FAILED', errorCode: null, retryable: false, retryCount: 0, sentAt: null, ...p });

test('outboundView：SENDING / SENT', () => {
  assert.deepEqual(st({ status: 'SENDING' }), { kind: 'sending' });
  assert.deepEqual(st({ status: 'SENT', sentAt: 'x' }), { kind: 'sent', at: 'x' });
});
test('unknown_delivery → 可能已送达，永远不可重试（即使 retryable:true）', () => {
  assert.deepEqual(st({ errorCode: 'unknown_delivery', retryable: true }), { kind: 'maybe_delivered' });
});
test('可重试原因 + retryCount<5 才显示重试；>=5 → retry_limit', () => {
  const a = st({ errorCode: 'send_unavailable', retryable: true, retryCount: 4 });
  assert.equal(a.kind, 'failed'); assert.ok(a.kind === 'failed' && a.canRetry && !a.retryLimit);
  const b = st({ errorCode: 'provider_throttled', retryable: true, retryCount: 5 });
  assert.ok(b.kind === 'failed' && !b.canRetry && b.retryLimit);
  const c = st({ errorCode: 'send_unavailable', retryable: false });
  assert.ok(c.kind === 'failed' && !c.canRetry);
});
test('不认识的 reason / unknown → 通用文案、不可重试（忽略 retryable）', () => {
  for (const code of ['unknown', 'brand_new_code', null]) {
    const v = st({ errorCode: code, retryable: true });
    assert.ok(v.kind === 'failed' && !v.canRetry && !v.retryLimit); assert.ok(v.kind === 'failed' && v.text === L.UNKNOWN_FAIL);
  }
});
test('v4 新原因码都有文案；send_auth / recipient_rejected / message_rejected 不可重试', () => {
  for (const code of ['send_unavailable', 'provider_throttled']) { const v = st({ errorCode: code, retryable: true }); assert.ok(v.kind === 'failed' && v.canRetry && v.text !== L.UNKNOWN_FAIL); }
  for (const code of ['send_auth', 'recipient_rejected', 'message_rejected']) { const v = st({ errorCode: code, retryable: true }); assert.ok(v.kind === 'failed' && !v.canRetry && v.text !== L.UNKNOWN_FAIL); }
});
test('retryCountText：0 不显示，4 提示还能 1 次', () => {
  assert.equal(L.retryCountText(0), null);
  assert.deepEqual(L.retryCountText(2), { text: '已重试 2/5', last: false });
  assert.deepEqual(L.retryCountText(4), { text: '已重试 4/5 · 还能重试 1 次', last: true });
});
test('正文计数：19000 起接近上限，超过 20000 显示超出', () => {
  assert.equal(L.bodyCounter(18999).level, 'ok');
  assert.equal(L.bodyCounter(19000).level, 'near'); assert.match(L.bodyCounter(19000).text, /接近上限/);
  assert.equal(L.bodyCounter(20000).level, 'near');
  assert.deepEqual(L.bodyCounter(20005), { text: '20005 / 20000 · 已超出 5 字', level: 'over' });
});
test('主题：换行变空格；无主题时回复主题留空，不带「Re: （无主题）」', () => {
  assert.equal(L.oneLineSubject('a\r\nb\nc'), 'a b c');
  assert.equal(L.replySubject(null), ''); assert.equal(L.replySubject('  '), '');
  assert.equal(L.replySubject('Hello'), 'Re: Hello'); assert.equal(L.replySubject('RE: Hello'), 'RE: Hello');
});
test('400 invalid 逐字段文案；未知字段 / 未知码 → null（表单顶部通用）', () => {
  assert.equal(L.invalidFieldText('subject', 'too_long', { subject: 200 }), '主题不能超过 200 字');
  assert.equal(L.invalidFieldText('body', 'required'), '请填写正文');
  assert.equal(L.invalidFieldText('subject', 'newline'), '主题不能换行');
  assert.equal(L.invalidFieldText('attachments', 'unknown_field'), null);
  assert.equal(L.invalidFieldText('subject', 'bad_format'), null);
});
test('sendErrorText：413 / 409 各分支 / 未知', () => {
  assert.deepEqual(L.sendErrorText(new MailError('too_large', 413, { field: 'body', limit: 20000 })), { text: '正文不能超过 20000 字', tone: 'error', at: 'body' });
  assert.match(L.sendErrorText(new MailError('too_large', 413, { field: 'request', limit: 51200 }))!.text, /上限 50 KB/);
  assert.equal(L.sendErrorText(new MailError('anonymized', 409))!.tone, 'neutral');
  assert.match(L.sendErrorText(new MailError('sending_disabled', 409))!.text, /发信功能尚未开通/);
  assert.equal(L.sendErrorText(new MailError('sending_disabled', 409))!.tone, 'neutral');
  assert.equal(L.sendErrorText(new MailError('retry_limit', 409))!.text, L.RETRY_LIMIT_HINT);
  assert.equal(L.sendErrorText(new MailError('not_retryable', 409))!.text, L.NOT_RETRYABLE);
  assert.match(L.sendErrorText(new MailError('unknown', 409))!.text, /未知原因/);
  assert.equal(L.sendErrorText(new MailError('rate_limited', 429)), null);
});
test('429 文案写「本小时」，倒计时 mm:ss', () => {
  assert.equal(L.fmtCountdown(754), '12:34'); assert.equal(L.fmtCountdown(0.2), '00:01'); assert.equal(L.fmtCountdown(-3), '00:00');
  assert.match(L.rateLimitText('admin', 30, '12:34'), /^你本小时已发 30 封，达到上限。12:34 后可以再发。/);
  assert.match(L.rateLimitText('global', 200, '01:00'), /^全站本小时的发信量已达上限（200 封）/);
});
test('徽标：0 不显示，>99 显示 99+', () => {
  assert.equal(L.badgeText(0), null); assert.equal(L.badgeText(undefined), null);
  assert.equal(L.badgeText(7), '7'); assert.equal(L.badgeText(99), '99'); assert.equal(L.badgeText(100), '99+');
});
test('90 天删除倒计时', () => {
  const now = Date.parse('2026-10-15T00:00:00Z'); const d = (n: number) => new Date(now + n * 86_400_000).toISOString();
  assert.deepEqual(L.expiresText(d(80), now), { text: '还剩 80 天删除', soon: false });
  assert.deepEqual(L.expiresText(d(14), now), { text: '还剩 14 天删除', soon: true });
  assert.deepEqual(L.expiresText(d(0.5), now), { text: '明天删除', soon: true });
  assert.deepEqual(L.expiresText(d(-0.1), now), { text: '今天删除', soon: true });
});
test('气泡：redacted 不显示主题；无主题占位；authorName null → 管理员；senderVerified 只有 false 提示', () => {
  assert.equal(L.subjectText({ redacted: true, subject: 'x' }), null);
  assert.equal(L.subjectText({ redacted: false, subject: null }), '（无主题）');
  assert.equal(L.subjectText({ redacted: false, subject: 'Hi' }), 'Hi');
  assert.equal(L.authorText({ direction: 'OUTBOUND', authorName: null, from: 'a', redacted: false }), '管理员');
  assert.equal(L.authorText({ direction: 'OUTBOUND', authorName: '业务员 A', from: 'a', redacted: true }), '管理员');
  assert.equal(L.authorText({ direction: 'INBOUND', authorName: null, from: 'a@b', redacted: true }), null);
  assert.equal(L.showUnverified({ senderVerified: false }), true);
  assert.equal(L.showUnverified({ senderVerified: null }), false);
  assert.equal(L.showUnverified({}), false);
  assert.equal(L.showUnverified({ senderVerified: false, redacted: true }), false);
});
test('flags：只显示已知值', () => {
  assert.deepEqual(L.knownFlags(['auto', 'nope', 'bounce', 'parse_error']), ['auto', 'bounce', 'parse_error']);
  for (const f of ['too_large', 'auto', 'bounce', 'attachment_rejected', 'parse_error']) { assert.ok(L.FLAG_LABEL[f]); assert.ok(L.FLAG_HINT[f]); }
});
test('srcdoc：CSP、cid 占位、外链图片去掉、错配链接提示', () => {
  const html = '<p>a <img src="cid:x@y"> <img data-remote-src="https://t.example/p.gif"> <a href="https://evil.example/?a=1&amp;b=2" data-mismatch="1" title="t">www.good.example</a> <a href="https://ok.example">ok</a></p>';
  const s = L.buildSrcdoc(html);
  assert.ok(s.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`));
  assert.ok(s.includes('<span class="cidph">[内嵌图片未显示]</span>'));
  assert.ok(!s.includes('data-remote-src') && !/<img/i.test(s));
  assert.equal((s.match(/实际网址与显示文字不同/g) ?? []).length, 1);
  assert.ok(s.includes('title="https://evil.example/?a=1&#38;b=2"'));
  assert.ok(!/<script/i.test(s) && !/<base/i.test(s));
  assert.equal(L.IFRAME_SANDBOX, 'allow-popups allow-popups-to-escape-sandbox');
});
test('附件链接过期判断与大小格式', () => {
  assert.equal(L.linkExpired(new Date(Date.now() - 1).toISOString()), true);
  assert.equal(L.linkExpired(new Date(Date.now() + 60_000).toISOString()), false);
  assert.equal(L.fmtSize(2_480_000), '2.4 MB'); assert.equal(L.fmtSize(24_000), '23 KB');
  assert.equal(L.typeBadge('application/pdf'), 'PDF');
});
