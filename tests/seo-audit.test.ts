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

import { checkBreadcrumb, needsBreadcrumb, mockSeeds } from '../scripts/seo-audit';
const ld = (o: unknown) => `<html><head><title>t</title></head><body><script type="application/ld+json">${JSON.stringify(o)}</script><h1>x</h1></body></html>`;
const bc = (items: string[]) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: `n${i}`, item })) });
test('checkBreadcrumb: valid list passes; missing on category/article page is an error', () => {
  const p = '/en/products/custom-gift-boxes';
  assert.deepEqual(checkBreadcrumb(p, parsePage(ld(bc([`${SITE}/en`, `${SITE}/en/products`, `${SITE}${p}`]))), SITE), []);
  assert.match(checkBreadcrumb(p, parsePage('<h1>x</h1>'), SITE)[0].message, /missing BreadcrumbList/);
  assert.deepEqual(checkBreadcrumb('/en/contact', parsePage('<h1>x</h1>'), SITE), []);
  assert.equal(needsBreadcrumb('/ru/articles/abc'), true); assert.equal(needsBreadcrumb('/ru/articles'), false);
});
test('checkBreadcrumb: off-site, relative, wrong last item, bad JSON', () => {
  const p = '/en/articles/a';
  const msgs = checkBreadcrumb(p, parsePage(ld(bc([`${SITE}/en`, 'https://evil.com/x', '/en/articles/a']))), SITE).map((f) => f.message).join('\n');
  assert.match(msgs, /off-site/); assert.match(msgs, /not absolute/);
  assert.match(checkBreadcrumb(p, parsePage(ld(bc([`${SITE}/en`, `${SITE}/en/articles/b`]))), SITE)[0].message, /last item/);
  assert.match(checkBreadcrumb(p, parsePage('<script type="application/ld+json">{oops</script>'), SITE)[0].message, /invalid JSON-LD/);
});
test('mockSeeds covers 12 categories x 2 locales + article lists', () => {
  const s = mockSeeds(); assert.equal(s.length, 26); assert.ok(s.includes('/ru/products/podarochnye-korobki'));
});
