import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ABOUT_LIMITS, aboutBodyText, countChars, isAboutContentComplete, resolvePublishedAboutLocales } from '../src/lib/site-settings/about-rules';
import { ABOUT_LIMITS as MODEL_LIMITS, isAboutComplete } from '../src/lib/server/site-settings-model';
import { aboutHtmlToText } from '../src/lib/server/sanitize-about';

// #350 about 完整 / 已发布规则：唯一实现在 src/lib/site-settings/about-rules.ts
const p = (s: string) => `<p>${s}</p>`;
const ok = (o: Record<string, unknown> = {}) => ({ title: 'About us', bodyHtml: p('x'.repeat(50)), images: [], ...o });

test('纯模块：不 import server-only / prisma / sanitize-html / next', () => {
  const src = readFileSync('src/lib/site-settings/about-rules.ts', 'utf8').split('\n').filter((l) => /^\s*import /.test(l)).join('\n');
  assert.match(src, /published-locales/);
  for (const bad of [/server-only/, /from '@prisma\/client'/, /sanitize-html/, /from 'next/, /\.\/db'/, /server\/db/]) assert.ok(!bad.test(src), String(bad));
  assert.equal(MODEL_LIMITS, ABOUT_LIMITS);
});

test('规则 1：标题 2–80 字（去首尾空白，按 code point）', () => {
  assert.equal(isAboutContentComplete(ok({ title: 'A' })), false);
  assert.equal(isAboutContentComplete(ok({ title: '  A  ' })), false);
  assert.equal(isAboutContentComplete(ok({ title: 'AB' })), true);
  assert.equal(isAboutContentComplete(ok({ title: 'x'.repeat(80) })), true);
  assert.equal(isAboutContentComplete(ok({ title: 'x'.repeat(81) })), false);
  // 80 个 emoji = 160 个 UTF-16 单元，按 code point 算 80 字
  assert.equal(isAboutContentComplete(ok({ title: '📦'.repeat(80) })), true);
  assert.equal(isAboutContentComplete(ok({ title: '📦' })), false);
  assert.equal(isAboutContentComplete(ok({ title: '包装' })), true);
});

test('规则 2：正文纯文本 50–6000 字（标签不算字数，按 code point）', () => {
  assert.equal(isAboutContentComplete(ok({ bodyHtml: p('x'.repeat(49)) })), false);
  assert.equal(isAboutContentComplete(ok({ bodyHtml: `<p><strong>${'x'.repeat(49)}</strong></p>` })), false);
  assert.equal(isAboutContentComplete(ok({ bodyHtml: p('x'.repeat(6000)) })), true);
  assert.equal(isAboutContentComplete(ok({ bodyHtml: p('x'.repeat(6001)) })), false);
  assert.equal(isAboutContentComplete(ok({ bodyHtml: p('😀'.repeat(50)) })), true);
  assert.equal(isAboutContentComplete(ok({ bodyHtml: p('😀'.repeat(25)) })), false); // 50 个 UTF-16 单元但只有 25 字
  assert.equal(isAboutContentComplete(ok({ bodyHtml: p('&amp;'.repeat(49)) })), false); // 实体按 1 字
  assert.equal(countChars('a📦b'), 3);
});

test('规则 3：每张图都要有非空 alt', () => {
  assert.equal(isAboutContentComplete(ok({ images: [{ alt: 'Factory floor' }] })), true);
  assert.equal(isAboutContentComplete(ok({ images: [{ alt: 'a' }, { alt: '  ' }] })), false);
  assert.equal(isAboutContentComplete(ok({ images: [{ alt: null }] })), false);
  assert.equal(isAboutContentComplete(ok({ images: [{}] })), false);
  assert.equal(isAboutContentComplete(null), false);
  assert.equal(isAboutContentComplete(undefined), false);
});

test('aboutBodyText 和服务端 aboutHtmlToText 对已净化正文结果一致', () => {
  for (const h of ['<h2>T</h2><p>a &amp; b</p>', '<p>a<br>b</p><ul><li>x</li><li>y</li></ul>', '<p><a href="/en" rel="noopener noreferrer">ok</a> &lt;3 &quot;q&quot; &#39;s&nbsp;x</p>', '']) {
    assert.equal(aboutBodyText(h), aboutHtmlToText(h), h);
  }
});

test('规则 4：resolvePublishedAboutLocales = 开关开 AND 在 PUBLISHED_LOCALES AND 内容完整', () => {
  const all = { en: ok(), ru: ok(), ja: ok(), es: ok() };
  assert.deepEqual(resolvePublishedAboutLocales({ enabled: true, contents: all }), ['en', 'ru']);
  assert.deepEqual(resolvePublishedAboutLocales({ enabled: false, contents: all }), []);
  assert.deepEqual(resolvePublishedAboutLocales({ enabled: true, contents: { ru: ok(), en: ok({ title: 'A' }) } }), ['ru']);
  assert.deepEqual(resolvePublishedAboutLocales({ enabled: true, contents: { en: null, ru: undefined } }), []);
  assert.deepEqual(resolvePublishedAboutLocales({ enabled: true, contents: {} }), []);
});

test('site-settings-model 的 isAboutComplete 只是转调 isAboutContentComplete', () => {
  assert.equal(isAboutComplete({ title: '📦📦', bodyHtml: p('😀'.repeat(50)) }), true);
  assert.equal(isAboutComplete({ title: '', bodyHtml: p('x'.repeat(60)) }), false);
  const reader = readFileSync('src/lib/server/site-settings.ts', 'utf8');
  assert.match(reader, /resolvePublishedAboutLocales/);
  assert.ok(!/bodyTextMin|titleMin/.test(reader), '前台读取不能自己再写一份阈值');
});
