import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import AdminOutageNotice from '../src/components/admin/AdminOutageNotice';
import { errorText } from '../src/components/admin/format';
import { submitCreate } from '../src/lib/admin/enroll-link';
import { OUTAGE_COPY, outageCopy } from '../src/lib/admin/outage-copy';
import { adaptApiError } from '../src/lib/client/api-errors';
import { adminGate } from '../src/lib/server/admin/layout-gate';
import { adminPageGate } from '../src/lib/server/admin/page-access';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

test('outage card renders zh, en and ru without technical detail', () => {
  for (const header of [null, 'zh-CN,zh;q=0.9', 'fr,en;q=0.8']) {
    const html = renderToStaticMarkup(React.createElement(AdminOutageNotice, { copy: outageCopy(header), href: '/admin/inquiries' }));
    assert.match(html, /服务暂时不可用/);
    assert.match(html, /数据库连接出现问题，你的登录状态仍然有效/);
    assert.match(html, /href="\/admin\/inquiries"/);
    assert.match(html, /class="adm-btn primary"/);
    assert.equal(html.includes('503'), false);
    assert.equal(html.includes('prisma'), false);
    assert.equal(html.includes('cookie'), false);
    assert.equal(html.includes('Max-Age'), false);
    assert.equal(html.includes('重新登录'), false);
  }
  const en = renderToStaticMarkup(React.createElement(AdminOutageNotice, { copy: outageCopy('en-US,en;q=0.9'), href: '/admin/specs' }));
  assert.match(en, new RegExp(OUTAGE_COPY.en.title));
  assert.match(en, /Your sign-in is still valid/);
  assert.match(en, />Try again</);
  const ru = renderToStaticMarkup(React.createElement(AdminOutageNotice, { copy: outageCopy('ru-RU,ru;q=0.9,en;q=0.8'), href: '/admin' }));
  assert.match(ru, new RegExp(OUTAGE_COPY.ru.title));
  assert.match(ru, /Ваш вход по-прежнему действителен/);
  assert.match(ru, />Повторить</);
});

test('unavailable does not redirect the layout or the page gate', () => {
  assert.deepEqual(adminGate({ ok: false, reason: 'unavailable' }, '/admin/users'), { action: 'unavailable' });
  assert.deepEqual(adminPageGate({ ok: false, reason: 'unavailable' }, '/admin/inquiries/abc'), { action: 'unavailable' });
  const layout = readFileSync('src/app/admin/layout.tsx', 'utf8');
  const order = ['checkAdminSession(', 'adminGate(', 'redirect(gate.to)', 'notFound()', '<AdminShell'].map((s) => layout.indexOf(s));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), String(order));
  const notice = layout.indexOf('<AdminOutageNotice');
  assert.ok(notice > layout.indexOf('notFound()'));
  assert.match(layout, /gate\.action === 'unavailable'[\s\S]*<AdminOutageNotice/);
  assert.match(layout, /<AdminShell[^>]*>\{content\}<\/AdminShell>/);
  const inquiry = readFileSync('src/app/admin/inquiries/[id]/page.tsx', 'utf8');
  assert.ok(inquiry.indexOf("gate === 'unavailable'") < inquiry.indexOf('notFound()'));
  assert.ok(inquiry.indexOf("c.reason === 'unavailable'") < inquiry.indexOf('prisma.inquiry'));
  for (const file of ['src/app/admin/mail/unassigned/page.tsx', 'src/app/admin/specs/[category]/page.tsx']) {
    const src = readFileSync(file, 'utf8');
    assert.ok(src.indexOf("gate === 'unavailable'") < src.indexOf('notFound()'), file);
  }
});

test('a 503 form error stays on the form and can be submitted again', async () => {
  const text = errorText('service_unavailable', '操作失败');
  assert.equal(text, errorText('http_503', '保存失败'));
  assert.equal(text.includes('service_unavailable'), false);
  assert.equal(text.includes('http_503'), false);
  assert.equal(text.includes('重新登录'), false);
  assert.match(text, /服务暂时不可用/);
  const form = { email: 'a@example.com', name: 'Ada', role: 'SALES' as const, password: 'correct-horse-battery' };
  let created = 0;
  await assert.rejects(
    () => submitCreate(async (value) => { assert.equal(value, form); throw new Error('service_unavailable'); }, form, {
      onIssued() { throw new Error('issued'); },
      onCreated() { created += 1; },
    }),
    (error: unknown) => error instanceof Error && error.message === 'service_unavailable',
  );
  assert.equal(created, 0);
  assert.equal(form.password, 'correct-horse-battery');
  const editor = readFileSync('src/components/admin/specs/SpecEditor.tsx', 'utf8');
  assert.match(editor, /if \(!r\.ok\) \{ const s = serverErrors\(r\.status, j\); setErrors\(s\.fields\); setMsg\(\{ kind: 'err', text: s\.message \}\); return; \}/);
  const failure = adaptApiError({
    kind: 'http', status: 503, audience: 'admin',
    body: { error: 'service_unavailable', requestId: REQUEST_ID },
  });
  assert.equal(failure.action, 'retry');
  assert.equal(failure.code, 'service_unavailable');
  assert.equal(failure.status, 503);
});
