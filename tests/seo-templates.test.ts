import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTitle, buildDescription, truncateAtWord, clean, categorySeo, articleSeo, TITLE_MAX, DESC_MAX } from '../src/lib/seo/templates';
import { breadcrumbJsonLd, categoryBreadcrumb, articleBreadcrumb } from '../src/lib/seo/breadcrumbs';
import { categoryMeta } from '../src/lib/seo/categoryMeta';
import { seoMockEnabled, categoryPagesLive } from '../src/lib/seo/mock';
import { MOCK_ARTICLES } from '../src/lib/server/sanityMock';

const SITE = 'https://packjoyu.com';

test('clean: collapses whitespace, rejects {{ placeholders and empties', () => {
  assert.equal(clean('  a \n b '), 'a b');
  assert.equal(clean('Intro {{待Ryan确认}}'), undefined);
  assert.equal(clean('   '), undefined); assert.equal(clean(null), undefined);
});

test('truncateAtWord: word boundary, ellipsis, within max', () => {
  const s = 'alpha beta gamma delta epsilon';
  const t = truncateAtWord(s, 20);
  assert.ok(t.length <= 20); assert.ok(t.endsWith('…')); assert.equal(t, 'alpha beta gamma…');
  assert.equal(truncateAtWord('short', 20), 'short');
  assert.equal(truncateAtWord('x'.repeat(50), 10).length, 10); // single long word: hard cut
  assert.equal(truncateAtWord('Привет мир, как дела сегодня', 16), 'Привет мир, как…');
});

test('buildTitle: editor SEO title in range wins; brand appended when it fits', () => {
  assert.equal(buildTitle({ name: 'X', seoTitle: 'Custom Gift Boxes Manufacturer | PackJoyU', fallback: 'Products' }), 'Custom Gift Boxes Manufacturer | PackJoyU');
  assert.equal(buildTitle({ name: 'X', seoTitle: 'How to choose a mailer box size', fallback: 'Articles' }), 'How to choose a mailer box size | PackJoyU');
});

test('buildTitle: falls back to "<name> | PackJoyU", truncates long names, never exceeds 60', () => {
  assert.equal(buildTitle({ name: 'Gift Boxes', fallback: 'Products' }), 'Gift Boxes | PackJoyU');
  const long = buildTitle({ name: 'A Very Long Article Title That Goes On And On Well Past Sixty Characters', fallback: 'Articles' });
  assert.ok(long.length <= TITLE_MAX); assert.ok(long.endsWith('… | PackJoyU'));
  assert.equal(buildTitle({ name: '{{待Ryan确认}}', fallback: 'Статьи' }), 'Статьи | PackJoyU');
  // out-of-range SEO title is ignored rather than cut mid-brand
  assert.equal(buildTitle({ name: 'Gift Boxes', seoTitle: 'x'.repeat(80), fallback: 'Products' }), 'Gift Boxes | PackJoyU');
});

test('buildDescription: first usable source, skips placeholders, ≤160 at word boundary', () => {
  assert.equal(buildDescription(undefined, '{{x}}', 'Real excerpt'), 'Real excerpt');
  assert.equal(buildDescription(null, ''), undefined);
  const d = buildDescription('word '.repeat(60));
  assert.ok(d!.length <= DESC_MAX); assert.ok(d!.endsWith('word…'));
});

test('category templates: every category en+ru gets title ≤60 and description 70–160 from existing meta only', () => {
  for (const c of categoryMeta) for (const l of ['en', 'ru'] as const) {
    const s = categorySeo({ locale: l, name: c.key, meta: c[l] });
    assert.ok(s.title.length >= 30 && s.title.length <= 60, `${c.key}/${l} title ${s.title.length}`);
    assert.ok(s.description && s.description.length >= 70 && s.description.length <= 160, `${c.key}/${l} desc`);
    assert.ok(c[l].description.startsWith(s.description!.replace(/…$/, '')), 'description is taken from categoryMeta, not invented');
  }
});

test('article templates use seo fields, then title/excerpt', () => {
  const a = articleSeo({ locale: 'en', title: 'Mailer box sizes explained for small shops', excerpt: 'e'.repeat(10) });
  assert.equal(a.title, 'Mailer box sizes explained for small shops | PackJoyU');
  const b = articleSeo({ locale: 'ru', title: 'Т', excerpt: 'Отрывок', seo: { description: 'SEO описание' } });
  assert.equal(b.description, 'SEO описание');
});

test('breadcrumbJsonLd: absolute same-site URLs, positions 1..n, rejects off-site paths', () => {
  const j = breadcrumbJsonLd(SITE, 'en', [{ name: 'Home', path: '/' }, { name: 'Articles', path: '/articles' }]);
  assert.equal(j['@type'], 'BreadcrumbList');
  assert.deepEqual(j.itemListElement.map((i) => [i.position, i.item]), [[1, `${SITE}/en`], [2, `${SITE}/en/articles`]]);
  assert.throws(() => breadcrumbJsonLd(SITE, 'en', [{ name: 'x', path: '//evil.com/x' }]));
  assert.throws(() => breadcrumbJsonLd(SITE, 'en', [{ name: 'x', path: 'https://evil.com' }]));
});

test('categoryBreadcrumb uses categoryHref (encoded, per-locale slug)', () => {
  const j = categoryBreadcrumb(SITE, 'ru', 'gift-boxes', 'Подарочные коробки', true);
  assert.deepEqual(j.itemListElement.map((i) => i.item), [`${SITE}/ru`, `${SITE}/ru/products`, `${SITE}/ru/products/podarochnye-korobki`]);
  assert.equal(j.itemListElement[1].name, 'Продукция');
  assert.equal(categoryBreadcrumb(SITE, 'en', 'paper-cups', 'Cups', true).itemListElement[2].item, `${SITE}/en/products/custom-paper-cups`);
});

test('articleBreadcrumb follows /{locale}/articles/{slug}', () => {
  const j = articleBreadcrumb(SITE, 'en', 'my-post', 'My post');
  assert.deepEqual(j.itemListElement.map((i) => i.item), [`${SITE}/en`, `${SITE}/en/articles`, `${SITE}/en/articles/my-post`]);
});

test('mock mode is local-only and off in production', () => {
  assert.equal(seoMockEnabled({}), false);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1' }), true);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', VERCEL_ENV: 'production' }), false);
  assert.equal(categoryPagesLive({ SEO_AUDIT_MOCK: '1', VERCEL_ENV: 'production' }), false);
  for (const a of MOCK_ARTICLES) for (const l of ['en', 'ru'] as const) assert.match(a.slug[l], /^[a-z0-9-]{1,96}$/);
});
