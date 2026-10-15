import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React; // tsx 用经典 JSX 转换
import { renderToStaticMarkup } from 'react-dom/server';
import { MailBody, FlagChips, Unverified } from '../src/components/admin/mail/MailParts';
import { adminGate, rolesForAdminPath } from '../src/lib/server/admin/layout-gate';
import { mockMailApi } from '../src/lib/admin/mail/mock';
import { MailError } from '../src/lib/admin/mail/types';

test('正文 iframe：sandbox 只有 allow-popups 两项，no-referrer，srcdoc 带 CSP', () => {
  const html = renderToStaticMarkup(React.createElement(MailBody, { html: '<p>hi <img src="cid:a"></p>', text: 'hi', hasRemoteImages: true, title: 't' }));
  assert.match(html, /sandbox="allow-popups allow-popups-to-escape-sandbox"/);
  assert.doesNotMatch(html, /allow-scripts|allow-same-origin|allow-top-navigation/);
  assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /已阻止外部图片/);
});
test('没有外链图片时不显示横幅；纯文本信不渲染 iframe', () => {
  const html = renderToStaticMarkup(React.createElement(MailBody, { html: null, text: 'plain <b>', hasRemoteImages: false, title: 't' }));
  assert.doesNotMatch(html, /iframe|已阻止外部图片/); assert.match(html, /plain &lt;b&gt;/);
});
test('flags 胶囊：未知 flag 不显示；未验证提示文案', () => {
  const html = renderToStaticMarkup(React.createElement(FlagChips, { flags: ['bounce', 'mystery'] }));
  assert.match(html, />退信</); assert.doesNotMatch(html, /mystery/);
  assert.match(renderToStaticMarkup(React.createElement(Unverified)), /发件人未通过验证/);
});
test('未归类页面只给 ADMIN：SALES / EDITOR → 404', () => {
  assert.deepEqual(rolesForAdminPath('/admin/mail/unassigned'), ['ADMIN']);
  assert.deepEqual(adminGate({ ok: true, role: 'SALES' }, '/admin/mail/unassigned'), { action: 'notFound' });
  assert.deepEqual(adminGate({ ok: true, role: 'EDITOR' }, '/admin/mail'), { action: 'notFound' });
  assert.deepEqual(adminGate({ ok: true, role: 'ADMIN' }, '/admin/mail/unassigned'), { action: 'render' });
  assert.equal(adminGate({ ok: false, reason: 'unauthenticated' }, '/admin/mail/unassigned').action, 'redirect');
});
test('mock：徽标计数不含 auto / bounce；counts 含全部', async () => {
  const { unassigned } = await mockMailApi.unassignedCount();
  const page = await mockMailApi.listUnassigned('UNASSIGNED');
  const plain = page.items.filter((r) => !r.flags.includes('auto') && !r.flags.includes('bounce')).length;
  assert.equal(unassigned, plain); assert.ok(page.counts.unassigned > unassigned);
});
test('mock：已匿名化询盘 → 全部 redacted，发信 409 anonymized', async () => {
  const t = await mockMailApi.getThread('inq_anon_1');
  assert.ok(t.anonymizedAt); assert.ok(t.items.every((m) => m.redacted && m.subject === null && m.from === null && m.attachments.length === 0));
  await assert.rejects(mockMailApi.send('inq_anon_1', { subject: 's', body: 'b' }, 'k1'), (e: MailError) => e.code === 'anonymized');
});
test('mock：重试满 5 次 → 409 retry_limit；unknown_delivery → 409 not_retryable', async () => {
  await mockMailApi.getThread('inq_1');
  await assert.rejects(mockMailApi.retry('mo3', 'r1'), (e: MailError) => e.code === 'mail_failed'); // 4 → 5
  await assert.rejects(mockMailApi.retry('mo3', 'r2'), (e: MailError) => e.code === 'retry_limit');
  await assert.rejects(mockMailApi.retry('mo2', 'r3'), (e: MailError) => e.code === 'not_retryable');
});
test('mock：202 → 轮询两次后 SENT；同一个 Idempotency-Key 不重复发', async () => {
  const r = await mockMailApi.send('inq_2', { subject: 's', body: 'x [mock:202]' }, 'same');
  assert.equal(r.kind, 'sending');
  assert.deepEqual(await mockMailApi.send('inq_2', { subject: 's', body: 'x [mock:202]' }, 'same'), r);
  assert.equal((await mockMailApi.status(r.id)).status, 'SENDING');
  assert.equal((await mockMailApi.status(r.id)).status, 'SENT');
  assert.equal((await mockMailApi.getThread('inq_2')).items.filter((m) => m.id === r.id).length, 1);
});

test('邮件开关：默认关闭；生产环境拒绝 NEXT_PUBLIC_ADMIN_MAIL=mock', async () => {
  const { mailMode, mailEnabled } = await import('../src/lib/admin/mail/api');
  if (!process.env.NEXT_PUBLIC_ADMIN_MAIL) { assert.equal(mailMode, 'off'); assert.equal(mailEnabled, false); }
  const { prodEnvProblems } = await import('../prod-env-check');
  const env = { APP_ENV: 'production', NODE_ENV: 'production', NEXT_PUBLIC_ADMIN_API: 'http' };
  assert.ok(prodEnvProblems({ ...env, NEXT_PUBLIC_ADMIN_MAIL: 'mock' }).some((p) => p.includes('NEXT_PUBLIC_ADMIN_MAIL')));
  assert.ok(!prodEnvProblems({ ...env, NEXT_PUBLIC_ADMIN_MAIL: 'http' }).some((p) => p.includes('NEXT_PUBLIC_ADMIN_MAIL')));
});
