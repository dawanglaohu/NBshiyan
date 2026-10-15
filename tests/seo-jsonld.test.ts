import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProductJsonLd } from '../src/lib/seo/jsonld/product';
import { buildFaqJsonLd } from '../src/lib/seo/jsonld/faq';
import { categoryMeta } from '../src/lib/seo/categoryMeta';

test('product: all 11 categories, EN/RU, no commercial fields by default', () => {
  assert.equal(categoryMeta.length, 11);
  for (const c of categoryMeta) for (const l of ['en', 'ru'] as const) {
    const ld = buildProductJsonLd(c.key, l);
    assert.equal(ld['@type'], 'Product');
    assert.ok(String(ld.url).endsWith(`/${l}/products/${c[l].slug}`));
    assert.equal(ld.description, c[l].description);
    assert.ok(!String(ld.name).includes('PackJoyU'));
    assert.ok(!('inLanguage' in ld));
    for (const f of ['offers', 'aggregateRating', 'review', 'additionalProperty', 'image', 'sku', 'material', 'hasCertification']) assert.ok(!(f in ld), f);
  }
});

test('product: optional real data is emitted only when given', () => {
  const ld = buildProductJsonLd('wine-boxes', 'ru', {
    images: ['/posters/custom-wine-boxes.webp'],
    specs: {
      moq: { value: 500, unit: 'pcs' }, material: 'Крафт-бумага',
      size: { min: { l: 50, w: 50, h: 20 }, max: { l: 600, w: 400, h: 400 }, unit: 'mm' },
    },
    certifications: [
      { name: 'FSC', certNo: 'FSC-C1', url: 'https://example.com/fsc' },
      { name: 'ISO 9001', certNo: 'X1' },
      { name: 'Bad', url: 'http://example.com' },
      { name: 'JS', url: 'javascript:alert(1)' },
    ],
  });
  assert.ok(String((ld.image as string[])[0]).startsWith('http'));
  assert.equal(ld.material, 'Крафт-бумага');
  const props = ld.additionalProperty as Array<Record<string, unknown>>;
  assert.equal(props.length, 4);
  assert.deepEqual(props[0].value, { '@type': 'QuantitativeValue', minValue: 500, unitCode: 'H87' });
  assert.deepEqual(props[1].value, { '@type': 'QuantitativeValue', unitCode: 'MMT', minValue: 50, maxValue: 600 });
  assert.equal(props[3].name, 'Height');
  const certs = ld.hasCertification as Array<Record<string, unknown>>;
  assert.equal(certs.length, 1);
  assert.deepEqual(certs[0], { '@type': 'Certification', name: 'FSC', url: 'https://example.com/fsc', certificationIdentification: 'FSC-C1' });
  for (const f of ['offers', 'aggregateRating', 'review', 'inLanguage']) assert.ok(!(f in ld), f);
  assert.ok(!JSON.stringify(ld).includes('TBD'));
});

test('product: empty specs/certs are omitted entirely', () => {
  const ld = buildProductJsonLd('wine-boxes', 'en', { specs: { material: '  ' }, certifications: [{ name: 'ISO', certNo: '1' }] });
  for (const f of ['material', 'additionalProperty', 'hasCertification']) assert.ok(!(f in ld), f);
  const half = buildProductJsonLd('wine-boxes', 'en', { specs: { size: { max: { l: 1, w: 2, h: 3 }, unit: 'mm' } } });
  assert.deepEqual((half.additionalProperty as Array<Record<string, unknown>>)[2].value, { '@type': 'QuantitativeValue', unitCode: 'MMT', maxValue: 3 });
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

test('product JSON-LD: brand only, no manufacturer claim', () => {
  const ld = buildProductJsonLd('gift-boxes', 'en');
  assert.ok(!('manufacturer' in ld));
  assert.deepEqual(ld.brand, { '@type': 'Brand', name: 'PackJoyU' });
});
