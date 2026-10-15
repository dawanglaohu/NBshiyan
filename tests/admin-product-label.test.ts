import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_LABEL } from '../src/components/admin/format';
import { products } from '../src/data/products';
import { categoryMeta } from '../src/lib/seo/categoryMeta';

test('every product / category slug has an admin label, and no stale keys', () => {
  const slugs = new Set([...products.map((p) => p.slug), ...categoryMeta.map((c) => c.key)]);
  for (const s of slugs) assert.ok(PRODUCT_LABEL[s], `missing admin label: ${s}`);
  for (const k of Object.keys(PRODUCT_LABEL)) assert.ok(slugs.has(k), `stale admin label key: ${k}`);
});
