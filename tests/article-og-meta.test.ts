import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import en from '../messages/en.json';
import ru from '../messages/ru.json';
import { articleShareMeta, ARTICLE_OG_SLUG } from '../src/lib/seo/articleOg';

const OG = path.join(process.cwd(), 'public/og');
const sha8 = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(OG, f))).digest('hex').slice(0, 8);
type Img = { url: string; width: number; height: number; alt: string };

test('文章回退分享图：EN/RU 各用自己语言的 home 图，?v= = 文件哈希，1200×630，alt = Meta.ogImageAlt', () => {
  assert.equal(ARTICLE_OG_SLUG, 'home');
  for (const [l, msgs] of [['en', en], ['ru', ru]] as const) {
    const alt = msgs.Meta.ogImageAlt;
    const m = articleShareMeta(l, alt);
    const og = m.openGraph as { images: Img[]; type: string; siteName: string; locale: string; alternateLocale: string[] };
    const tw = m.twitter as { card: string; images: Img[] };
    const file = `home-${l}.jpg`;
    assert.ok(fs.existsSync(path.join(OG, file)), file);
    for (const img of [og.images[0], tw.images[0]]) {
      const u = new URL(img.url);
      assert.equal(u.pathname, `/og/${file}`);
      assert.equal(u.searchParams.get('v'), sha8(file));
      assert.equal(img.width, 1200);
      assert.equal(img.height, 630);
      assert.equal(img.alt, alt);
    }
    assert.equal(og.images.length, 1);
    assert.equal(tw.images.length, 1);
    assert.equal(tw.card, 'summary_large_image');
    // 与 layout 的 openGraph 一致（子页面写 openGraph 会整体覆盖 layout）
    assert.equal(og.type, 'website');
    assert.equal(og.siteName, 'PackJoyU');
    assert.equal(og.locale, l === 'ru' ? 'ru_RU' : 'en_US');
    assert.deepEqual(og.alternateLocale, l === 'ru' ? ['en_US'] : ['ru_RU']);
    // 不新增 og:title / og:url / og:description
    assert.deepEqual(Object.keys(og).sort(), ['alternateLocale', 'images', 'locale', 'siteName', 'type']);
    assert.deepEqual(Object.keys(tw).sort(), ['card', 'images']);
  }
});

test('文章列表页和详情页 metadata 都接入回退分享图，只对 article 生效', () => {
  const s = fs.readFileSync('src/components/cms/cmsPages.tsx', 'utf8');
  assert.match(s, /if \(type !== 'article'\) return \{\};/);
  assert.match(s, /getTranslations\(\{ locale: loc\(locale\), namespace: 'Meta' \}\)/);
  assert.match(s, /articleShareMeta\(loc\(locale\), t\('ogImageAlt'\)\)/);
  // listMetadata 和 detailMetadata（找到文档时）各展开一次
  assert.equal((s.match(/\.\.\.\(await shareMeta\(type, locale\)\)/g) ?? []).length, 2);
  // 找不到文档（404）时仍只返回 noindex
  assert.match(s, /if \(!d\) return \{ robots: \{ index: false \} \};/);
  for (const f of ['src/app/[locale]/articles/page.tsx', 'src/app/[locale]/articles/[slug]/page.tsx']) {
    const p = fs.readFileSync(f, 'utf8');
    assert.match(p, /(listMetadata|detailMetadata)\('article', '\/articles'\)/, f);
  }
});
