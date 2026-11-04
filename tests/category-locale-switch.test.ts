import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { categoryLocaleAlternates } from '../src/lib/seo/categoryPages';
import { categoryMeta } from '../src/lib/seo/categoryMeta';
import { switchHref } from '../src/lib/i18n/localeSwitch';

test('category page: en 已上线切自身品类页，ru 未上线回退列表页', () => {
  const c = categoryMeta.find((m) => m.en.slug === 'custom-gift-boxes')!;
  const alts = categoryLocaleAlternates(c.key)!;
  // fix1 口径：ru 品类页未上线，alt 里 ru 回退列表页；en 仍是真实品类路径。
  assert.deepEqual(alts, { en: '/products/custom-gift-boxes', ru: '/products' });
  assert.equal(switchHref('/en/products/custom-gift-boxes', 'en', 'ru', alts), '/ru/products');
  // 反向切到已上线的 en 仍给出真实品类页。
  assert.equal(switchHref('/ru/products/podarochnye-korobki', 'ru', 'en', alts), '/en/products/custom-gift-boxes');
});

test('category page: every category falls back to the list page for unpublished ru', () => {
  for (const c of categoryMeta) {
    const alts = categoryLocaleAlternates(c.key)!;
    assert.equal(switchHref(`/en/products/${c.en.slug}`, 'en', 'ru', alts), '/ru/products', `${c.key} 应回退列表页`);
    assert.equal(alts.ru, '/products', `${c.key} 的 ru alt 应为列表页`);
  }
  assert.equal(categoryLocaleAlternates('no-such-key'), null);
});

test('category page renders <LocaleAlternates> with categoryLocaleAlternates after notFound()', () => {
  const src = readFileSync(new URL('../src/app/[locale]/products/[slug]/page.tsx', import.meta.url), 'utf8');
  assert.ok(src.indexOf('<LocaleAlternates') > src.indexOf('notFound();'));
  // 签名已带 live 参数，未上线语言据此回退；断言同步到新签名。
  assert.match(src, /categoryLocaleAlternates\(c\.key, live\)/);
});
