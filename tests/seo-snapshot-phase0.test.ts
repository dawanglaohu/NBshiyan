import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seoSnapshot } from './fixtures/seo-snapshot';

// SEO 要求：多语言第 0 期前后，en/ru 的 sitemap 和 hreflang 输出逐字节一致。
// 基准 seo-snapshot-main.json 由同一个生成器在 origin/main（c9d3ce1）上生成；不要为了让测试通过而重新生成它。
test('sitemap + hreflang output byte-identical to main (c9d3ce1)', async () => {
  const now = JSON.stringify(await seoSnapshot(), null, 2) + '\n';
  assert.equal(now, readFileSync('tests/fixtures/seo-snapshot-main.json', 'utf8'));
});

test('no unpublished locale anywhere in sitemap / hreflang output', async () => {
  const s = JSON.stringify(await seoSnapshot());
  for (const l of ['es', 'de', 'fr', 'ja', 'hi', 'ar']) {
    assert.doesNotMatch(s, new RegExp(`geiom\\.com/${l}(/|")`), l);
    assert.doesNotMatch(s, new RegExp(`"${l}":`), l);
  }
});
