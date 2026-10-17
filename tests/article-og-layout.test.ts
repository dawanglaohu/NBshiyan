import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fitTitle, textWidth, tokens, TITLE_SIZES, TITLE_WIDTH, MAX_LINES } from '../src/lib/seo/og/articleOgLayout';
import metrics from '../src/lib/seo/og/manrope-800-widths.json';

const fits = (f: ReturnType<typeof fitTitle>) => f.lines.every((l) => textWidth(l, f.size) <= TITLE_WIDTH + 0.5);

test('短标题用最大字号、一行', () => {
  const f = fitTitle('Gift box guide', 'en');
  assert.equal(f.size, TITLE_SIZES[0]);
  assert.deepEqual(f.lines, ['Gift box guide']);
  assert.equal(f.truncated, false);
});

test('标题逐级缩小字号，最多 3 行，每行不超宽；超长标题截断并以「…」结尾', () => {
  const long = {
    en: 'A Deliberately Very Long Article Title About Custom Printed Packaging, Corrugated Mailer Boxes, Paper Cups and Offset Printing That Goes On and On',
    ru: 'Намеренно очень длинный заголовок статьи об упаковке с индивидуальной печатью, гофрокоробах, бумажных стаканах и офсетной печати, который не помещается'
  };
  for (const l of ['en', 'ru'] as const) {
    const f = fitTitle(long[l], l);
    assert.equal(f.size, TITLE_SIZES[TITLE_SIZES.length - 1], l);
    assert.equal(f.lines.length, MAX_LINES, l);
    assert.equal(f.truncated, true, l);
    assert.ok(f.lines[MAX_LINES - 1].endsWith('\u2026'), l);
    assert.doesNotMatch(f.lines[MAX_LINES - 1], /[\s,.;:]\u2026$/u, l);
    assert.ok(fits(f), l);
  }
  // 中等长度：缩小字号但不截断
  const mid = fitTitle('How to Choose the Right Corrugated Mailer Box for Shipping Fragile Glass and Ceramic Products Overseas', 'en');
  assert.ok(mid.size < TITLE_SIZES[0] && !mid.truncated && mid.lines.length <= MAX_LINES && fits(mid));
  assert.equal(mid.lines.join(' '), 'How to Choose the Right Corrugated Mailer Box for Shipping Fragile Glass and Ceramic Products Overseas');
});

test('RU：单字母前置词/连词不落在行尾；EN：末行不只剩一个词', () => {
  const ru = 'Как выбрать коробку для вина и не ошибиться с размером и материалом в первый раз';
  const f = fitTitle(ru, 'ru');
  for (const line of f.lines) assert.doesNotMatch(line, /(^|[\s\u00a0])[свикоуа]$/iu, line);
  assert.equal(tokens('в  коробке\tи стакане', 'ru').join(' '), 'в\u00a0коробке и\u00a0стакане');
  const en = fitTitle('Packaging printing explained for first time buyers of custom boxes today', 'en');
  if (en.lines.length > 1) assert.ok(en.lines[en.lines.length - 1].includes(' '));
});

test('超宽单词按字符断开，控制字符和空白被规范化', () => {
  const f = fitTitle('X'.repeat(120), 'en');
  assert.ok(f.lines.length <= MAX_LINES && fits(f));
  assert.deepEqual(fitTitle('  Hello\u0000\nworld  ', 'en').lines, ['Hello world']);
  assert.deepEqual(fitTitle('   ', 'en').lines, []);
});

test('字宽表覆盖拉丁和西里尔（含 Ёё « » …），字体文件存在且是 TTF', () => {
  const w = metrics.widths as Record<string, number>;
  for (const ch of 'AZaz09ЁёАЯаяЙй«»…—№') assert.ok(w[String(ch.codePointAt(0))] > 0, ch);
  for (const f of ['Manrope-ExtraBold.ttf', 'Manrope-SemiBold.ttf']) {
    const b = fs.readFileSync(`src/assets/og-fonts/${f}`);
    assert.equal(b.readUInt32BE(0), 0x00010000, f);
  }
  assert.ok(fs.existsSync('src/assets/og-fonts/OFL.txt'));
});

test('分享图模板和接口：不写任何业务承诺；接口出错时回退到通用图；字体随 standalone 带上', () => {
  const tpl = fs.readFileSync('src/lib/seo/og/ArticleOgImage.tsx', 'utf8');
  assert.doesNotMatch(tpl.replace(/^\s*\/\/.*$/gm, ''), /FSC|ISO|MOQ|lead time|free|eco|24\s*(h|hour|час)|factory|фабрик|завод|бесплат/i);
  assert.match(tpl, /Article/);
  assert.match(tpl, /Статья/);
  assert.match(tpl, /geiom\.com/);
  const r = fs.readFileSync('src/app/[locale]/articles/[slug]/og/route.tsx', 'utf8');
  assert.match(r, /ogImageUrl\(ARTICLE_OG_SLUG, locale\)/);
  assert.match(r, /status: 302/);
  assert.match(r, /await res\.arrayBuffer\(\)/);
  assert.match(r, /catch \(e\)/);
  assert.match(fs.readFileSync('next.config.ts', 'utf8'), /'\/\[locale\]\/articles\/\[slug\]\/og': \['\.\/src\/assets\/og-fonts\/\*\.ttf'\]/);
});
