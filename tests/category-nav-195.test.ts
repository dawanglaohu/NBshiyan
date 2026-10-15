import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { categoryProducts, RETIRED_CATEGORIES } from '../src/data/categories';

test('#195: nav/entry categories are 11, no eco-paper-cups', () => {
  assert.equal(categoryProducts.length, 11);
  assert.ok(!categoryProducts.some((p) => p.slug === 'eco-paper-cups'));
  assert.ok(RETIRED_CATEGORIES.has('eco-paper-cups'));
});

test('#195: footer nav and home entry tiles use filtered list', () => {
  for (const f of ['src/components/layout/SiteFooter.tsx', 'src/app/[locale]/page.tsx']) {
    const s = readFileSync(f, 'utf8');
    assert.match(s, /from '@\/data\/categories'/, f);
    assert.doesNotMatch(s, /eco-paper-cups|ekologichnye-stakany/, f);
  }
});
