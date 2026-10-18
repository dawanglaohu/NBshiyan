// #308 首页产品入口：手机端（≤767px）两列网格 + 「全部产品」链接；≥768 布局不变
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { categoryProducts } from '../src/data/categories';

const css = readFileSync('src/app/globals.css', 'utf8');
const page = readFileSync('src/app/[locale]/page.tsx', 'utf8');
const en = JSON.parse(readFileSync('messages/en.json', 'utf8'));
const ru = JSON.parse(readFileSync('messages/ru.json', 'utf8'));
/** 取出 #308 的 ≤767px 媒体查询块 */
const mobile = (() => { const i = css.indexOf('.entry-all{display:none}'); const s = css.slice(i); const j = s.indexOf('@media (max-width:767px){'); return s.slice(j, s.indexOf('\n}', j)); })();
const decl = (sel: string) => new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`).exec(mobile)?.[1] ?? '';
const px = (d: string, prop: string) => Number(new RegExp(`(?:^|;)${prop}:(\\d+)px`).exec(d)?.[1]);

test('文案 Home.entryAll：EN / RU', () => {
  assert.equal(en.Home.entryAll, 'All products');
  assert.equal(ru.Home.entryAll, 'Вся продукция');
  // 箭头不在文案里（放在标记里，aria-hidden）
  assert.doesNotMatch(en.Home.entryAll + ru.Home.entryAll, /→/);
});
test('页面：网格下面用 next-intl Link 指向 /products', () => {
  assert.match(page, /import \{ Link \} from '@\/i18n\/navigation';/);
  const grid = page.indexOf('<div className="entry">'), link = page.indexOf('<Link className="entry-all" href="/products">{t(\'entryAll\')} <span aria-hidden="true">→</span></Link>');
  assert.ok(grid > 0 && link > grid, '链接在网格之后');
  assert.ok(link < page.indexOf('aria-labelledby="premium-h"'), '还在产品入口这一节里');
});
test('≤767px：两列、间距 8px；卡片最小高度 156；链接 44px 触控高度', () => {
  assert.match(decl('.entry'), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(decl('.entry'), /gap:8px/);
  assert.equal(px(decl('.entry a'), 'min-height'), 156);
  assert.match(decl('.entry-all'), /display:inline-flex/);
  assert.equal(px(decl('.entry-all'), 'min-height'), 44);
});
test('390 宽：卡片 ≥171 宽，整块高度 ≤1100（按 11 个入口、容器左右各 20px 计算）', () => {
  const pad = Number(/\.container\{[^}]*padding:0 (\d+)px/.exec(css)?.[1]);
  const gap = px(decl('.entry'), 'gap');
  const cardW = (390 - 2 * pad - gap) / 2;
  assert.ok(cardW >= 171, `card width ${cardW}`);
  const rows = Math.ceil(categoryProducts.length / 2);
  // 卡片高度 = 内边距 + 边框 + 图片（16:10）+ 间距 + 最多 3 行名称（14px × 1.2）；行高取它和 156 的较大值
  const a = decl('.entry a');
  const inner = cardW - 2 * px(a, 'padding') - 2;
  const tallest = 2 * px(a, 'padding') + 2 + inner * 10 / 16 + px(a, 'gap') + 3 * 14 * 1.2;
  assert.match(decl('.entry img'), /aspect-ratio:16\/10/);
  const height = rows * Math.max(156, tallest) + (rows - 1) * gap;
  assert.ok(height <= 1100, `grid ${height}`);
});
test('≥768 不变：原来的 .entry 规则原样保留，「全部产品」链接默认隐藏', () => {
  assert.ok(css.includes('.entry{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}'));
  assert.ok(css.includes('.entry img{width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;border-radius:var(--r-sm);background:var(--placeholder)}'));
  assert.ok(css.includes('.entry-all{display:none}'));
  assert.ok(css.indexOf('.entry-all{display:none}') < css.indexOf(mobile), '隐藏规则在媒体查询之前，手机端能覆盖');
});
test('#314 首屏设置没动：封面 sizes="50vw"、视频 99%', () => {
  assert.match(readFileSync('src/components/layout/HeroVideo.tsx', 'utf8') + readFileSync('src/lib/home/heroVideo.ts', 'utf8'), /50vw/);
  assert.match(css, /\.hero-media-video\{[^}]*transform:scale\(\.99\)/);
});
test('断词只靠 CSS hyphens:auto（RU 页 html lang=ru），产品名里没有硬连字符', () => {
  assert.match(readFileSync('src/app/[locale]/layout.tsx', 'utf8'), /<html lang=\{locale\}/);
  assert.match(css.slice(css.indexOf('@media (max-width:767px){\n  .entry{')), /\.entry a\{[^}]*hyphens:auto/);
  for (const m of [en, ru]) for (const [slug, name] of Object.entries(m.Products.names as Record<string, string>)) assert.doesNotMatch(name, /\S-\S|\u2010|\u2011/, `${slug}: ${name}`);
});
