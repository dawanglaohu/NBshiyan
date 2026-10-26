import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyForm, fromView, toBody, isHttpsUrl, newCertRow, serverErrors, specSaveErrors, type SpecForm } from '../src/lib/admin/spec-form';
import { FORM_INVALID } from '../src/lib/admin/outage-copy';
import { SpecInput, adminView, toRow } from '../src/lib/server/specs';
import { SPEC_PAGE_ROLES } from '../src/lib/server/admin/page-access';

const filled = (): SpecForm => ({
  ...emptyForm(),
  sizeMin: { l: '50', w: '50', h: '20' }, sizeMax: { l: '600', w: '400', h: '400' },
  materialEn: ' Kraft paper ', materialRu: 'Крафт-бумага', moqValue: '500',
  feeMode: 'paid', feeAmount: '30.50', feeCurrency: 'EUR', leadMin: '10', leadMax: '15',
  certifications: [newCertRow({ name: 'FSC', certNo: 'FSC-C1' }), newCertRow({ name: 'ISO 9001', url: 'https://example.com/iso.pdf' })],
  tradeTerms: ['FOB', 'EXW'], notesEn: 'Custom sizes', notesRu: '',
});

test('valid form -> body that the server schema accepts, values and units separate', () => {
  const { body, errors } = toBody(filled());
  assert.deepEqual(errors, {});
  assert.deepEqual(body, {
    size: { min: { l: 50, w: 50, h: 20 }, max: { l: 600, w: 400, h: 400 }, unit: 'mm' },
    material: { en: 'Kraft paper', ru: 'Крафт-бумага' },
    moq: { value: 500, unit: 'pcs' }, sampleFee: { amount: 30.5, currency: 'EUR' },
    leadTime: { min: 10, max: 15, unit: 'day' },
    certifications: [{ name: 'FSC', certNo: 'FSC-C1' }, { name: 'ISO 9001', url: 'https://example.com/iso.pdf' }],
    tradeTerms: ['EXW', 'FOB'], notes: { en: 'Custom sizes' },
  });
  assert.ok(SpecInput.safeParse(body).success);
});

test('empty form clears every field (all null) and is accepted by the server', () => {
  const { body } = toBody(emptyForm());
  assert.ok(body && Object.values(body).every((v) => v === null));
  assert.ok(SpecInput.safeParse(body).success);
  assert.deepEqual(toBody({ ...emptyForm(), feeMode: 'free' }).body?.sampleFee, { free: true });
});

test('round trip: server admin view -> form -> body is stable', () => {
  const body = toBody(filled()).body!;
  const row = toRow(SpecInput.parse(body)) as Record<string, unknown>;
  for (const k of Object.keys(row)) if (String(row[k]) === 'DbNull') row[k] = null;
  const view = adminView('gift-boxes', { ...row, updatedAt: new Date() } as never);
  assert.deepEqual(toBody(fromView(view)).body, body);
});

test('client validation mirrors the server rules', () => {
  const bad = (patch: Partial<SpecForm>) => Object.keys(toBody({ ...filled(), ...patch }).errors);
  assert.deepEqual(bad({ sizeMin: { l: '700', w: '50', h: '20' } }), ['size.max.l']);
  assert.deepEqual(bad({ sizeMax: { l: '600', w: '', h: '' } }), ['size.max']);
  assert.deepEqual(bad({ moqValue: '1.5' }), ['moq.value']);
  assert.deepEqual(bad({ moqValue: '-3' }), ['moq.value']);
  assert.deepEqual(bad({ leadMin: '20', leadMax: '10' }), ['leadTime.max']);
  assert.deepEqual(bad({ feeAmount: '10.001' }), ['sampleFee.amount']);
  assert.deepEqual(bad({ feeAmount: '0' }), ['sampleFee.amount']);
  assert.deepEqual(bad({ moqUnit: 'kg' }), ['moq.unit']);
  assert.deepEqual(bad({ tradeTerms: ['FOB', 'XYZ'] }), ['tradeTerms']);
  assert.deepEqual(bad({ certifications: [newCertRow({ name: 'FSC' })] }), ['certifications.0.certNo']);
  assert.deepEqual(bad({ certifications: [newCertRow({ certNo: '1' })] }), ['certifications.0.name']);
  assert.equal(toBody({ ...filled(), moqValue: 'abc' }).body, null);
});

