// Sanity Portable Text 的最小、安全子集：只输出 React 文本节点，不用 dangerouslySetInnerHTML。
// 支持 normal/h2/h3/blockquote、bullet/number 列表、strong/em/code 标记，以及仅限 /en/、/ru/ 站内相对路径的 link 注解；图片和自定义块跳过（避免外链图片与 CSP 冲突）。
export type PtNode =
  | { kind: 'block'; style: 'p' | 'h2' | 'h3' | 'blockquote'; spans: PtSpan[] }
  | { kind: 'list'; ordered: boolean; items: PtSpan[][] };
export interface PtSpan { text: string; marks: ('strong' | 'em' | 'code')[]; href?: string }

const STYLES: Record<string, 'p' | 'h2' | 'h3' | 'blockquote'> = { normal: 'p', h2: 'h2', h3: 'h3', h4: 'h3', blockquote: 'blockquote' };
const MARKS = new Set(['strong', 'em', 'code']);

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// 站内链接白名单：只允许 /en/ 或 /ru/ 开头的同站相对路径，其余一律返回 null（渲染为纯文本）。
export function safeInternalHref(href: unknown): string | null {
  if (typeof href !== 'string' || !/^\/(en|ru)\//.test(href) || href.length > 2048) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(href) || href.startsWith('//') || SCHEME.test(href)) return null;
  let d = href;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try { next = decodeURIComponent(d); } catch { return null; }
    if (next === d) break;
    d = next;
    if (i === 4 && /%[0-9a-f]{2}/i.test(d)) return null;
  }
  if (d.includes('//') || d.includes('\\') || d.includes('..') || SCHEME.test(d) || /[\s\u0000-\u001f\u007f]/.test(d)) return null;
  let u: URL;
  try { u = new URL(href, 'https://x.invalid'); } catch { return null; }
  if (u.origin !== 'https://x.invalid') return null;
  if (!u.pathname.startsWith('/en/') && !u.pathname.startsWith('/ru/')) return null;
  return u.pathname + u.search + u.hash;
}

function linkDefs(markDefs: unknown): Map<string, string> {
  const m = new Map<string, string>();
  if (!Array.isArray(markDefs)) return m;
  for (const d of markDefs) {
    if (!d || typeof d !== 'object') continue;
    const { _key, _type, href } = d as { _key?: unknown; _type?: unknown; href?: unknown };
    if (_type !== 'link' || typeof _key !== 'string') continue;
    const safe = safeInternalHref(href);
    if (safe) m.set(_key, safe);
  }
  return m;
}

function spans(children: unknown, links: Map<string, string> = new Map()): PtSpan[] {
  if (!Array.isArray(children)) return [];
  return children.flatMap((c) => {
    if (!c || typeof c !== 'object' || (c as { _type?: unknown })._type !== 'span') return [];
    const text = (c as { text?: unknown }).text;
    if (typeof text !== 'string' || !text) return [];
    const m = (c as { marks?: unknown }).marks;
    const marks = (Array.isArray(m) ? m : []).filter((x): x is PtSpan['marks'][number] => typeof x === 'string' && MARKS.has(x));
    const href = (Array.isArray(m) ? m : []).map((x) => (typeof x === 'string' ? links.get(x) : undefined)).find(Boolean);
    return [href ? { text: text.slice(0, 10_000), marks, href } : { text: text.slice(0, 10_000), marks }];
  });
}

export function parsePortableText(value: unknown, maxBlocks = 500): PtNode[] {
  if (!Array.isArray(value)) return [];
  const out: PtNode[] = [];
  for (const b of value.slice(0, maxBlocks)) {
    if (!b || typeof b !== 'object' || (b as { _type?: unknown })._type !== 'block') continue;
    const blk = b as { style?: unknown; listItem?: unknown; children?: unknown; markDefs?: unknown };
    const s = spans(blk.children, linkDefs(blk.markDefs));
    if (!s.length) continue;
    if (blk.listItem === 'bullet' || blk.listItem === 'number') {
      const ordered = blk.listItem === 'number';
      const last = out[out.length - 1];
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(s);
      else out.push({ kind: 'list', ordered, items: [s] });
      continue;
    }
    out.push({ kind: 'block', style: STYLES[typeof blk.style === 'string' ? blk.style : 'normal'] ?? 'p', spans: s });
  }
  return out;
}
