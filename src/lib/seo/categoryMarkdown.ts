import { readFileSync } from 'node:fs';
import path from 'node:path';
import { categoryMeta } from './categoryMeta';
import { CATEGORY_MARKDOWN_BODIES } from './categoryMarkdownBodies';

/**
 * 品类页正文。只解析这些文案实际用到的子集：标题、段落、列表、表格、链接、强调、行内代码。
 * 不引入 markdown 库。输出结构化数据，由 React 文本节点渲染，不走 HTML 字符串。
 * 含 `{{` 的段落、列表项、表格行整块丢弃；一节因此没有正文时连标题一起不显示。
 * 块引用（给校对看的 `>` 提示）和 HTML 注释不渲染。原始 HTML 标签去掉，`script` / `style` 连内容去掉。
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; href: string; external: boolean; children: Inline[] };

export type Block =
  | { type: 'p'; children: Inline[] }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; items: Inline[][] }
  | { type: 'h3'; text: string }
  | { type: 'table'; header: Inline[][] | null; rows: Inline[][][] };

export type ArticleSection =
  | { type: 'section'; heading: string; id?: string; blocks: Block[] }
  | { type: 'cta'; label: string };

export type CategoryArticle = {
  h1: string;
  lead: Block[];
  sections: ArticleSection[];
};

const DIR = path.join(process.cwd(), 'docs', 'content', 'category-pages');

export function readCategoryMarkdown(key: string, locale: 'en' | 'ru', read: (file: string) => string = (file) => readFileSync(file, 'utf8')): string | null {
  if (locale !== 'en' && locale !== 'ru') return null;
  if (!/^[a-z0-9-]+$/.test(key) || !categoryMeta.some((c) => c.key === key)) return null;
  const bundled = CATEGORY_MARKDOWN_BODIES[key]?.[locale] ?? null;
  const root = path.resolve(DIR);
  const file = path.resolve(root, `${key}.${locale}.md`);
  if (file !== path.join(root, `${key}.${locale}.md`)) return null;
  try {
    return read(file);
  } catch {
    // Docker 构建排除整个 docs/。副本打进服务端包，文件不在时仍能渲染同一份正文。
    return bundled;
  }
}

export function loadCategoryArticle(key: string, locale: 'en' | 'ru'): CategoryArticle | null {
  const src = readCategoryMarkdown(key, locale);
  return src == null ? null : parseCategoryMarkdown(src);
}

function scrub(src: string): string {
  return src
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

function stripTags(s: string): string {
  return s.replace(/<\/?[a-zA-Z][^>\n]*>/g, '');
}

const blocked = (s: string) => s.includes('{{') || /<script/i.test(s);

/** http(s) 或站内路径 / 页内锚点。其它协议（含 javascript:）丢弃。 */
export function sanitizeHref(raw: string): { href: string; external: boolean } | null {
  const href = raw.trim();
  if (!href || /[\u0000-\u001f\s]/.test(href) || href.startsWith('//')) return null;
  const colon = href.indexOf(':');
  if (colon !== -1) {
    const scheme = href.slice(0, colon).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
    let url: URL;
    try { url = new URL(href); } catch { return null; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return { href: url.href, external: true };
  }
  if (href.startsWith('#')) return /^#[A-Za-z0-9_-]+$/.test(href) ? { href, external: false } : null;
  if (!href.startsWith('/') || href.includes('\\')) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(href); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('//') || /[\u0000-\u001f]/.test(decoded) || /(^|\/)\.\.(\/|$)/.test(decoded)) return null;
  return { href, external: false };
}

function tryLink(s: string, i: number): { nodes: Inline[]; next: number } | null {
  if (s[i] !== '[') return null;
  const close = s.indexOf(']', i + 1);
  if (close < 0 || s[close + 1] !== '(') return null;
  const end = s.indexOf(')', close + 2);
  if (end < 0) return null;
  const children = parseInline(s.slice(i + 1, close));
  const safe = sanitizeHref(s.slice(close + 2, end));
  if (!safe) return { nodes: children, next: end + 1 };
  return { nodes: [{ type: 'link', href: safe.href, external: safe.external, children }], next: end + 1 };
}

