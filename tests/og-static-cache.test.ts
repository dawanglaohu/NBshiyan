import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { aboutOgResponse } from '../src/lib/about/og-response';
import { articleOgVersion } from '../src/lib/seo/articleOg';
import { handleArticleOg } from '../src/lib/seo/og/articleOgHandler';
import { OG_STATIC_JPG_CACHE_CONTROL, OG_STATIC_JPG_SOURCE, responseHeaderRules } from '../next.config';

// 与 next 给 headers() 编译 source 的方式相同：path-to-regexp strict，再把结尾放宽成可选斜杠。
const require = createRequire(process.cwd() + '/package.json');
const { getPathMatch } = require('next/dist/shared/lib/router/utils/path-match') as {
  getPathMatch: (path: string, options: {
    strict?: boolean;
    removeUnnamedParams?: boolean;
    sensitive?: boolean;
    regexModifier?: (source: string) => string;
  }) => (pathname: string) => false | Record<string, unknown>;
};
const { modifyRouteRegex } = require('next/dist/lib/redirect-status') as {
  modifyRouteRegex: (source: string) => string;
};

const ARTICLE_OG_CACHE = 'public, max-age=31536000, immutable';
const SLUG = 'mock-article-packaging-guide';
const TITLE = 'Mock Article: Packaging Guide Layout Test';

type Rule = { source: string; headers: { key: string; value: string }[] };

function compiled(rules: Rule[]) {
  return rules.map((rule) => ({
    rule,
    match: getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      sensitive: false,
      regexModifier: (source) => modifyRouteRegex(source),
    }),
  }));
}

/** 后匹配的同名头覆盖先匹配的，和 Next 把 header 规则写进 resHeaders 的顺序一致。 */
function headerValue(rules: Rule[], pathname: string, key: string): string | undefined {
  let value: string | undefined;
  for (const item of compiled(rules)) {
    if (!item.match(pathname)) continue;
    for (const header of item.rule.headers) {
      if (header.key.toLowerCase() === key.toLowerCase()) value = header.value;
    }
  }
  return value;
}

test('headers() 使用 responseHeaderRules，静态 jpg 规则挂在配置上', () => {
  const src = readFileSync('next.config.ts', 'utf8');
  assert.match(src, /async headers\(\) \{\s*return responseHeaderRules\(isProd\);\s*\}/);
  assert.equal(OG_STATIC_JPG_SOURCE, '/og/:file*.jpg');
  assert.equal(OG_STATIC_JPG_CACHE_CONTROL, 'public, max-age=86400, stale-while-revalidate=604800');
  assert.doesNotMatch(OG_STATIC_JPG_CACHE_CONTROL, /immutable|s-maxage/);
});

test('/og/home-en.jpg 的 Cache-Control 是 1 天加 7 天 stale-while-revalidate；动态分享图路径不被这条规则命中', () => {
  for (const prod of [true, false]) {
    const rules = responseHeaderRules(prod);
    for (const path of [
      '/og/home-en.jpg',
      '/og/home-ru.jpg',
      '/og/category-custom-gift-boxes-en.jpg',
      '/og/contact-en.jpg',
      '/og/home-en.jpg/',
    ]) {
      assert.equal(headerValue(rules, path, 'cache-control'), OG_STATIC_JPG_CACHE_CONTROL, `${prod} ${path}`);
    }
    // :file* 按 Next 的 path-to-regexp 可以跨段，所以 /og/ 下的嵌套 jpg 也会命中。public/og 里目前没有这种文件。
    assert.equal(headerValue(rules, '/og/nested/home-en.jpg', 'cache-control'), OG_STATIC_JPG_CACHE_CONTROL);
    for (const path of [
      '/en/articles/mock-article-packaging-guide/og',
      '/ru/articles/mock-statya-o-upakovke/og',
      '/en/about/og',
      '/ru/about/og',
      '/en/articles/mock-article-packaging-guide/og/',
      '/og/home-en.png',
      '/og/home-en.jpeg',
      '/og/home-en.jpg/extra',
      '/images/og/home-en.jpg',
      '/en/og/home-en.jpg',
    ]) {
      assert.equal(headerValue(rules, path, 'cache-control'), undefined, `${prod} ${path}`);
    }
    assert.equal(headerValue(rules, '/models/box.glb', 'cache-control'), 'public, max-age=31536000, immutable');
  }
});

test('/en/articles/<slug>/og 与 /en/about/og 仍由路由自己写缓存头', async () => {
  const v = articleOgVersion('en', TITLE);
  const article = await handleArticleOg(`http://localhost/en/articles/${SLUG}/og?v=${v}`, 'en', SLUG, {
    getDoc: async () => ({ slug: SLUG, title: TITLE }),
    render: async () => new ArrayBuffer(8),
  });
  assert.equal(article.status, 200);
  assert.equal(article.headers.get('content-type'), 'image/png');
  assert.equal(article.headers.get('cache-control'), ARTICLE_OG_CACHE);

  const missing = await handleArticleOg(`http://localhost/en/articles/${SLUG}/og`, 'en', SLUG, {
    getDoc: async () => { throw new Error('missing v must not read the doc'); },
    render: async () => { throw new Error('missing v must not render'); },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');

  const about = await aboutOgResponse('http://localhost/en/about/og?v=abcdef12', 'en', {
    getAboutContent: async () => ({
      locale: 'en', title: 'About', summary: '', bodyHtml: '', stats: [], images: [],
      home: { title: '', intro: '' }, updatedAt: '2026-10-18T00:00:00.000Z',
    }),
    getBadge: async () => 'About',
    expectedVersion: () => 'abcdef12',
    render: async () => new ArrayBuffer(8),
  });
  assert.equal(about.status, 200);
  assert.equal(about.headers.get('cache-control'), ARTICLE_OG_CACHE);

  const aboutMissing = await aboutOgResponse('http://localhost/en/about/og', 'en', {
    getAboutContent: async () => { throw new Error('missing v must not read about'); },
    getBadge: async () => { throw new Error('missing v must not read the badge'); },
    expectedVersion: () => 'abcdef12',
    render: async () => { throw new Error('missing v must not render'); },
  });
  assert.equal(aboutMissing.status, 404);
  assert.equal(aboutMissing.headers.get('cache-control'), 'no-store');
});
