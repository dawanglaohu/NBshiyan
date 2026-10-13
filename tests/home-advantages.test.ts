import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { visibleAdvantages } from '../src/lib/home/advantages';

const KEYS = ['capacity', 'certs', 'sampling', 'eco'] as const;

test('empty or missing values produce no card', () => {
  const raw = {
    capacity: { value: '', label: 'boxes produced per month' },
    certs: { value: '   ', label: 'certified' },
    sampling: { value: '3 days', label: 'to sample' },
    eco: { label: 'recyclable' },
  };
  assert.deepEqual(visibleAdvantages(raw, KEYS), [{ key: 'sampling', value: '3 days', label: 'to sample' }]);
});

test('empty label also hides the card; order follows keys', () => {
  const raw = { eco: { value: 'A', label: 'a' }, capacity: { value: 'B', label: '' }, certs: { value: 'C', label: 'c' } };
  assert.deepEqual(visibleAdvantages(raw, KEYS).map((a) => a.key), ['certs', 'eco']);
});

test('bad input yields an empty list', () => {
  assert.deepEqual(visibleAdvantages(undefined, KEYS), []);
  assert.deepEqual(visibleAdvantages('x', KEYS), []);
});

test('unsourced home-page figures stay hidden in both locales until Ryan confirms them', () => {
  for (const locale of ['en', 'ru']) {
    const m = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(visibleAdvantages(m.Home.adv, KEYS), [], locale);
    assert.doesNotMatch(JSON.stringify(m.Home), /TBD/, locale);
  }
});
