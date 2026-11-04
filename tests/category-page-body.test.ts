import React, { createElement } from 'react';

(globalThis as { React?: typeof React }).React = React;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { categoryMeta } from '../src/lib/seo/categoryMeta';
import { CATEGORY_PAGES_LIVE, categoryForRequest, categoryHref, categoryLanguageAlternates } from '../src/lib/seo/categoryPages';
import { INDEXNOW_LIVE_TYPES } from '../src/lib/seo/indexnow';
import { buildSitemap } from '../src/lib/seo/sitemapEntries';
import {
  categoryArticleText, firstSentence, introHasCoreTerm, loadCategoryArticle, parseCategoryMarkdown, readCategoryMarkdown, sanitizeHref,
  type CategoryArticle,
} from '../src/lib/seo/categoryMarkdown';
import CategoryArticleView from '../src/components/category/CategoryArticle';
import { CATEGORY_MARKDOWN_BODIES } from '../src/lib/seo/categoryMarkdownBodies';

const htmlOf = (article: CategoryArticle) => renderToStaticMarkup(createElement(NextIntlClientProvider, {
  locale: 'en',
  messages: {},
  children: createElement(CategoryArticleView, { article, catalogHref: '/products#gift-boxes', catalogLabel: '3D Products' }),
}));

const headings = (html: string) => [...html.matchAll(/<h([1-6])\b[^>]*>/g)].map((m) => Number(m[1]));

