import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyForm, fromView, toBody, isHttpsUrl, newCertRow, serverErrors, type SpecForm } from '../src/lib/admin/spec-form';
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
  assert.equal(serverErrors(401, {}).message, '保存失败（http_401）');
  const s = serverErrors(400, { error: 'invalid', issues: [{ path: 'certifications.0.url', message: 'https_url_required' }, { path: '', message: 'x' }, { bogus: 1 }] });
  assert.equal(s.message, '服务器校验未通过');
  assert.deepEqual(s.fields, { 'certifications.0.url': 'https_url_required', _: 'x' });
  assert.equal(serverErrors(500, 'not json').message, '保存失败（http_500）');
  const outage = '服务暂时不可用。数据库连接出现问题，你的登录状态仍然有效';
  assert.equal(serverErrors(503, { error: 'service_unavailable' }).message, outage);
  assert.equal(serverErrors(503, {}).message, outage);
  assert.equal(serverErrors(503, { error: 'service_unavailable' }).message.includes('service_unavailable'), false);
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
});
