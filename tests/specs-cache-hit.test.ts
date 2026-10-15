import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, type CategorySpec } from '@prisma/client';
import { publicView, adminView } from '../src/lib/server/specs';
import { reviveSpecRow } from '../src/lib/server/specs-public';

// #239：unstable_cache 命中时返回的是 JSON 往返后的行（Date/Decimal 变字符串）
const fresh: CategorySpec = {
  category: 'wine-boxes', sizeMin: null, sizeMax: null, material: { en: 'Kraft', ru: 'Крафт' }, moq: 800,
  sampleFeeAmount: new Prisma.Decimal('30.50'), sampleFeeCurrency: 'USD', sampleFree: null,
  leadTimeDaysMin: null, leadTimeDaysMax: null, certifications: null, tradeTerms: [], notes: null, updatedById: null,
  updatedAt: new Date('2026-10-13T17:00:00Z'),
} as CategorySpec;
const cacheHit = () => JSON.parse(JSON.stringify(fresh)) as CategorySpec;

test('cache-hit row (JSON round-trip) gives the same public/admin view as a fresh row', () => {
  const revived = reviveSpecRow(cacheHit());
  assert.ok(revived.updatedAt instanceof Date);
  assert.ok(Prisma.Decimal.isDecimal(revived.sampleFeeAmount));
  assert.equal(revived.sampleFeeAmount!.toFixed(2), '30.50');
  for (const locale of ['en', 'ru'] as const) assert.deepEqual(publicView('wine-boxes', revived, locale), publicView('wine-boxes', fresh, locale));
  assert.deepEqual(adminView('wine-boxes', revived), adminView('wine-boxes', fresh));
  assert.equal(publicView('wine-boxes', revived, 'en').updatedAt, '2026-10-13T17:00:00.000Z');
});

test('reviveSpecRow keeps null sampleFeeAmount and is idempotent on fresh rows', () => {
  assert.equal(reviveSpecRow({ ...cacheHit(), sampleFeeAmount: null }).sampleFeeAmount, null);
  assert.deepEqual(publicView('wine-boxes', reviveSpecRow(fresh), 'ru'), publicView('wine-boxes', fresh, 'ru'));
});
