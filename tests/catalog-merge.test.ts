import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { createElement } from 'react';

(globalThis as { React?: typeof React }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import type { PrismaClient } from '@prisma/client';
import { products, type Product } from '../src/data/products';
import {
  acceptedCatalogSlugs,
  catalogAssetUrl,
  catalogItemList,
  catalogPosterAlt,
  decorateCatalogProducts,
  mergeCatalog,
  type CatalogModel,
  type CatalogText,
  CATALOG_CATEGORY_KEYS,
  CATALOG_STORAGE_PATH_PREFIXES,
} from '../src/lib/catalog/catalog';
import { createAnalyticsEventRepo } from '../src/lib/server/analytics/event-repo';
import { buildSitemap, categoryPages } from '../src/lib/seo/sitemapEntries';
import ProductGallery from '../src/components/three/ProductGallery';
import { QuoteProvider } from '../src/components/quote/QuoteProvider';

const en = JSON.parse(readFileSync('messages/en.json', 'utf8')) as {
  Products: { alt: string; names: Record<string, string>; desc: Record<string, string>; specs: Record<string, string[]> };
  Quote: Record<string, string>;
};
const ru = JSON.parse(readFileSync('messages/ru.json', 'utf8')) as {
  Products: { alt: string; names: Record<string, string> };
};

const fallback: Product[] = [
  { slug: 'gift-boxes', model: '/models/gift.glb', poster: '/images/posters/gift.webp', animated: true, animationClips: { open: 'Open' }, landing: '/products/custom-gift-boxes' },
  { slug: 'paper-cups', model: '/models/cup.glb', poster: '/images/placeholder.svg' },
];

function model(over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    productSlug: 'other-slug',
    category: 'gift-boxes',
    published: true,
    status: 'READY',
    animated: true,
    slugs: { en: 'custom-gift-boxes', ru: 'podarochnye-korobki' },
    glbUrl: '/api/models/only/glb?v=1',
    posterUrl: '/api/models/only/poster?v=1',
    ...over,
  };
}

function textFor(messages: typeof en): CatalogText {
  return {
    hasName: (slug) => Object.prototype.hasOwnProperty.call(messages.Products.names, slug),
    name: (slug) => messages.Products.names[slug],
    desc: (slug) => messages.Products.desc[slug],
    specs: (slug) => messages.Products.specs[slug],
    alt: (name) => messages.Products.alt.replaceAll('{name}', name),
  };
}

function fill(template: string, name: string): string {
  return template.replaceAll('{name}', name);
}

test('one published model keeps every products.ts category in place', () => {
  const merged = mergeCatalog([model({ category: 'gift-boxes', productSlug: 'not-the-card' })], 'en', products);
  assert.equal(merged.applied, true);
  assert.deepEqual(merged.products.map((item) => item.slug), products.map((item) => item.slug));
  const replaced = merged.products.find((item) => item.slug === 'gift-boxes');
  assert.equal(replaced?.model, '/api/models/only/glb?v=1');
  assert.equal(replaced?.poster, '/api/models/only/poster?v=1');
  for (const local of products) {
    if (local.slug === 'gift-boxes') continue;
    const card = merged.products.find((item) => item.slug === local.slug);
    assert.equal(card?.model, local.model, local.slug);
    assert.equal(card?.poster, local.poster, local.slug);
  }
  assert.equal(merged.products.some((item) => item.slug === 'not-the-card'), false);
});

test('draft, processing, failed and unpublished rows do not replace a category', () => {
  for (const status of ['UPLOADED', 'PROCESSING', 'FAILED']) {
    const merged = mergeCatalog([model({ status, glbUrl: '/api/models/nope/glb' })], 'en', fallback);
    assert.equal(merged.applied, false, status);
    assert.equal(merged.products[0].model, '/models/gift.glb', status);
  }
  const draft = mergeCatalog([model({ published: false, glbUrl: '/api/models/nope/glb' })], 'en', fallback);
  assert.equal(draft.applied, false);
  assert.equal(draft.products[0].model, '/models/gift.glb');
  assert.equal(draft.products[1].model, '/models/cup.glb');
});

