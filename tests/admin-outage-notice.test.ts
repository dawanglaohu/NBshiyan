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

function card(header: string | null, href: string) {
  const lang = header?.toLowerCase().startsWith('en') ? 'en' : header?.toLowerCase().startsWith('ru') ? 'ru' : 'zh-CN';
  return renderToStaticMarkup(React.createElement(AdminOutageNotice, { copy: outageCopy(header), href, lang }));
}
function visible(html: string) {
  return html.replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&nbsp;|&#x0*a0;/gi, ' ').replace(/\u00A0/g, ' ');
}

test('outage card renders zh, en and ru without technical detail', () => {
  for (const header of [null, 'zh-CN,zh;q=0.9', 'fr,en;q=0.8']) {
    const html = card(header, '/admin/inquiries');
    assert.match(html, /服务暂时不可用/);
    assert.match(html, /数据库连接出现问题，这不会让你退出登录，请稍后重试。/);
    assert.match(html, /lang="zh-CN"/);
    assert.match(html, /href="\/admin\/inquiries"/);
    assert.match(html, /class="adm-btn primary"/);
    assert.equal(html.includes('503'), false);
    assert.equal(html.includes('prisma'), false);
    assert.equal(html.includes('cookie'), false);
    assert.equal(html.includes('Max-Age'), false);
    assert.equal(html.includes('重新登录'), false);
  }
  const en = card('en-US,en;q=0.9', '/admin/specs');
  assert.match(en, new RegExp(OUTAGE_COPY.en.title));
  assert.match(visible(en), /This won.t sign you out/);
  assert.match(en, /lang="en"/);
  assert.match(en, />Try again</);
  const ru = card('ru-RU,ru;q=0.9,en;q=0.8', '/admin');
  assert.match(ru, new RegExp(OUTAGE_COPY.ru.title));
  assert.match(visible(ru), /Это не приведёт к выходу из системы/);
  assert.match(ru, /приведёт/);
  assert.ok(ru.includes('\u00A0') || /&nbsp;|&#x0*a0;/i.test(ru));
  assert.match(ru, /lang="ru"/);
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
  assert.ok(inquiry.indexOf('if (!gate.ok) return gate.notice') < inquiry.indexOf('notFound()'));
  assert.ok(inquiry.indexOf("c.reason === 'unavailable'") < inquiry.indexOf('prisma.inquiry'));
  assert.match(inquiry, /c\.reason === 'unavailable' \|\| c\.reason === 'internal'/);
  for (const file of ['src/app/admin/mail/unassigned/page.tsx', 'src/app/admin/specs/[category]/page.tsx']) {
    const src = readFileSync(file, 'utf8');
    assert.ok(src.indexOf('if (!gate.ok) return gate.notice') < src.indexOf('notFound()'), file);
    assert.equal(src.includes('return null'), false, file);
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
  assert.match(editor, /if \(!r\.ok\) \{ const s = serverErrors\(r\.status, j\); setErrors\(s\.fields\); commitAndReveal\(errRef, \(\) => setMsg\(\{ kind: 'err', text: s\.message \}\)\); return; \}/);
  const failure = adaptApiError({
    kind: 'http', status: 503, audience: 'admin',
    body: { error: 'service_unavailable', requestId: REQUEST_ID },
  });
  assert.equal(failure.action, 'retry');
  assert.equal(failure.code, 'service_unavailable');
  assert.equal(failure.status, 503);
});
