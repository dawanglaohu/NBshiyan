import metrics from './manrope-800-widths.json';

// 文章分享图（1200×630）的标题排版：只用 Manrope 800 的字宽表算换行，不依赖 Satori 的自动换行，
// 所以 EN/RU 每个标题的行数、字号、省略号位置都是确定的（测试可直接断言）。
// 规则：字号从大到小试，取第一个能在 MAX_LINES 行内放下、且没有单词超宽的字号；最小字号仍放不下就截到 MAX_LINES 行，末尾加「…」。
// RU：单字母前置词/连词（с в и к о у а）和后一个词绑在一起，不会落在行尾（与 design/og-src/og-layout.mjs 的 bindText 一致）。
// EN：最后一行只剩一个词（且总词数 ≥ 3）时，把上一行最后一个词挪下来（放得下才挪）。

export const OG_ARTICLE = { width: 1200, height: 630 } as const;
export const TITLE_WIDTH = 1000;
export const TITLE_SIZES = [76, 68, 60, 52, 46] as const;
export const MAX_LINES = 3;
export const LETTER_SPACING_EM = -0.02;
const ELLIPSIS = '\u2026';
const NBSP = '\u00a0';

const UPM = metrics.unitsPerEm;
const W = metrics.widths as Record<string, number>;
// 字宽表里没有的字符（emoji 等）按较宽的字估算，宁可换行早一点也不超出
const FALLBACK = 0.72 * UPM;

/** 一段文字在给定字号下的宽度（px，含字距；不含字偶距调整，Manrope 的 kern 只会让实际更窄） */
export function textWidth(s: string, size: number): number {
  let u = 0, n = 0;
  for (const ch of s) { u += W[String(ch.codePointAt(0))] ?? FALLBACK; n++; }
  return (u / UPM) * size + Math.max(0, n - 1) * LETTER_SPACING_EM * size;
}

/**
 * 只保留内置字体（Manrope 子集）里有字形的字符，其余（emoji、中日韩文字等）直接去掉。
 * 原因：Satori 遇到字体里没有的字形，会在运行时去 fonts.googleapis.com / jsDelivr 下载补充字体或 emoji 图，
 * 这里先去掉，渲染时就不会有任何网络请求。字宽表就是字体的 cmap（design/og-src/og-article-font.py 生成）。
 */
export function ogSafeText(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC')) out += ch === ' ' || (ch !== NBSP && W[String(ch.codePointAt(0))] !== undefined) ? ch : /\s/u.test(ch) ? ' ' : '';
  return out.replace(/\s+/g, ' ').trim();
}

/** 规范空白、去掉字体外字符；RU 单字母词和后一个词用不换行空格连起来 */
export function tokens(title: string, locale: 'en' | 'ru'): string[] {
  let t = ogSafeText(title);
  if (locale === 'ru') {
    let prev;
    do { prev = t; t = t.replace(/(^|[\s\u00a0])([свикоуа])\s/giu, (_m, a: string, b: string) => a + b + NBSP); } while (t !== prev);
  }
  return t ? t.split(' ') : [];
}

function wrap(words: string[], size: number, width: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (!cur || textWidth(next, size) <= width) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function fixWidow(lines: string[], size: number, width: number, wordCount: number): string[] {
  if (lines.length < 2 || wordCount < 3) return lines;
  const last = lines[lines.length - 1], prev = lines[lines.length - 2];
  if (last.includes(' ')) return lines;
  const i = prev.lastIndexOf(' ');
  if (i < 0) return lines;
  const moved = prev.slice(i + 1) + ' ' + last;
  if (textWidth(moved, size) > width) return lines;
  return [...lines.slice(0, -2), prev.slice(0, i), moved];
}

/** 超宽的单个词按字符硬断（极少见，例如很长的型号或 URL） */
function splitLong(word: string, size: number, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of word) {
    if (cur && textWidth(cur + ch, size) > width) { out.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** 前 MAX_LINES-1 行照常；最后一行尽量多放词，再加「…」（去掉末尾的标点和连字符） */
function truncate(lines: string[], size: number, width: number): string[] {
  const keep = lines.slice(0, MAX_LINES - 1);
  const rest = lines.slice(MAX_LINES - 1).join(' ').split(' ');
  const clean = (t: string) => t.replace(/[\s\u00a0,.;:!?\-–—(«„“"']+$/u, '');
  let last = '';
  for (const w of rest) {
    const next = last ? last + ' ' + w : w;
    if (textWidth(clean(next) + ELLIPSIS, size) > width) break;
    last = next;
  }
  // 第一个词就放不下（不会发生在拆过的长词上，兜底）：按字符截
  if (!last) { for (const ch of rest[0] ?? '') { if (textWidth(last + ch + ELLIPSIS, size) > width) break; last += ch; } }
  keep.push(clean(last) + ELLIPSIS);
  return keep;
}

export type TitleFit = { size: number; lines: string[]; truncated: boolean };

export function fitTitle(title: string, locale: 'en' | 'ru', width: number = TITLE_WIDTH): TitleFit {
  const words = tokens(title, locale);
  if (!words.length) return { size: TITLE_SIZES[0], lines: [], truncated: false };
  for (const size of TITLE_SIZES) {
    if (words.some((w) => textWidth(w, size) > width)) continue;
    let lines = wrap(words, size, width);
    if (lines.length > MAX_LINES) continue;
    if (locale === 'en') lines = fixWidow(lines, size, width, words.length);
    return { size, lines, truncated: false };
  }
  const size = TITLE_SIZES[TITLE_SIZES.length - 1];
  const pieces = words.flatMap((w) => (textWidth(w, size) > width ? splitLong(w, size, width) : [w]));
  const lines = wrap(pieces, size, width);
  if (lines.length <= MAX_LINES) return { size, lines, truncated: false };
  return { size, lines: truncate(lines, size, width), truncated: true };
}

/** og:image 的 ?v=：模板版本 + 语言 + 标题，标题改了社交平台就会重新抓图 */
export const ARTICLE_OG_TEMPLATE_VERSION = '1';