test('an invalid category does not fall back to productSlug', () => {
  const merged = mergeCatalog([model({ category: 'Gift Boxes', productSlug: 'paper-cups', glbUrl: '/api/models/sneak/glb' })], 'en', fallback);
  assert.equal(merged.applied, false);
  assert.equal(merged.products[0].model, '/models/gift.glb');
  assert.equal(merged.products[1].model, '/models/cup.glb');
  assert.equal(JSON.stringify(merged.products).includes('/api/models/sneak'), false);
});

test('categoryMeta keys missing from products.ts append in model order', () => {
  const keys = new Set(['future-b', 'future-a']);
  const merged = mergeCatalog([
    model({ category: 'future-b', productSlug: 'row-b', glbUrl: '/api/models/b/glb' }),
    model({ category: 'future-a', productSlug: 'row-a', glbUrl: '/api/models/a/glb' }),
    model({ category: 'future-b', productSlug: 'row-b2', glbUrl: '/api/models/b2/glb' }),
  ], 'ru', fallback, keys);
  assert.deepEqual(merged.products.map((item) => item.slug), ['gift-boxes', 'paper-cups', 'future-b', 'future-a']);
  assert.equal(merged.products[2].model, '/api/models/b/glb');
  assert.equal(merged.products[2].animated, undefined);
  assert.equal(merged.products[2].animationClips, undefined);
  assert.equal(merged.products[2].posterAlt, undefined);
  assert.equal(merged.products[2].landing, undefined);
  assert.equal(merged.products[3].model, '/api/models/a/glb');
});

test('the 3D grid, item list and sitemap omit a key that is not in categoryMeta', () => {
  const orphan = 'orphan-sku';
  const merged = mergeCatalog([
    model({ category: 'gift-boxes', productSlug: 'not-the-card' }),
    model({ category: orphan, productSlug: orphan, glbUrl: '/api/models/orphan/glb', posterUrl: '/api/models/orphan/poster' }),
  ], 'en', products);
  assert.equal(merged.products.some((item) => item.slug === orphan), false);
  const items = decorateCatalogProducts(merged.products, 'en', products, textFor(en));
  const list = JSON.stringify(catalogItemList(items, 'https://example.test/en/products'));
  assert.equal(list.includes(orphan), false);
  assert.equal(list.includes(`/products/${orphan}`), false);
  assert.equal(list.includes('#gift-boxes'), true);
  const sitemap = JSON.stringify(categoryPages()) + JSON.stringify(buildSitemap({
    siteUrl: 'https://example.test',
    locales: ['en', 'ru'],
    defaultLocale: 'en',
    includeCategories: true,
  }));
  assert.equal(sitemap.includes(orphan), false);
  assert.equal(sitemap.includes('/products/custom-gift-boxes'), true);
  const gallery = createElement(ProductGallery, {
    items,
    labels: {
      learnMore: 'Learn more', specsLabel: 'Specs', tap: 'Tap', drag: 'Drag', loading: 'Loading',
      add: 'Add', details: 'Details', done: 'Done', viewsLabel: 'Views',
      views: { closed: 'Closed', open: 'Open', dieline: 'Dieline' },
    },
  });
  const html = renderToStaticMarkup(createElement(NextIntlClientProvider, {
    locale: 'en',
    messages: { Quote: en.Quote },
    children: createElement(QuoteProvider, { children: gallery }),
  }));
  assert.equal(html.includes(orphan), false);
  assert.equal(html.includes(`/products/${orphan}`), false);
  assert.equal(html.includes('id="gift-boxes"'), true);
  assert.equal(html.includes('/api/models/only/poster?v=1'), true);
  assert.equal(html.includes('id="paper-cups"'), true);
  assert.equal(html.includes('id="eco-paper-cups"'), true);
});