test('switch on publishes category URLs; switch off does not leak them', () => {
  assert.equal(CATEGORY_PAGES_LIVE, true);
  assert.equal(INDEXNOW_LIVE_TYPES.product.live, true);
  assert.equal(INDEXNOW_LIVE_TYPES.solution.live, false);
  assert.equal(INDEXNOW_LIVE_TYPES.article.live, false);
  const gift = categoryLanguageAlternates('gift-boxes', true);
  // fix1 口径：只有 en 上线，hreflang 不得输出 ru，x-default 指向 en。
  assert.deepEqual(gift, {
    en: '/en/products/custom-gift-boxes',
    'x-default': '/en/products/custom-gift-boxes',
  });
  assert.equal(Object.hasOwn(gift!, 'ru'), false, 'hreflang 不得输出未上线的 ru');
  assert.equal(categoryLanguageAlternates('gift-boxes', false), null);
  assert.equal(categoryForRequest('en', 'custom-gift-boxes', true)?.key, 'gift-boxes');
  assert.equal(categoryForRequest('en', 'custom-gift-boxes', false), undefined);
  assert.equal(categoryForRequest('en', 'gift-boxes', true), undefined);
  // ru 未上线：即使开关打开也不解析 ru slug，页面 404。
  assert.equal(categoryForRequest('ru', 'podarochnye-korobki', true), undefined);
  // 入口回退：ru 未上线时回到该语言 3D 目录里的卡片锚点（既有回退行为，不改）。
  assert.equal(categoryHref('ru', 'gift-boxes', true), '/products#gift-boxes');
  assert.equal(categoryHref('ru', 'gift-boxes', false), '/products#gift-boxes');
  const hidden = buildSitemap({ siteUrl: 'https://example.com/', locales: ['en', 'ru'] as const, defaultLocale: 'en' as const });
  assert.ok(!hidden.some((entry) => entry.url.includes('/products/custom-gift-boxes') || entry.url.includes('/products/podarochnye-korobki')));
  const page = readFileSync('src/app/[locale]/products/[slug]/page.tsx', 'utf8');
  const footer = readFileSync('src/components/layout/SiteFooter.tsx', 'utf8');
  const cards = readFileSync('src/app/[locale]/products/page.tsx', 'utf8');
  assert.match(footer, /categoryHref\(locale, p\.slug, categoryLive\)/);
  assert.match(cards, /categoryHref\(loc, item\.slug, categoryLive\)/);
  assert.match(page, /categoryForRequest\(locale, slug, categoryPagesLive\(\)\)/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(readFileSync('src/components/category/CategoryArticle.tsx', 'utf8'), /dangerouslySetInnerHTML/);
  // UX P2：行宽从 70ch 收窄到 32rem（约 70 字符但可随字号缩放），英文关闭自动断词，俄语保留。
  const css = readFileSync('src/app/globals.css', 'utf8');
  assert.match(css, /main\.category-prose\{[^}]*max-width:min\(32rem,var\(--container\)\)/);
  assert.match(css, /text-wrap:pretty/);
  assert.match(css, /main\.category-prose:lang\(en\)\{hyphens:manual\}/, '英文不得自动断词');
  assert.doesNotMatch(css, /main\.category-prose\{[^}]*max-width:min\(70ch/, '旧 70ch 行宽应已移除');
});

test('every category article: one H1 from the markdown, lead before the catalog link, headings start at H2', () => {
  assert.equal(readCategoryMarkdown('README', 'en'), null);
  assert.equal(readCategoryMarkdown('../README', 'en'), null);
  assert.equal(readCategoryMarkdown('gift-boxes', 'en', () => { throw new Error('missing'); }), CATEGORY_MARKDOWN_BODIES['gift-boxes'].en);
  const descriptions = new Set<string>();
  for (const meta of categoryMeta) for (const locale of ['en', 'ru'] as const) {
    const disk = readFileSync(`docs/content/category-pages/${meta.key}.${locale}.md`, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    assert.equal(CATEGORY_MARKDOWN_BODIES[meta.key]?.[locale], disk, `${meta.key}/${locale} bundle drifted`);
    const article = loadCategoryArticle(meta.key, locale);
    assert.ok(article, `${meta.key}/${locale}`);
    const text = categoryArticleText(article);
    assert.ok(article.lead.length > 0, `${meta.key}/${locale} missing lead`);
    const leadText = text.split('\n').slice(1, 1 + article.lead.length).join(' ');
    const sentence = firstSentence(leadText);
    assert.ok(sentence, `${meta.key}/${locale} empty lead`);
    assert.ok(introHasCoreTerm(sentence, article.h1, meta[locale].keyword), `${meta.key}/${locale} lead misses core term: ${sentence}`);
    const description = meta[locale].description;
    assert.ok(description.length <= 160, `${meta.key}/${locale} description ${description.length}`);
    assert.ok(!descriptions.has(description), description);
    descriptions.add(description);
    assert.notEqual(description, sentence);
    assert.equal(leadText.replace(/\s+/g, ' ').startsWith(description), false);
    assert.equal(sentence.startsWith(description), false);
    assert.doesNotMatch(text, /\{\{/);
    assert.doesNotMatch(text, /\d/);
    const html = htmlOf(article);
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1);
    assert.match(html, new RegExp(`<h1>${article.h1}</h1>`));
    assert.ok(html.indexOf('data-testid="category-lead"') < html.indexOf('data-testid="catalog-return-link"'));
    assert.ok(html.indexOf('<h1>') < html.indexOf('data-testid="category-lead"'));
    const levels = headings(html);
    assert.equal(levels[0], 1);
    assert.ok(levels.slice(1).every((level) => level >= 2 && level <= 3));
    for (let i = 1; i < levels.length; i += 1) assert.ok(levels[i] <= levels[i - 1] + 1, `${meta.key}/${locale} skipped heading`);
    assert.doesNotMatch(html, /<h2[^>]*>Intro<\/h2>|<h2[^>]*>Вступление<\/h2>|<h2[^>]*>CTA<\/h2>/);
    assert.doesNotMatch(html, /\{\{|<script|javascript:/i);
    // SEO/UX P2-1：页面可见文本不得暴露内部仓库路径或来源标注。
    assert.doesNotMatch(html, /docs\/content|landing-faq\.md|\.md\b/, `${meta.key}/${locale} 渲染文本含内部路径`);
    assert.doesNotMatch(html, /(?:\bsource\s*:|источник\s*:)/i, `${meta.key}/${locale} 渲染文本含来源标注`);
    // #faq 自链接：FAQ 小节删除后不得残留指向自身的锚点。
    assert.doesNotMatch(html, /href="#faq"/, `${meta.key}/${locale} 残留 #faq 自链接`);
    // 空分节：不得渲染只有标题、没有正文块的 section。
    for (const m of html.matchAll(/<section[^>]*>([\s\S]*?)<\/section>/g)) {
      assert.match(m[1], /<(p|ul|ol|table)[\s>]/, `${meta.key}/${locale} 出现无正文的空分节`);
    }
  }
  assert.equal(descriptions.size, categoryMeta.length * 2);
});

test('placeholder blocks and whole sections drop out; blockquotes and raw HTML do not render', () => {
  const offset = loadCategoryArticle('offset-printing', 'en')!;
  const offsetText = categoryArticleText(offset);
  assert.doesNotMatch(offsetText, /Materials and options|Press equipment/);
  assert.match(offsetText, /Customization and printing/);
  const cups = categoryArticleText(loadCategoryArticle('paper-cups', 'en')!);
  assert.match(cups, /Materials and options/);
  assert.match(cups, /Single wall/);
  assert.doesNotMatch(cups, /Coating type|Available options/);
  for (const meta of categoryMeta) for (const locale of ['en', 'ru'] as const) {
    const text = categoryArticleText(loadCategoryArticle(meta.key, locale)!);
    assert.doesNotMatch(text, /MOQ and lead times|Минимальный тираж и сроки/);
  }
  const filtered = parseCategoryMarkdown([
    '# Custom Thing',
    '',
    '> F16 this note is only for Ryan',
    '',
    '## Intro',
    '',
    'Hello <script>alert(1)</script> custom thing.',
    '',
    '## Hidden',
    '',
    'All {{secret}}',
    '',
    '## Specs',
    '',
    '| Keep | Yes |',
    '| --- | --- |',
    '| Drop | {{no}} |',
    '| Stay | ok |',
    '',
    'A paragraph with {{placeholder}}.',
    '',
    '- visible item',
    '- hidden {{item}}',
    '',
    '[bad](javascript:alert(1)) and [ok](https://example.com/a)',
    '',
    '## CTA',
    '',
    '**Request a quote** → inquiry form, category pre-filled.',
  ].join('\n'))!;
  const html = htmlOf(filtered);
  assert.equal(filtered.h1, 'Custom Thing');
  assert.doesNotMatch(html, /F16|Ryan|Hidden|secret|Drop|placeholder|hidden|alert\(1\)|<script|javascript:|inquiry form|pre-filled|>CTA</);
  assert.match(html, /Stay/);
  assert.match(html, /visible item/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.match(html, /Request a quote/);
  assert.match(html, /href="(?:\/en)?\/contact"/);
  assert.equal(sanitizeHref('javascript:alert(1)'), null);
  assert.equal(sanitizeHref('JavaScript:alert(1)'), null);
  assert.equal(sanitizeHref('//evil.example'), null);
});

test('gift-boxes body keeps the buyer-facing sections and the quote button', () => {
  const html = htmlOf(loadCategoryArticle('gift-boxes', 'en')!);
  assert.match(html, /<h1>Custom Gift Boxes<\/h1>/);
  // 语言 FAIL 要求首句含完整关键词；旧措辞 "custom rigid gift boxes" 已按定稿替换。
  assert.match(html, /custom gift boxes in rigid board/);
  assert.match(html, /href="(?:\/en)?\/contact"/);
  assert.match(html, />Request a quote</);
  assert.doesNotMatch(html, /inquiry form|pre-filled/);
});