test('certification url: https only (client)', () => {
  for (const u of ['javascript:alert(1)', 'data:text/html,x', 'http://fsc.org', 'ftp://fsc.org', '//fsc.org', 'fsc.org', 'https//x', 'https://x.org/' + 'a'.repeat(2048)]) {
    assert.equal(isHttpsUrl(u), false, u);
    const e = toBody({ ...filled(), certifications: [newCertRow({ name: 'FSC', url: u })] }).errors;
    assert.ok(e['certifications.0.url'], u);
    assert.equal(SpecInput.safeParse({ certifications: [{ name: 'FSC', url: u }] }).success, false, `server also rejects ${u}`);
  }
  assert.ok(isHttpsUrl('HTTPS://fsc.org/cert?id=1'));
});

test('certification rows: add / remove keep unique keys; removed rows not sent', () => {
  const f = filled();
  const keys = new Set([...f.certifications, newCertRow(), newCertRow()].map((c) => c.key));
  assert.equal(keys.size, 4);
  const removed = { ...f, certifications: f.certifications.filter((_, i) => i !== 0) };
  assert.deepEqual(toBody(removed).body?.certifications, [{ name: 'ISO 9001', url: 'https://example.com/iso.pdf' }]);
  assert.equal(toBody({ ...f, certifications: [] }).body?.certifications, null);
});

test('server errors are shown: codes mapped, 400 issues per field, unknown codes safe', () => {
  assert.equal(serverErrors(403, { error: 'forbidden' }).message, '没有权限（需要 ADMIN 或 EDITOR 角色）');
  assert.equal(serverErrors(403, { error: 'forbidden_origin' }).message, '请求被拒绝：来源校验失败，请刷新页面后重试');
  assert.equal(serverErrors(429, { error: 'rate_limited' }).message, '操作太频繁，请稍后再试');
  const generic = '服务暂时出错，请稍后重试。';
  const unknown = 'zz_unknown_code_123';
  assert.equal(serverErrors(401, {}).message, generic);
  assert.equal(serverErrors(401, {}).message.includes('http_401'), false);
  const urlCopy = toBody({ ...filled(), certifications: [newCertRow({ name: 'FSC', url: 'http://x' })] }).errors['certifications.0.url'];
  const s = serverErrors(400, { error: 'invalid', issues: [{ path: 'certifications.0.url', message: 'https_url_required' }, { path: '', message: 'x' }, { bogus: 1 }] });
  assert.equal(s.message, FORM_INVALID.zh);
  assert.equal(s.fields['certifications.0.url'], urlCopy);
  assert.equal(s.fields._, undefined);
  const mappedSave = specSaveErrors(400, { error: 'invalid', issues: [{ path: 'certifications.0.url', message: 'https_url_required' }, { path: '', message: 'x' }, { bogus: 1 }] });
  assert.equal(mappedSave.top, '');
  assert.equal(mappedSave.fields['certifications.0.url'], urlCopy);
  assert.equal(mappedSave.fields._, undefined);
  const shown = [s.message, ...Object.values(s.fields)];
  assert.equal(shown.includes('https_url_required'), false);
  assert.equal(shown.includes('x'), false);
  assert.equal(serverErrors(500, 'not json').message, generic);
  assert.equal(serverErrors(500, { error: 'internal_error', message: unknown }).message, generic);
  const odd = serverErrors(500, { error: unknown, message: unknown });
  assert.equal(odd.message, generic);
  assert.equal(odd.message.includes(unknown), false);
  const outage = '服务暂时不可用。数据库连接出现问题，这不会让你退出登录，请稍后重试。';
  assert.equal(serverErrors(503, { error: 'service_unavailable' }).message, outage);
  assert.equal(serverErrors(503, {}).message, outage);
  assert.equal(serverErrors(503, { error: 'service_unavailable' }).message.includes('service_unavailable'), false);
});