test('library glb keeps products.ts motion fields and clears posterAlt when the poster changes', () => {
  const local = products.find((item) => item.slug === 'color-boxes');
  assert.ok(local?.posterAlt);
  const replaced = mergeCatalog([model({
    category: 'color-boxes',
    animated: false,
    posterUrl: '/api/models/color/poster?v=2',
    glbUrl: '/api/models/color/glb?v=2',
    slugs: { en: 'evil-slug', ru: 'evil-slug' },
  })], 'en', products).products.find((item) => item.slug === 'color-boxes');
  assert.ok(replaced);
  assert.equal(replaced.animated, undefined);
  assert.equal(replaced.animationClips, undefined);
  assert.equal(replaced.landing, undefined);
  assert.equal(replaced.posterAlt, undefined);
  assert.equal(replaced.poster, '/api/models/color/poster?v=2');
  const enName = en.Products.names['color-boxes'];
  const ruName = ru.Products.names['color-boxes'];
  const enAlt = catalogPosterAlt({ slug: 'color-boxes', poster: replaced.poster, local, locale: 'en', categoryName: enName, fallbackAlt: fill(en.Products.alt, enName) });
  const ruAlt = catalogPosterAlt({ slug: 'color-boxes', poster: replaced.poster, local, locale: 'ru', categoryName: ruName, fallbackAlt: fill(ru.Products.alt, ruName) });
  assert.equal(enAlt, fill(en.Products.alt, enName));
  assert.equal(ruAlt, fill(ru.Products.alt, ruName));
  assert.equal(enAlt.includes(enName), true);
  assert.equal(ruAlt.includes(ruName), true);
  assert.notEqual(enAlt, '');
  assert.notEqual(ruAlt, '');
  assert.equal(enAlt.includes(local.posterAlt.en), false);
  assert.equal(ruAlt.includes(local.posterAlt.ru), false);
  const kept = mergeCatalog([model({ category: 'color-boxes', posterUrl: null, glbUrl: '/api/models/color/glb?v=3' })], 'en', [local]).products[0];
  assert.equal(kept.poster, local.poster);
  assert.deepEqual(kept.posterAlt, local.posterAlt);
  assert.equal(catalogPosterAlt({
    slug: 'color-boxes', poster: kept.poster, local, locale: 'en', categoryName: enName, fallbackAlt: '',
  }), local.posterAlt.en);
  const blank = catalogPosterAlt({
    slug: 'color-boxes', poster: replaced.poster, local, locale: 'ru', categoryName: ruName, fallbackAlt: '   ',
  });
  assert.equal(blank, `${ruName}: упаковка на заказ от PackJoyU`);
  assert.equal(blank.includes(ruName), true);
});

test('motion fields come from the same products.ts key, not from the database row', () => {
  const local: Product = {
    slug: 'gift-boxes', model: '/models/gift.glb', poster: '/images/posters/gift.webp',
    animated: true, animationClips: { open: 'Open' }, landing: '/products/custom-gift-boxes',
  };
  const card = mergeCatalog([model({ animated: false, posterUrl: null })], 'en', [local]).products[0];
  assert.equal(card.model, '/api/models/only/glb?v=1');
  assert.equal(card.animated, true);
  assert.deepEqual(card.animationClips, { open: 'Open' });
  assert.equal(card.landing, '/products/custom-gift-boxes');
  const plain = mergeCatalog([model({ category: 'paper-cups', animated: true, posterUrl: null })], 'en', fallback).products[1];
  assert.equal(plain.animated, undefined);
  assert.equal(plain.animationClips, undefined);
  assert.equal(plain.landing, undefined);
});

test('unsafe glb and poster URLs fall back, and an extra key with no fallback stays hidden', () => {
  const bad = [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,x',
    'vbscript:msg',
    '//evil.example/x',
    'https://evil.example/api/models/x',
    'http://evil.example/media/a.webp',
    '/\\evil.example/x',
    '/../secret.glb',
    '/%2e%2e/secret.glb',
    '/%2f%2fevil.example/x',
  ];
  for (const url of bad) {
    assert.equal(catalogAssetUrl(url), undefined, url);
    const merged = mergeCatalog([model({ glbUrl: url, posterUrl: url })], 'en', fallback);
    assert.equal(merged.products[0].model, '/models/gift.glb', url);
    assert.equal(merged.products[0].poster, '/images/posters/gift.webp', url);
  }
  for (const url of ['/api/models/abc/glb?v=1', '/media/abcdefghijklmnopqrstuvwx-800.webp', '/models/gift.glb', '/images/posters/gift.webp']) {
    assert.equal(catalogAssetUrl(url), url, url);
  }
  for (const prefix of CATALOG_STORAGE_PATH_PREFIXES) assert.equal(catalogAssetUrl(`${prefix}file?v=1`), `${prefix}file?v=1`);
  const keys = new Set(['future-mailers']);
  const badGlb = mergeCatalog([
    model({ category: 'future-mailers', glbUrl: 'javascript:alert(1)', posterUrl: '/api/models/ok/poster' }),
  ], 'en', fallback, keys);
  const badPoster = mergeCatalog([
    model({ category: 'future-mailers', glbUrl: '/api/models/ok/glb', posterUrl: 'https://evil.example/p.png' }),
  ], 'en', fallback, keys);
  assert.equal(badGlb.products.some((item) => item.slug === 'future-mailers'), false);
  assert.equal(badPoster.products.some((item) => item.slug === 'future-mailers'), false);
  assert.equal(JSON.stringify(badGlb.products).includes('javascript:'), false);
  assert.equal(JSON.stringify(badPoster.products).includes('evil.example'), false);
});

