import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentSlugSource, slugifyContent } from '../src/lib/seo/contentSlug';
import { schemaTypes } from '../sanity/schemas/index';

test('de folds umlauts and ß; es and fr only strip accents', () => {
  assert.equal(slugifyContent('ÄÖÜß', 'de'), 'aeoeuess');
  assert.equal(slugifyContent('äöüẞ', 'de'), 'aeoeuess');
  assert.equal(slugifyContent('Übergröße', 'de'), 'uebergroesse');
  assert.equal(slugifyContent('Straße', 'de'), 'strasse');
  assert.equal(slugifyContent('España', 'es'), 'espana');
  assert.equal(slugifyContent('Niño', 'es'), 'nino');
  assert.equal(slugifyContent('Français', 'fr'), 'francais');
  assert.equal(slugifyContent('Çàôü', 'fr'), 'caou');
});

test('blank locale title falls back to title.en', () => {
  assert.equal(contentSlugSource({ title: { es: '', en: 'Paper Cups' } }, 'es'), 'Paper Cups');
  assert.equal(contentSlugSource({ title: { es: '   ', en: 'Paper Cups' } }, 'es'), 'Paper Cups');
  assert.equal(contentSlugSource({ title: { fr: '\n\t', en: 'Boxes' } }, 'fr'), 'Boxes');
  assert.equal(contentSlugSource({ title: { de: 'Tassen', en: 'Cups' } }, 'de'), 'Tassen');
  assert.equal(contentSlugSource({ title: { en: 'Only English' } }, 'de'), 'Only English');
  assert.equal(contentSlugSource({ title: { es: 'Niño', en: 'Child' } }, 'es'), 'Niño');
});

test('hyphens collapse and trim; length stops at 96 without a trailing hyphen', () => {
  assert.equal(slugifyContent(' -- Hello --- World!! -- ', 'es'), 'hello-world');
  assert.equal(slugifyContent('---', 'de'), '');
  assert.equal(slugifyContent('a'.repeat(200), 'fr'), 'a'.repeat(96));
  const cut = `${'a'.repeat(95)} ${'z'.repeat(20)}`;
  assert.equal(slugifyContent(cut, 'de'), 'a'.repeat(95));
  assert.equal(slugifyContent(cut, 'de').endsWith('-'), false);
});

test('es de fr schema slugs use the locale title; en and ru stay on title.en', () => {
  const product = schemaTypes.find((doc) => doc.name === 'product');
  assert.ok(product);
  const slug = (product.fields as { name: string; fields?: { name: string; options?: { source?: unknown; maxLength?: number; slugify?: (input: string) => string } }[] }[])
    .find((field) => field.name === 'slug');
  assert.ok(slug?.fields);
  for (const field of slug.fields) {
    const options = field.options;
    assert.ok(options);
    assert.equal(options.maxLength, 96);
    if (field.name === 'en' || field.name === 'ru') {
      assert.equal(options.source, 'title.en');
      assert.equal(options.slugify, undefined);
      continue;
    }
    assert.equal(typeof options.source, 'function');
    assert.equal(typeof options.slugify, 'function');
    const source = options.source as (doc: unknown) => string;
    assert.equal(source({ title: { [field.name]: '   ', en: 'Paper Cups' } }), 'Paper Cups');
    assert.equal(source({ title: { [field.name]: 'Niño', en: 'Child' } }), 'Niño');
    assert.equal(options.slugify!('Größe'), slugifyContent('Größe', field.name));
  }
});
