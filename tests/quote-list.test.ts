import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addQuoteItem, parseQuoteItems, QUOTE_MAX_ITEMS, isOverQuoteLimit as over } from '../src/lib/quote/list';

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `p-${i}` }));

test('cap is 20, matching the server', () => assert.equal(QUOTE_MAX_ITEMS, 20));

test('adds until 20, then blocks the 21st without dropping anything', () => {
  const r19 = addQuoteItem(many(19), 'x');
  assert.equal(r19.status, 'added'); assert.equal(r19.items.length, 20);
  const r21 = addQuoteItem(r19.items, 'y');
  assert.equal(r21.status, 'full');
  assert.equal(r21.items, r19.items); // 原样返回，未修改
  assert.deepEqual(r21.items.map((i) => i.slug), [...many(19).map((i) => i.slug), 'x']);
});

test('duplicate is a no-op even when full', () => {
  const full = many(20);
  assert.equal(addQuoteItem(full, 'p-3').status, 'exists');
  assert.equal(addQuoteItem([{ slug: 'a' }], 'a').status, 'exists');
});

test('parse keeps legacy lists over 20 (no silent truncation), drops bad/duplicate entries', () => {
  const raw = JSON.stringify([...many(25), { slug: 'p-1' }, { nope: 1 }, null, { slug: 'q', quantity: 5 }]);
  const items = parseQuoteItems(raw);
  assert.equal(items.length, 26);
  assert.deepEqual(items.at(-1), { slug: 'q', quantity: 5 });
  assert.deepEqual(parseQuoteItems('{bad'), []);
  assert.deepEqual(parseQuoteItems(null), []);
});

test('over-limit blocks submit only above 20', () => {
  assert.equal(over(20), false);
  assert.equal(over(21), true);
  assert.equal(over(0), false);
});