test('server field errors stay on the whitelist and non-400 responses keep the form', () => {
  const leaked = 'postgres://secret-should-not-render';
  const urlCopy = toBody({ ...filled(), certifications: [newCertRow({ name: 'FSC', url: 'http://x' })] }).errors['certifications.0.url'];
  const sizeCopy = toBody({ ...filled(), sizeMin: { l: '700', w: '50', h: '20' } }).errors['size.max.l'];
  const moqCopy = toBody({ ...filled(), moqValue: '0' }).errors['moq.value'];
  const termsCopy = toBody({ ...filled(), tradeTerms: ['FOB', 'XYZ'] }).errors.tradeTerms;
  const materialCopy = toBody({ ...filled(), materialEn: 'a'.repeat(301) }).errors.material;
  let readMessage = false;
  let readIssues = false;
  const hidden = {
    error: 'internal_error',
    get message() { readMessage = true; return leaked; },
    get issues() { readIssues = true; return [{ path: 'notes', message: leaked }]; },
  };
  const internal = serverErrors(500, hidden);
  assert.equal(readMessage, false);
  assert.equal(readIssues, false);
  assert.deepEqual(internal.fields, {});
  assert.equal(internal.message, '服务暂时出错，请稍后重试。');
  assert.equal(JSON.stringify(internal).includes(leaked), false);

  for (const status of [401, 403, 502, 503]) {
    const body = serverErrors(status, { error: status === 503 ? 'service_unavailable' : 'zz_unknown_code_123', message: leaked, issues: [{ path: 'moq.value', message: leaked }] });
    assert.deepEqual(body.fields, {});
    assert.equal(JSON.stringify(body).includes(leaked), false);
    assert.equal(JSON.stringify(body).includes('zz_unknown_code_123'), false);
  }
  assert.equal(serverErrors(502, { message: leaked, issues: [{ path: 'notes', message: leaked }] }).message, '服务暂时出错，请稍后重试。');
  assert.equal(serverErrors(500, { error: 'constructor', message: leaked }).message.includes('constructor'), false);

  let readTop = false;
  const bad = serverErrors(400, {
    error: 'invalid',
    get message() { readTop = true; return leaked; },
    issues: [
      { path: 'certifications.0.url', message: 'https_url_required' },
      { path: 'certifications.0.url', code: 'https_url_required', message: leaked },
      { path: 'size.max.l', message: 'size_min_gt_max' },
      { path: 'moq.value', message: leaked },
      { path: 'material.en', message: `String must contain at most 300 character(s) ${leaked}` },
      { path: 'tradeTerms.0', message: `Invalid enum value. Expected 'FOB', received '${leaked}'` },
      { path: '', message: leaked },
      { path: 'capacity', message: leaked },
    ],
  });
  assert.equal(readTop, false);
  assert.equal(bad.message, FORM_INVALID.zh);
  assert.equal(bad.fields['certifications.0.url'], urlCopy);
  assert.equal(bad.fields['size.max.l'], sizeCopy);
  assert.equal(bad.fields['moq.value'], moqCopy);
  assert.equal(bad.fields.material, materialCopy);
  assert.equal(bad.fields.tradeTerms, termsCopy);
  assert.equal(bad.fields._, undefined);
  const saved = specSaveErrors(400, {
    error: 'invalid',
    message: leaked,
    issues: [
      { path: 'certifications.0.url', message: 'https_url_required' },
      { path: '', message: leaked },
    ],
  });
  assert.equal(saved.top, '');
  assert.equal(saved.fields['certifications.0.url'], urlCopy);
  assert.equal(JSON.stringify(saved).includes(leaked), false);
  assert.equal(JSON.stringify(bad).includes(leaked), false);
  assert.equal(JSON.stringify(bad).includes('https_url_required'), false);
  assert.equal(JSON.stringify(bad).includes('size_min_gt_max'), false);
  assert.equal(JSON.stringify(bad).includes('String must contain'), false);
});

