import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProductJsonLd } from '../src/lib/seo/jsonld/product';
import { buildFaqJsonLd } from '../src/lib/seo/jsonld/faq';
import { categoryMeta } from '../src/lib/seo/categoryMeta';

test('product: all 12 categories, EN/RU, no commercial fields by default', () => {
  assert.equal(categoryMeta.length, 12);
  for (const c of categoryMeta) for (const l of ['en', 'ru'] as const) {
    const ld = buildProductJsonLd(c.key, l);
    assert.equal(ld['@type'], 'Product');
    assert.ok(String(ld.url).endsWith(`/${l}/products/${c[l].slug}`));
    assert.equal(ld.description, c[l].description);
    assert.ok(!String(ld.name).includes('PackJoyU'));
    for (const f of ['offers', 'aggregateRating', 'review', 'additionalProperty', 'image', 'sku']) assert.ok(!(f in ld), f);
  }
});

test('product: optional real data is emitted only when given', () => {
  const ld = buildProductJsonLd('wine-boxes', 'en', {
    images: ['/posters/custom-wine-boxes.webp'], specs: [{ name: 'MOQ', value: '500' }],
  });
  assert.ok(String((ld.image as string[])[0]).startsWith('http'));
  assert.equal((ld.additionalProperty as unknown[]).length, 1);
  assert.ok(!('offers' in ld));
});

test('product: unknown key throws', () => {
  assert.throws(() => buildProductJsonLd('nope', 'en'));
});

test('faq: disabled by default, gated on enabled + no TBD', () => {
  const items = [{ question: 'Q?', answer: 'A.' }];
  assert.equal(buildFaqJsonLd(items), null);
  assert.equal(buildFaqJsonLd([{ question: 'Q?', answer: 'MOQ: TBD' }], { enabled: true }), null);
  const ld = buildFaqJsonLd(items, { enabled: true })!;
  assert.equal(ld['@type'], 'FAQPage');
  assert.equal(ld.mainEntity[0].acceptedAnswer.text, 'A.');
});
