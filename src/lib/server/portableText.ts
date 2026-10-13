// Sanity Portable Text 的最小、安全子集：只输出 React 文本节点，不用 dangerouslySetInnerHTML。
// 支持 normal/h2/h3/blockquote、bullet/number 列表、strong/em/code 标记；图片和自定义块跳过（避免外链图片与 CSP 冲突）。
export type PtNode =
  | { kind: 'block'; style: 'p' | 'h2' | 'h3' | 'blockquote'; spans: PtSpan[] }
  | { kind: 'list'; ordered: boolean; items: PtSpan[][] };
export interface PtSpan { text: string; marks: ('strong' | 'em' | 'code')[] }

const STYLES: Record<string, 'p' | 'h2' | 'h3' | 'blockquote'> = { normal: 'p', h2: 'h2', h3: 'h3', h4: 'h3', blockquote: 'blockquote' };
const MARKS = new Set(['strong', 'em', 'code']);

function spans(children: unknown): PtSpan[] {
  if (!Array.isArray(children)) return [];
  return children.flatMap((c) => {
    if (!c || typeof c !== 'object' || (c as { _type?: unknown })._type !== 'span') return [];
    const text = (c as { text?: unknown }).text;
    if (typeof text !== 'string' || !text) return [];
    const m = (c as { marks?: unknown }).marks;
    const marks = (Array.isArray(m) ? m : []).filter((x): x is PtSpan['marks'][number] => typeof x === 'string' && MARKS.has(x));
    return [{ text: text.slice(0, 10_000), marks }];
  });
}

export function parsePortableText(value: unknown, maxBlocks = 500): PtNode[] {
  if (!Array.isArray(value)) return [];
  const out: PtNode[] = [];
  for (const b of value.slice(0, maxBlocks)) {
    if (!b || typeof b !== 'object' || (b as { _type?: unknown })._type !== 'block') continue;
    const blk = b as { style?: unknown; listItem?: unknown; children?: unknown };
    const s = spans(blk.children);
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
