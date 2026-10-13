import type { ReactNode } from 'react';
import { parsePortableText, type PtSpan } from '@/lib/server/portableText';

function renderSpan(s: PtSpan, i: number): ReactNode {
  let n: ReactNode = s.text;
  for (const m of s.marks) n = m === 'strong' ? <strong>{n}</strong> : m === 'em' ? <em>{n}</em> : <code>{n}</code>;
  return <span key={i}>{n}</span>;
}

export default function PortableText({ value }: { value: unknown }) {
  return (
    <>
      {parsePortableText(value).map((node, i) => {
        if (node.kind === 'list') {
          const items = node.items.map((s, j) => <li key={j}>{s.map(renderSpan)}</li>);
          return node.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        const Tag = node.style;
        return <Tag key={i}>{node.spans.map(renderSpan)}</Tag>;
      })}
    </>
  );
}
