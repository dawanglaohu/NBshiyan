import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isCatalogSelfAnchor } from '../src/components/three/ProductGallery';
import { catalogItemList } from '../src/lib/catalog/catalog';
import { renderCatalogCard } from './product-card-markup';

const desc = JSON.parse(readFileSync('messages/en.json', 'utf8')).Products.desc['corrugated-boxes'] as string;

test('self anchors are the unpublished category href, page paths are not', () => {
  assert.equal(isCatalogSelfAnchor('#corrugated-boxes'), true);
  assert.equal(isCatalogSelfAnchor('/products#corrugated-boxes'), true);
  assert.equal(isCatalogSelfAnchor('/en/products#corrugated-boxes'), true);
  assert.equal(isCatalogSelfAnchor('/products/custom-corrugated-boxes'), false);
  assert.equal(isCatalogSelfAnchor('/ru/products/gofrokorobki'), false);
  assert.equal(isCatalogSelfAnchor('/products/custom-corrugated-boxes#details'), false);
});

test('unpublished href renders a plain heading and no learn-more control', () => {
  for (const html of [renderCatalogCard('/products#corrugated-boxes'), renderCatalogCard(undefined)]) {
    assert.equal(html.includes('product-name-link'), false);
    assert.equal(html.includes('category-link'), false);
    assert.equal(html.includes('Learn more'), false);
    assert.match(html, /<h2>Corrugated Boxes<\/h2>/);
    assert.equal(html.includes('<h2><a'), false);
    const h2 = html.indexOf('</h2>');
    const descAt = html.indexOf('class="desc"');
    const specsAt = html.indexOf('class="specs"');
    assert.ok(h2 >= 0 && descAt > h2 && specsAt > descAt);
    assert.equal((html.match(/class="desc"/g) ?? []).length, 1);
    assert.ok(html.includes(`<p class="desc">${desc}</p>`));
  }
});

test('published href keeps the heading link and learn more, and the desc matches JSON-LD', () => {
  const html = renderCatalogCard('/products/custom-corrugated-boxes');
  assert.equal((html.match(/data-testid="product-name-link"/g) ?? []).length, 1);
  assert.equal((html.match(/data-testid="category-link"/g) ?? []).length, 1);
  assert.match(html, /href="\/en\/products\/custom-corrugated-boxes"/);
  assert.equal(html.includes('/products#corrugated-boxes'), false);
  assert.ok(html.includes('Learn more'));
  assert.ok(html.includes(`<p class="desc">${desc}</p>`));
  const listed = catalogItemList([{ slug: 'corrugated-boxes', name: 'Corrugated Boxes', desc }], 'https://example.test/en/products');
  assert.equal(listed[0].description, desc);
  assert.ok(html.includes(listed[0].description!));
});

test('CatalogLink no longer has a hash-only branch', () => {
  const src = readFileSync('src/components/three/ProductGallery.tsx', 'utf8');
  const start = src.indexOf('function CatalogLink');
  const end = src.indexOf('type Labels');
  const fn = src.slice(start, end);
  assert.equal(fn.includes("startsWith('#')"), false);
  assert.equal(fn.includes('<a '), false);
  assert.match(src, /isCatalogSelfAnchor/);
});