export function parseInline(input: string): Inline[] {
  const s = stripTags(input);
  const out: Inline[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
  for (let i = 0; i < s.length;) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) { flush(); out.push({ type: 'code', text: s.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end !== -1) { flush(); out.push({ type: 'strong', children: parseInline(s.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if (s[i] === '*' && s[i + 1] !== '*') {
      const end = s.indexOf('*', i + 1);
      if (end > i + 1 && s[end + 1] !== '*') { flush(); out.push({ type: 'em', children: parseInline(s.slice(i + 1, end)) }); i = end + 1; continue; }
    }
    if (s[i] === '[') {
      const link = tryLink(s, i);
      if (link) { flush(); out.push(...link.nodes); i = link.next; continue; }
    }
    buf += s[i];
    i += 1;
  }
  flush();
  return out;
}

export function inlinePlain(nodes: Inline[]): string {
  return nodes.map((n) => n.type === 'text' || n.type === 'code' ? n.text : inlinePlain(n.children)).join('');
}

function blockPlain(block: Block): string {
  if (block.type === 'p' || block.type === 'h3') return block.type === 'h3' ? block.text : inlinePlain(block.children);
  if (block.type === 'ul' || block.type === 'ol') return block.items.map((item) => inlinePlain(item)).join(' ');
  const rows = [...(block.header ? [block.header] : []), ...block.rows];
  return rows.map((row) => row.map((cell) => inlinePlain(cell)).join(' ')).join(' ');
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((cell) => cell.trim());
}

function isTableSep(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseTable(lines: string[]): Block | null {
  let header: string[] | null = null;
  const body: string[][] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isTableSep(line)) {
      if (!header && body.length) { header = body.pop() ?? null; }
      continue;
    }
    if (blocked(line)) continue;
    body.push(splitRow(line));
  }
  if (header && blocked(header.join('|'))) header = null;
  const cells = (row: string[]) => row.map((cell) => parseInline(cell));
  const rows = body.filter((row) => row.some((cell) => cell.trim())).map(cells);
  const head = header && header.some((cell) => cell.trim()) ? cells(header) : null;
  if (!head && !rows.length) return null;
  return { type: 'table', header: head, rows };
}

type Draft =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'table'; lines: string[] };

function draftBlock(draft: Draft): Block | null {
  if (draft.kind === 'p') {
    const raw = draft.lines.join('\n');
    if (blocked(raw)) return null;
    const text = draft.lines.join(' ').trim();
    return text ? { type: 'p', children: parseInline(text) } : null;
  }
  if (draft.kind === 'table') return parseTable(draft.lines);
  const items = draft.items.filter((item) => !blocked(item)).map((item) => parseInline(item.trim())).filter((item) => inlinePlain(item).trim());
  return items.length ? { type: draft.kind, items } : null;
}

function headingText(raw: string): string {
  return inlinePlain(parseInline(raw)).replace(/\s+/g, ' ').trim();
}

function normHeading(heading: string): string {
  return heading.trim().toLowerCase().replaceAll('ё', 'е');
}

function sectionId(heading: string): string | undefined {
  const n = normHeading(heading);
  return n === 'faq' || n === 'вопросы и ответы' ? 'faq' : undefined;
}

function ctaLabel(blocks: Block[]): string {
  return blocks.map(blockPlain).join(' ').replace(/\s+/g, ' ').split('→')[0].trim();
}

type OpenSection = { heading: string; intro: boolean; cta: boolean; blocks: Block[] };

export function parseCategoryMarkdown(src: string): CategoryArticle | null {
  const lines = scrub(src).split('\n');
  let h1 = '';
  let draft: Draft | null = null;
  let skipping = false;
  let current: OpenSection | null = null;
  const lead: Block[] = [];
  const sections: ArticleSection[] = [];

  const flush = () => {
    if (!draft) return;
    const block = draftBlock(draft);
    draft = null;
    if (!block || skipping) return;
    if (current) current.blocks.push(block);
    else lead.push(block);
  };

  const close = () => {
    flush();
    if (!current) return;
    const section = current;
    current = null;
    if (!section.blocks.length) return;
    if (section.intro) { lead.push(...section.blocks); return; }
    if (section.cta) {
      const label = ctaLabel(section.blocks);
      if (label) sections.push({ type: 'cta', label });
      return;
    }
    sections.push({ type: 'section', heading: section.heading, id: sectionId(section.heading), blocks: section.blocks });
  };

  for (const line of lines) {
    const quote = /^\s*>/.test(line);
    const heading = /^(#{1,6})\s+(\S.*)$/.exec(line);
    const ul = /^[-*]\s+(.+)$/.exec(line);
    const ol = /^\d+[.)]\s+(.+)$/.exec(line);
    const table = /^\s*\|/.test(line);
    if (quote || heading || line.trim() === '') flush();
    if (quote || line.trim() === '') continue;
    if (heading) {
      const level = heading[1].length;
      const text = headingText(heading[2]);
      if (level >= 3 && current && !skipping && text && !blocked(heading[2])) {
        current.blocks.push({ type: 'h3', text });
        continue;
      }
      close();
      if (level === 1 && !h1 && text && !blocked(heading[2])) { h1 = text; skipping = false; continue; }
      if (!text || blocked(heading[2])) { skipping = true; continue; }
      skipping = false;
      const name = normHeading(text);
      current = { heading: text, intro: name === 'intro' || name === 'вступление', cta: name === 'cta', blocks: [] };
      continue;
    }
    if (skipping) continue;
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      const item = (ul ?? ol)![1];
      if (!draft || draft.kind !== kind) { flush(); draft = { kind, items: [item] }; }
      else draft.items.push(item);
      continue;
    }
    if (table) {
      if (!draft || draft.kind !== 'table') { flush(); draft = { kind: 'table', lines: [line] }; }
      else draft.lines.push(line);
      continue;
    }
    if (!draft || draft.kind !== 'p') { flush(); draft = { kind: 'p', lines: [line.trim()] }; }
    else draft.lines.push(line.trim());
  }
  close();
  if (!h1) return null;
  return { h1, lead, sections };
}

export function categoryArticleText(article: CategoryArticle): string {
  const parts = [article.h1, ...article.lead.map(blockPlain)];
  for (const section of article.sections) {
    if (section.type === 'cta') parts.push(section.label);
    else parts.push(section.heading, ...section.blocks.map(blockPlain));
  }
  return parts.join('\n');
}

export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const match = flat.match(/^.*?[.!?。！？](?=\s|$)/);
  return (match ? match[0] : flat).trim();
}

/** 导语首句包含 categoryMeta 关键词，或 H1 里某个实词的词干（兼容俄语变格和同义改写）。 */
export function introHasCoreTerm(sentence: string, h1: string, keyword: string): boolean {
  const norm = (s: string) => s.toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();
  const hay = norm(sentence);
  if (!hay) return false;
  if (hay.includes(norm(keyword))) return true;
  return norm(h1).split(' ').filter((word) => word.length >= 4).some((word) => hay.includes(word.slice(0, Math.min(5, word.length))));
}
