import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectWhenSeoMock } from '../src/lib/seo/connectWhenSeoMock';

const pages = [
  'src/app/[locale]/products/page.tsx',
  'src/app/[locale]/products/[slug]/page.tsx',
];

test('default path does not call connection()', async () => {
  let calls = 0;
  const connect = async () => { calls += 1; };
  await connectWhenSeoMock({}, connect);
  await connectWhenSeoMock({ SEO_AUDIT_MOCK: '1' }, connect);
  await connectWhenSeoMock({ SEO_AUDIT_MOCK: '1', APP_ENV: 'production' }, connect);
  await connectWhenSeoMock({ SEO_AUDIT_MOCK: '1', NODE_ENV: 'production' }, connect);
  await connectWhenSeoMock({ APP_ENV: 'development' }, connect);
  assert.equal(calls, 0);
});

test('seo audit mock is the only path that calls connection()', async () => {
  let calls = 0;
  await connectWhenSeoMock({ SEO_AUDIT_MOCK: '1', APP_ENV: 'development' }, async () => { calls += 1; });
  await connectWhenSeoMock({ SEO_AUDIT_MOCK: '1', APP_ENV: 'test', NODE_ENV: 'production' }, async () => { calls += 1; });
  assert.equal(calls, 2);
});

test('product pages keep ISR and do not call connection() themselves', () => {
  const list = readFileSync(pages[0], 'utf8');
  assert.match(list, /export const revalidate = 60/);
  assert.match(list, /await connectWhenSeoMock\(\)/);
  assert.doesNotMatch(list, /await connection\(\)/);
  const shell = readFileSync(pages[1], 'utf8');
  assert.match(shell, /await connectWhenSeoMock\(\)/);
  assert.equal(shell.match(/await connectWhenSeoMock\(\)/g)?.length, 2);
  assert.doesNotMatch(shell, /await connection\(\)/);
  const helper = readFileSync('src/lib/seo/connectWhenSeoMock.ts', 'utf8');
  const guard = helper.indexOf('if (!seoMockEnabled(env)) return;');
  const call = helper.indexOf('await connection()');
  assert.ok(guard >= 0 && call > guard);
});
