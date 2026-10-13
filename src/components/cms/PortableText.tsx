import type { ReactNode } from 'react';
import Link from 'next/link';
import { parsePortableText, type PtSpan } from '@/lib/server/portableText';

function renderSpan(s: PtSpan, i: number): ReactNode {
  let n: ReactNode = s.text;
  for (const m of s.marks) n = m === 'strong' ? <strong>{n}</strong> : m === 'em' ? <em>{n}</em> : <code>{n}</code>;
  // href 已在 parsePortableText 中经 safeInternalHref 校验；不加 target=_blank。
  if (s.href) return <Link key={i} href={s.href}>{n}</Link>;
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
