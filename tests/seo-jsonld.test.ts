import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProductJsonLd, safeCertUrl } from '../src/lib/seo/jsonld/product';
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
    images: ['/posters/custom-wine-boxes.c087d1e2.webp'],
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

test('product: images are https-only (relative resolved, http dropped)', () => {
  const ld = buildProductJsonLd('wine-boxes', 'en', {
    images: ['/posters/a.webp', 'http://example.com/b.jpg', 'https://cdn.sanity.io/images/p/d/c.jpg', 'javascript:alert(1)'],
  }) as Record<string, unknown>;
  const imgs = ld.image as string[];
  assert.equal(imgs.length, 2);
  assert.ok(imgs[0].endsWith('/posters/a.webp'));
  assert.equal(imgs[1], 'https://cdn.sanity.io/images/p/d/c.jpg');
});

test('product: site-relative images must stay on the site origin', () => {
  const ld = buildProductJsonLd('wine-boxes', 'en', {
    images: ['//evil.com/x.jpg', '/\\evil.com/x.jpg', '\\\\evil.com/x.jpg', '/posters/ok.webp'],
  }) as Record<string, unknown>;
  const imgs = ld.image as string[];
  assert.equal(imgs.length, 1);
  assert.ok(imgs[0].endsWith('/posters/ok.webp'));
  assert.ok(imgs.every((u) => !u.includes('evil.com')));
});

test('product: same-origin protocol-relative images reject credentials', async () => {
  const { SITE_URL } = await import('../src/lib/site');
  const site = new URL(SITE_URL);
  const ld = buildProductJsonLd('wine-boxes', 'en', {
    images: [
      `//user:pw@${site.host}/x.jpg`,
      `//user@${site.host}/x.jpg`,
      `/\\user:pw@${site.host}/x.jpg`,
      `\\\\user:pw@${site.host}/x.jpg`,
      `//${site.host}/posters/ok.webp`,
    ],
  });
  assert.deepEqual(ld.image, [`${site.origin}/posters/ok.webp`]);
});

test('product: absolute images limited to site + cdn.sanity.io, no credentials', async () => {
  const { SITE_URL } = await import('../src/lib/site');
  const site = new URL(SITE_URL);
  const ld = buildProductJsonLd('wine-boxes', 'en', {
    images: [
      'https:evil.com',
      'https://packjoyu.com@evil.com/x',
      'https://evil.com/x.jpg',
      `${site.protocol}//user:pw@${site.host}/x.jpg`,
      'https://user:pw@cdn.sanity.io/x.jpg',
      'http://cdn.sanity.io/x.jpg',
      `${SITE_URL}/posters/a b.webp`,
      'https://CDN.SANITY.IO/images/p/d/x.jpg',
    ],
  }) as Record<string, unknown>;
  const imgs = ld.image as string[];
  assert.deepEqual(imgs, [`${site.origin}/posters/a%20b.webp`, 'https://cdn.sanity.io/images/p/d/x.jpg']);
  assert.ok(imgs.every((u) => !u.includes('evil.com') && !u.includes('@')));
});

test('cert url: https only, no credentials, normalized href', () => {
  assert.equal(safeCertUrl('https://X.org/c'), 'https://x.org/c');
  // WHATWG URL parsing normalizes 'https:evil.com' to a real https host; any issuer domain is allowed
  assert.equal(safeCertUrl('https:evil.com'), 'https://evil.com/');
  for (const bad of ['https://user:pw@x.org/c', 'https://user@x.org/c', 'http://x.org', 'javascript:alert(1)', '/certs/fsc.pdf', 'certs/fsc', '', undefined]) {
    assert.equal(safeCertUrl(bad as string | undefined), undefined, String(bad));
  }
  const ld = buildProductJsonLd('wine-boxes', 'en', { certifications: [
    { name: 'A', url: 'https://user:pw@x.org/c' }, { name: 'B', url: 'http://x.org' },
    { name: 'C', url: 'javascript:alert(1)' }, { name: 'D', url: '/c.pdf' }, { name: 'E', url: 'https://Issuer.org/c?id=1' },
  ] });
  assert.deepEqual(ld.hasCertification, [{ '@type': 'Certification', name: 'E', url: 'https://issuer.org/c?id=1' }]);
});
