import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { SpecInput, isHttpsUrl, toRow, publicView, adminView, auditView, isCategoryKey, parseLocale, CATEGORY_KEYS } from '../src/lib/server/specs';
import { categoryMeta } from '../src/lib/seo/categoryMeta';

const full = {
  size: { min: { l: 50, w: 50, h: 20 }, max: { l: 600, w: 400, h: 400 }, unit: 'mm' },
  material: { en: 'Kraft paper', ru: 'Крафт-бумага' },
  moq: { value: 500, unit: 'pcs' },
  sampleFee: { amount: 30, currency: 'USD' },
  leadTime: { min: 10, max: 15, unit: 'day' },
  certifications: [{ name: 'FSC', certNo: 'FSC-C123456' }, { name: 'ISO 9001', url: 'https://example.com/iso.pdf' }],
  tradeTerms: ['FOB', 'EXW'],
  notes: { en: 'Custom sizes on request' },
};
// 模拟数据库行（toRow 的结果 + updatedAt，Json 字段的 DbNull 还原成 null）
function rowOf(input: unknown) {
  const r = toRow(SpecInput.parse(input)) as Record<string, unknown>;
  for (const k of Object.keys(r)) if (r[k] === Prisma.DbNull) r[k] = null;
  return { ...r, updatedAt: new Date('2026-10-13T17:00:00Z') } as never;
}

test('category keys come from categoryMeta', () => {
  assert.deepEqual([...CATEGORY_KEYS], categoryMeta.map((c) => c.key));
  assert.ok(isCategoryKey('gift-boxes'));
  assert.ok(!isCategoryKey('custom-gift-boxes'));
  assert.ok(!isCategoryKey('__proto__'));
});

test('strict schema: unknown keys, wrong units, min>max, duplicate terms rejected', () => {
  assert.ok(SpecInput.safeParse(full).success);
  assert.ok(SpecInput.safeParse({}).success);
  assert.equal(SpecInput.safeParse({ ...full, extra: 1 }).success, false);
  assert.equal(SpecInput.safeParse({ moq: { value: 5, unit: 'kg' } }).success, false);
  assert.equal(SpecInput.safeParse({ moq: { value: 1.5, unit: 'pcs' } }).success, false);
  assert.equal(SpecInput.safeParse({ size: { min: { l: 700, w: 1, h: 1 }, max: { l: 600, w: 1, h: 1 }, unit: 'mm' } }).success, false);
  assert.equal(SpecInput.safeParse({ leadTime: { min: 20, max: 10, unit: 'day' } }).success, false);
  assert.equal(SpecInput.safeParse({ tradeTerms: ['FOB', 'FOB'] }).success, false);
  assert.equal(SpecInput.safeParse({ tradeTerms: ['XYZ'] }).success, false);
  assert.equal(SpecInput.safeParse({ sampleFee: { amount: 10, currency: 'USD', free: true } }).success, false);
  assert.equal(SpecInput.safeParse({ sampleFee: { amount: 10.001, currency: 'USD' } }).success, false);
  assert.equal(SpecInput.safeParse({ materials: { en: 'x' } }).success, false);
});

test('certifications: certNo or url required; url must be https: and <= 2048', () => {
  const c = (x: unknown) => SpecInput.safeParse({ certifications: [x] }).success;
  assert.ok(c({ name: 'FSC', certNo: 'A1' }));
  assert.ok(c({ name: 'FSC', url: 'https://fsc.org/x' }));
  assert.equal(c({ name: 'FSC' }), false);
  for (const u of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'http://fsc.org/x', 'HTTPS//x', 'ftp://x.org', '//fsc.org/x', 'not a url', ' javascript:alert(1)'])
    assert.equal(c({ name: 'FSC', url: u }), false, u);
  assert.equal(c({ name: 'FSC', url: 'https://x.org/' + 'a'.repeat(2048) }), false);
  assert.ok(isHttpsUrl('HTTPS://fsc.org'));
  assert.equal(isHttpsUrl('javascript:alert(1)'), false);
});

test('public view: filled fields only, localized, value+unit shapes, updatedAt', () => {
  const r = rowOf(full);
  const en = publicView('gift-boxes', r, 'en');
  assert.deepEqual(en, {
    category: 'gift-boxes',
    size: { min: { l: 50, w: 50, h: 20 }, max: { l: 600, w: 400, h: 400 }, unit: 'mm' },
    material: 'Kraft paper', moq: { value: 500, unit: 'pcs' }, sampleFee: { amount: 30, currency: 'USD' },
    leadTime: { min: 10, max: 15, unit: 'day' },
    certifications: [{ name: 'FSC', certNo: 'FSC-C123456' }, { name: 'ISO 9001', url: 'https://example.com/iso.pdf' }],
    tradeTerms: ['FOB', 'EXW'], notes: 'Custom sizes on request', updatedAt: '2026-10-13T17:00:00.000Z',
  });
  const ru = publicView('gift-boxes', r, 'ru');
  assert.equal(ru.material, 'Крафт-бумага');
  assert.ok(!('notes' in ru)); // ru 没填就省略
  const sparse = publicView('gift-boxes', rowOf({ moq: { value: 100, unit: 'pcs' }, sampleFee: { free: true }, notes: { en: '' } }), 'en');
  assert.deepEqual(sparse, { category: 'gift-boxes', moq: { value: 100, unit: 'pcs' }, sampleFee: { free: true }, updatedAt: '2026-10-13T17:00:00.000Z' });
  assert.ok(!JSON.stringify(sparse).includes('null'));
  assert.deepEqual(publicView('gift-boxes', rowOf({}), 'en'), { category: 'gift-boxes' });
  assert.deepEqual(publicView('gift-boxes', null, 'en'), { category: 'gift-boxes' });
});

test('public view is a whitelist: extra row columns / audit data never leak', () => {
  const r = { ...(rowOf(full) as object), updatedById: 'user_secret', before: { moq: 1 }, after: { moq: 2 }, meta: { before: 1 }, internal: 'x' } as never;
  const v = publicView('gift-boxes', r, 'en');
  const s = JSON.stringify(v);
  for (const k of ['updatedById', 'user_secret', 'before', 'after', 'meta', 'internal']) assert.ok(!s.includes(k), k);
  // JSON 字段里混入的多余键也不输出
  const dirty = { ...(rowOf(full) as object), sizeMin: { l: 1, w: 1, h: 1, x: 'leak' }, certifications: [{ name: 'A', certNo: '1', secret: 'leak' }] } as never;
  assert.ok(!JSON.stringify(publicView('gift-boxes', dirty, 'en')).includes('leak'));
});

test('admin and audit views: same shape as PUT body, round-trips, audit has no updatedAt', () => {
  const r = rowOf(full);
  const a = adminView('gift-boxes', r);
  const { category: _c, updatedAt: _u, ...body } = a;
  assert.ok(SpecInput.safeParse(body).success);
  assert.deepEqual(rowOf(body), r);
  assert.ok(!('updatedAt' in auditView('gift-boxes', r)));
  assert.equal(adminView('gift-boxes', null).moq, null);
});

test('locale parsing', () => {
  assert.equal(parseLocale(null), 'en');
  assert.equal(parseLocale('ru'), 'ru');
  assert.equal(parseLocale('de'), null);
});