test('page access: EDITOR + ADMIN only, checked server-side before rendering', () => {
  assert.deepEqual([...SPEC_PAGE_ROLES].sort(), ['ADMIN', 'EDITOR']);
  for (const f of ['src/app/admin/specs/[category]/page.tsx', 'src/app/admin/specs/page.tsx']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /enforceAdminPage\(SPEC_PAGE_ROLES,/);
    assert.match(src, /force-dynamic/);
    assert.ok(src.indexOf('enforceAdminPage(') < src.lastIndexOf('return'), f);
  }
  const guard = readFileSync('src/lib/server/admin/guard.ts', 'utf8');
  assert.match(guard, /requireAdmin[\s\S]*checkAdminSession\(roles, req\)/); // 接口和页面同一套规则
  const ed = readFileSync('src/components/admin/specs/SpecEditor.tsx', 'utf8');
  assert.match(ed, /method: 'PUT', credentials: 'same-origin'/);
  assert.ok(!/dangerouslySetInnerHTML/.test(ed));
  assert.ok(!/dangerouslySetInnerHTML/.test(readFileSync('src/components/admin/specs/SpecEditorView.tsx', 'utf8')));
});

test('top fallback only when no issue maps to a field', () => {
  const leaked = 'postgres://secret-should-not-render';
  const only = specSaveErrors(400, { error: 'invalid', message: leaked, issues: [{ path: '', message: leaked }, { path: 'capacity', message: leaked }] });
  assert.equal(only.top, FORM_INVALID.zh);
  assert.deepEqual(only.fields, {});
  assert.equal(JSON.stringify(only).includes(leaked), false);
  const none = specSaveErrors(400, { error: 'invalid', message: leaked, issues: [] });
  assert.equal(none.top, FORM_INVALID.zh);
  assert.deepEqual(none.fields, {});
  const mapped = specSaveErrors(400, { error: 'invalid', message: leaked, issues: [{ path: 'material.en', message: leaked }, { path: '', message: leaked }] });
  assert.equal(mapped.top, '');
  assert.equal(mapped.fields.material, '最多 300 个字符');
  assert.equal(mapped.fields._, undefined);
  assert.equal(JSON.stringify(mapped).includes(leaked), false);
  assert.equal(JSON.stringify(mapped).includes(FORM_INVALID.zh), false);
  const down = specSaveErrors(503, { error: 'service_unavailable', message: leaked, issues: [{ path: 'notes', message: leaked }] });
  assert.equal(down.top, '服务暂时不可用。数据库连接出现问题，这不会让你退出登录，请稍后重试。');
  assert.deepEqual(down.fields, {});
  assert.equal(JSON.stringify(down).includes(leaked), false);
});

test('issue path __proto__ lands on _ and does not pollute the prototype', () => {
  const marker = 'proto-pollute-marker-should-not-appear';
  const before = Object.getOwnPropertyNames(Object.prototype);
  const s = serverErrors(400, { error: 'invalid', issues: [{ path: '__proto__', message: marker }] });
  assert.equal(s.fields._, FORM_INVALID.zh);
  assert.equal(Object.prototype.hasOwnProperty.call(s.fields, '__proto__'), false);
  assert.equal(JSON.stringify(s).includes(marker), false);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), before);
  const blank: Record<string, unknown> = {};
  assert.equal(blank[marker], undefined);
  assert.equal(Object.getOwnPropertyNames({}).includes(marker), false);
  const save = specSaveErrors(400, { error: 'invalid', issues: [{ path: '__proto__', message: marker }] });
  assert.equal(save.top, FORM_INVALID.zh);
  assert.deepEqual(save.fields, {});
  assert.equal(JSON.stringify(save).includes(marker), false);
  const mixed = serverErrors(400, { error: 'invalid', issues: [{ path: '__proto__', message: marker }, { path: 'notes', message: marker }] });
  assert.equal(mixed.fields.notes, '最多 2000 个字符');
  assert.equal(mixed.fields._, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(mixed.fields, '__proto__'), false);
  assert.equal(JSON.stringify(mixed).includes(marker), false);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), before);
});
