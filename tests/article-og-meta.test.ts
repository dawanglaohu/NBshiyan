import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import en from '../messages/en.json';
import ru from '../messages/ru.json';
import { articleShareMeta, articleOgImageUrl, articleOgVersion, ARTICLE_OG_SLUG } from '../src/lib/seo/articleOg';

const OG = path.join(process.cwd(), 'public/og');
const sha8 = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(OG, f))).digest('hex').slice(0, 8);
type Img = { url: string; width: number; height: number; alt: string };

test('文章回退分享图（列表页 / 没有文档时）：EN/RU 各用自己语言的 home 图，?v= = 文件哈希，1200×630，alt = Meta.ogImageAlt', () => {
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
    assert.match(s, /articleShareMeta\(loc\(locale\), t\('ogImageAlt'\), doc\)/);
  // listMetadata 用通用图；detailMetadata（找到文档时）传入 slug + 标题，用专属图
  assert.equal((s.match(/\.\.\.\(await shareMeta\(type, locale\)\)/g) ?? []).length, 1);
  assert.equal((s.match(/\.\.\.\(await shareMeta\(type, locale, \{ slug: d\.slug \?\? slug, title: d\.title \}\)\)/g) ?? []).length, 1);
  // 找不到文档（404）时仍只返回 noindex
  assert.match(s, /if \(!d\) return \{ robots: \{ index: false \} \};/);
  for (const f of ['src/app/[locale]/articles/page.tsx', 'src/app/[locale]/articles/[slug]/page.tsx']) {
    const p = fs.readFileSync(f, 'utf8');
    assert.match(p, /(listMetadata|detailMetadata)\('article', '\/articles'\)/, f);
  }
});

test('文章详情页专属分享图：/<locale>/articles/<slug>/og?v=<8 hex>，alt = 标题 | PackJoyU，其余字段与回退图相同', () => {
  for (const [l, title] of [['en', 'How to choose a gift box'], ['ru', 'Как выбрать подарочную коробку']] as const) {
    const m = articleShareMeta(l, 'generic alt', { slug: 'some-article-1', title: `  ${title} ` });
    const og = m.openGraph as { images: Img[] };
    const tw = m.twitter as { images: Img[] };
    for (const img of [og.images[0], tw.images[0]]) {
      const u = new URL(img.url);
      assert.equal(u.pathname, `/${l}/articles/some-article-1/og`);
      assert.equal(u.searchParams.get('v'), articleOgVersion(l, title));
      assert.match(u.searchParams.get('v') ?? '', /^[0-9a-f]{8}$/);
      assert.deepEqual([...u.searchParams.keys()], ['v']);
      assert.equal(img.width, 1200);
      assert.equal(img.height, 630);
      assert.equal(img.alt, `${title} | PackJoyU`);
    }
    assert.deepEqual(Object.keys(og).sort(), ['alternateLocale', 'images', 'locale', 'siteName', 'type']);
  }
  // 标题变了 v 就变；EN/RU 同标题 v 也不同
  assert.notEqual(articleOgVersion('en', 'A'), articleOgVersion('en', 'B'));
  assert.notEqual(articleOgVersion('en', 'A'), articleOgVersion('ru', 'A'));
});

test('文章专属图的回退：标题为空、slug 缺失或不合规时用通用 home 图', () => {
  for (const doc of [undefined, null, {}, { slug: 'ok-slug' }, { slug: 'ok-slug', title: '   ' }, { title: 'T' }, { slug: '../x', title: 'T' }, { slug: 'UPPER', title: 'T' }, { slug: 'a/b', title: 'T' }, { slug: 'x'.repeat(97), title: 'T' }]) {
    assert.equal(articleOgImageUrl('en', doc), null, JSON.stringify(doc));
    const m = articleShareMeta('en', 'generic alt', doc);
    const img = (m.openGraph as { images: Img[] }).images[0];
    assert.equal(new URL(img.url).pathname, '/og/home-en.jpg');
    assert.equal(img.alt, 'generic alt');
  }
});
