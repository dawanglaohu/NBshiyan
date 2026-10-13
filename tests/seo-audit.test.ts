import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePage, checkLengths, checkH1, checkCanonical, checkHreflang, checkNoindex, checkPlaceholder, parseSitemap, type PageInfo } from '../scripts/seo-audit';

const fx = (n: string) => readFileSync(new URL(`./fixtures/seo-audit/${n}.html`, import.meta.url), 'utf8');
const SITE = 'https://packjoyu.com';
const good = parsePage(fx('good')), bad = parsePage(fx('bad'));
const U = `${SITE}/en/products/mailer-boxes`;

test('parsePage extracts head fields; script content is not a placeholder', () => {
  assert.equal(good.h1Count, 1); assert.equal(good.hreflang.ru, `${SITE}/ru/products/mailer-boxes`);
  assert.deepEqual(good.links, ['/en/contact']); assert.equal(good.hasPlaceholder, false);
  assert.equal(bad.robots, 'noindex'); assert.equal(bad.hasPlaceholder, true);
});
test('good fixture passes every per-page check', () => {
  assert.deepEqual([...checkLengths(U, good, true), ...checkH1(U, good), ...checkCanonical(U, good, SITE, true), ...checkNoindex(U, good, true), ...checkPlaceholder(U, good)], []);
});
test('bad fixture: title/desc, h1, relative canonical, placeholder', () => {
  assert.deepEqual(checkLengths('/x', bad, true).map((f) => f.severity), ['warn', 'error']);
  assert.equal(checkH1('/x', bad)[0].severity, 'error');
  assert.match(checkCanonical(`${SITE}/en/x`, bad, SITE, false)[0].message, /not absolute/);
  assert.equal(checkPlaceholder('/x', bad).length, 1);
});
test('canonical off-site and non-self', () => {
  assert.match(checkCanonical(U, { ...good, canonical: 'https://evil.com/en/products/mailer-boxes' }, SITE, true)[0].message, /off-site/);
  assert.equal(checkCanonical(`${SITE}/en/other`, good, SITE, true)[0].severity, 'warn');
});
test('noindex in sitemap and indexable private pages are errors', () => {
  assert.match(checkNoindex(`${SITE}/en/x`, bad, true)[0].message, /sitemap/);
  assert.deepEqual(checkNoindex(`${SITE}/en/x`, bad, false), []);
  assert.match(checkNoindex(`${SITE}/admin`, good, false)[0].message, /private/);
  assert.match(checkNoindex(`${SITE}/ru/s/abc`, good, false)[0].message, /private/);
  assert.deepEqual(checkNoindex(`${SITE}/admin`, good, false, 'noindex, nofollow'), []);
});
test('hreflang reciprocity', () => {
  const pg = (self: string, other: string, back = true): PageInfo => ({ ...good, hreflang: { [self.slice(1, 3)]: SITE + self, ...(back ? { [other.slice(1, 3)]: SITE + other } : {}) } });
  const ok = new Map([['/en/a', pg('/en/a', '/ru/a')], ['/ru/a', pg('/ru/a', '/en/a')]]);
  assert.deepEqual(checkHreflang(ok), []);
  const broken = new Map([['/en/a', pg('/en/a', '/ru/a')], ['/ru/a', pg('/ru/a', '/en/a', false)]]);
  const msgs = checkHreflang(broken).map((f) => f.message).join('\n');
  assert.match(msgs, /not reciprocated/); assert.match(msgs, /missing hreflang="en"/);
});
test('parseSitemap', () => {
  assert.deepEqual(parseSitemap('<urlset><url><loc> https://packjoyu.com/en </loc></url><url><loc>https://packjoyu.com/ru?a=1&amp;b=2</loc></url></urlset>'), ['https://packjoyu.com/en', 'https://packjoyu.com/ru?a=1&b=2']);
});
