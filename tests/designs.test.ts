import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesignBody, DESIGN_ID_RE, canonicalFor } from '../src/lib/server/designs';
import { randomId } from '../src/lib/server/security';

const base = { productSlug: 'mailer-box', config: { colors: { body: '#112233' }, size: { length: 200, width: 150, height: 50, unit: 'mm' } } };

test('design body: valid minimal + defaults', () => {
  const r = DesignBody.parse({ ...base, category: 'gift-boxes', config: { ...base.config, logo: { placement: 'lid' } } });
  assert.equal(r.locale, 'en');
  assert.deepEqual(r.config.logo, { placement: 'lid', scale: 1, offset: [0, 0], rotation: 0 });
});

test('design body: rejects unknown fields, bad values, unknown category', () => {
  const bad = [
    { ...base, extra: 1 },
    { ...base, config: { ...base.config, script: '<x>' } },
    { ...base, config: { colors: { body: 'red' } } },
    { ...base, config: { colors: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`c${i}`, '#000000'])) } },
    { ...base, config: { size: { length: 1e9, width: 1, height: 1, unit: 'mm' } } },
    { ...base, config: { camera: { position: [0, 0, Infinity], target: [0, 0, 0] } } },
    { ...base, category: 'nope' },
    { ...base, productSlug: '../x' },
    { ...base, locale: 'de' },
    { ...base, logoUploadId: 'short' },
  ];
  for (const b of bad) assert.equal(DesignBody.safeParse(b).success, false, JSON.stringify(b));
});

test('randomId: 16 chars, alphabet only, no collisions in 20k', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20_000; i++) { const id = randomId(16); assert.ok(DESIGN_ID_RE.test(id)); seen.add(id); }
  assert.equal(seen.size, 20_000);
  assert.ok(DESIGN_ID_RE.test('abcdEFGH23'), 'legacy 10-char ids still accepted');
  assert.ok(!DESIGN_ID_RE.test('abc'));
});

test('canonical: category landing page per locale, fallback to products', () => {
  assert.match(canonicalFor({ locale: 'en', category: 'gift-boxes' }), /\/en\/products\/custom-gift-boxes$/);
  assert.match(canonicalFor({ locale: 'ru', category: 'gift-boxes' }), /\/ru\/products\/podarochnye-korobki$/);
  assert.match(canonicalFor({ locale: 'ru', category: null }), /\/ru\/products$/);
  assert.match(canonicalFor({ locale: 'en', category: 'unknown' }), /\/en\/products$/);
});

import { InquiryItemConfig } from '../src/lib/server/designs';
test('inquiry item config: strict whitelist, wizard shape accepted', () => {
  assert.ok(InquiryItemConfig.safeParse({ size: '30x20x10 cm', material: 'kraft', timeline: '1m' }).success);
  assert.ok(InquiryItemConfig.safeParse({ size: { length: 1, width: 2, height: 3, unit: 'cm' }, colors: { body: '#aabbcc' } }).success);
  for (const bad of [{ evil: 1 }, { material: '<b>' }, { timeline: 'tomorrow' }, { size: 'x'.repeat(201) }, { colors: { body: 'red' } }])
    assert.equal(InquiryItemConfig.safeParse(bad).success, false, JSON.stringify(bad));
});