test('a category that differs from productSlug is the key both the grid and analytics accept', async () => {
  const extra = 'future-mailers';
  const keys = new Set<string>([...CATALOG_CATEGORY_KEYS, extra]);
  const rows: CatalogModel[] = [
    model({ category: 'gift-boxes', productSlug: 'not-the-card' }),
    model({ category: extra, productSlug: 'row-slug', glbUrl: '/api/models/extra/glb', posterUrl: null }),
    model({ category: 'orphan-sku', productSlug: 'orphan-sku', glbUrl: '/api/models/orphan/glb' }),
    model({ category: 'paper-cups', productSlug: 'paper-cups', published: false }),
    model({ category: 'wine-boxes', productSlug: 'wine-boxes', status: 'PROCESSING' }),
    model({ category: 'Nope', productSlug: 'gift-cards', glbUrl: '/api/models/nope/glb' }),
  ];
  const visible = mergeCatalog(rows, 'en', products, keys).products.map((item) => item.slug);
  const accepted = acceptedCatalogSlugs(products.map((item) => item.slug), rows, keys);
  assert.deepEqual(new Set(visible), accepted);
  assert.equal(visible.includes('gift-boxes'), true);
  assert.equal(visible.includes(extra), true);
  assert.equal(visible.at(-1), extra);
  assert.equal(visible.includes('not-the-card'), false);
  assert.equal(visible.includes('row-slug'), false);
  assert.equal(visible.includes('orphan-sku'), false);
  assert.equal(accepted.has('orphan-sku'), false);
  assert.equal(accepted.has('not-the-card'), false);
  const calls: Array<{ where: { category?: { in: string[] }; productSlug?: { in: string[] }; published: boolean; status: string } }> = [];
  const db = {
    model3D: {
      findMany: async (args: { where: { category: { in: string[] }; published: boolean; status: string } }) => {
        calls.push(args);
        const wanted = new Set(args.where.category.in);
        return rows.filter((row) => row.published && row.status === 'READY' && wanted.has(row.category) && CATALOG_CATEGORY_KEYS.has(row.category)).map((row) => ({ category: row.category }));
      },
    },
  };
  const repo = createAnalyticsEventRepo(db as unknown as PrismaClient);
  const published = await repo.publishedSlugs(['gift-boxes', 'not-the-card', 'orphan-sku', 'Nope']);
  assert.deepEqual([...published], ['gift-boxes']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where.category?.in, ['gift-boxes']);
  assert.equal(calls[0].where.published, true);
  assert.equal(calls[0].where.status, 'READY');
  assert.equal(calls[0].where.productSlug, undefined);
  assert.deepEqual([...(await repo.publishedSlugs(['orphan-sku', 'not-the-card']))], []);
});

test('acceptedCatalogSlugs accepts a published READY key only when categoryKeys lists it', () => {
  const listed = 'future-mailers';
  const unlisted = 'orphan-sku';
  const draft = 'draft-mailers';
  const processing = 'processing-mailers';
  const keys = new Set([listed, draft, processing]);
  const accepted = acceptedCatalogSlugs(['gift-cards'], [
    { category: listed, published: true, status: 'READY' },
    { category: unlisted, published: true, status: 'READY' },
    { category: draft, published: false, status: 'READY' },
    { category: processing, published: true, status: 'PROCESSING' },
  ], keys);
  assert.equal(accepted.has(listed), true);
  assert.equal(accepted.has('gift-cards'), true);
  assert.equal(accepted.has(unlisted), false);
  assert.equal(accepted.has(draft), false);
  assert.equal(accepted.has(processing), false);
});
