import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import sharp from 'sharp';
import { fitTitle, MAX_LINES, TITLE_WIDTH, textWidth, ogSafeText } from '../src/lib/seo/og/articleOgLayout';

(globalThis as { React?: typeof React }).React = React;

// #350：about 标题上限 80 字。分享图标题最多 3 行，放不下就截断加「…」，永远不压到底部 geiom.com 那一行。
// 文章和 about 共用同一套排版（fitTitle），这里两种 badge 都测。
const ru80 = [
  'Наше производство упаковки и печати: от образца до тиража, контроль на каждом шаге',
  'Производственно-полиграфическая компания PackJoyU — высококачественная упаковка',
  'Мы производим подарочные коробки, гофрокороба, бумажные стаканы и печатную продукцию',
  'Ш'.repeat(80),
].map((t) => {
  let x = [...`${t} упаковка и печать на заказ`].slice(0, 80).join('');
  if (x.endsWith(' ')) x = `${x.slice(0, -1)}я`;
  return x;
});
const overflow = 'Наше производство упаковки и печати: от образца до тиража, контроль качества на каждом шаге, упаковка, отгрузка и документы для каждого заказа';

test('80 字 RU 标题：≤ 3 行，每行不超宽；截断时以「…」结尾', () => {
  for (const t of ru80) {
    assert.equal([...t].length, 80);
    const fit = fitTitle(t, 'ru');
    assert.ok(fit.lines.length >= 1 && fit.lines.length <= MAX_LINES, `${fit.lines.length} lines: ${t}`);
    for (const l of fit.lines) assert.ok(textWidth(l, fit.size) <= TITLE_WIDTH + 0.5, l);
    if (fit.truncated) assert.match(fit.lines.at(-1)!, /…$/);
  }
  const o = fitTitle(overflow, 'ru');
  assert.equal(o.truncated, true);
  assert.equal(o.lines.length, MAX_LINES);
  assert.match(o.lines.at(-1)!, /…$/);
  assert.doesNotMatch(o.lines.at(-1)!, /[,.;:\s]…$/);
});

/** 渲染后按行扫描：找出左侧文字区里有深色像素的行，按空白分组 */
async function inkBands(png: ArrayBuffer) {
  const { data, info } = await sharp(Buffer.from(png)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows: boolean[] = [];
  for (let y = 0; y < info.height; y++) {
    let ink = false;
    for (let x = 72; x < 1100 && !ink; x++) {
      const i = (y * info.width + x) * 3;
      // 深色字（#1C1C1C 标题、#5A5650 域名），排除珊瑚色条和底色
      if (data[i] < 140 && data[i + 1] < 140 && data[i + 2] < 140) ink = true;
    }
    rows.push(ink);
  }
  const bands: [number, number][] = [];
  rows.forEach((r, y) => { if (r && (y === 0 || !rows[y - 1])) bands.push([y, y]); if (r) bands[bands.length - 1][1] = y; });
  // 间隔不到 6px 的算同一行（例如 i 的点和字身）
  for (let i = bands.length - 1; i > 0; i--) if (bands[i][0] - bands[i - 1][1] < 6) { bands[i - 1][1] = bands[i][1]; bands.splice(i, 1); }
  return { bands, height: info.height, width: info.width };
}

test('渲染：80 字 RU 标题和超长标题都不压到底部 geiom.com，中间至少留 24px；文章 / about 角标两种都测', async () => {
  const { renderArticleOgPng } = await import('../src/lib/seo/og/renderArticleOg');
  for (const t of [...ru80, overflow]) {
    for (const badge of [undefined, 'О компании']) {
      const png = await renderArticleOgPng(t, 'ru', badge === undefined ? undefined : { badge });
      assert.ok(png, t);
      const { bands, height, width } = await inkBands(png);
      assert.deepEqual([width, height], [1200, 630]);
      const domain = bands.at(-1)!;
      assert.ok(domain[0] > 520, `domain line near the bottom: ${domain}`);
      const above = bands.filter((b) => b[1] < domain[0] && b[0] > 120); // 去掉顶部字标 / 角标
      assert.ok(above.length > 0, 'title rendered');
      const titleBottom = Math.max(...above.map((b) => b[1]));
      assert.ok(domain[0] - titleBottom >= 24, `gap ${domain[0] - titleBottom}px for «${t}»`);
    }
  }
});

test('角标：传了就画（过 ogSafeText），传空字符串不画，不传 = 文章默认', async () => {
  const { ArticleOgImage, LABEL } = await import('../src/lib/seo/og/ArticleOgImage');
  const text = (el: React.ReactElement): string => {
    const walk = (n: unknown): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(walk).join('') : n && typeof n === 'object' && 'props' in n ? walk((n as { props: { children?: unknown } }).props.children) : '');
    return walk(el);
  };
  assert.match(text(ArticleOgImage({ title: 'T', locale: 'ru' })), new RegExp(LABEL.ru));
  assert.match(text(ArticleOgImage({ title: 'T', locale: 'ru', badge: 'О компании' })), /О компании/);
  assert.doesNotMatch(text(ArticleOgImage({ title: 'T', locale: 'ru', badge: 'О компании' })), /Статья/);
  assert.doesNotMatch(text(ArticleOgImage({ title: 'T', locale: 'en', badge: '' })), /Article/);
  assert.equal(ogSafeText('About 🎁'), 'About');
});
