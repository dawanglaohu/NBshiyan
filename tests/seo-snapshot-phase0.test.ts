import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seoSnapshot } from './fixtures/seo-snapshot';

// sitemap 与 hreflang 的基准。CATEGORY_PAGES_LIVE 为 true 时，sitemapRoute 含品类页 URL。
// 改 sitemap 形状要在同一提交里更新 tests/fixtures/seo-snapshot-main.json，并写明原因。不要为了掩盖无关差异而重新生成。
test('sitemap + hreflang output matches the checked-in snapshot', async () => {
  const now = JSON.stringify(await seoSnapshot(), null, 2) + '\n';
  assert.equal(now, readFileSync('tests/fixtures/seo-snapshot-main.json', 'utf8').replace(/\r\n/g, '\n'));
});

test('no unpublished locale anywhere in sitemap / hreflang output', async () => {
  const s = JSON.stringify(await seoSnapshot());
  for (const l of ['es', 'de', 'fr', 'ja', 'hi', 'ar']) {
    assert.doesNotMatch(s, new RegExp(`geiom\\.com/${l}(/|")`), l);
    assert.doesNotMatch(s, new RegExp(`"${l}":`), l);
  }
});
