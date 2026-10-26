import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import type { Block, CategoryArticle as Article, Inline } from '@/lib/seo/categoryMarkdown';

function renderInline(nodes: Inline[], prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}-${index}`;
    if (node.type === 'text') return node.text;
    if (node.type === 'code') return <code key={key}>{node.text}</code>;
    if (node.type === 'strong') return <strong key={key}>{renderInline(node.children, key)}</strong>;
    if (node.type === 'em') return <em key={key}>{renderInline(node.children, key)}</em>;
    const children = renderInline(node.children, key);
    if (node.external) return <a key={key} href={node.href} rel="noopener noreferrer">{children}</a>;
    if (node.href.startsWith('#')) return <a key={key} href={node.href}>{children}</a>;
    const href = node.href.replace(/^\/(?:en|ru)(?=\/|#|$)/, '') || '/';
    return <Link key={key} href={href}>{children}</Link>;
  });
}

function renderBlock(block: Block, key: string): ReactNode {
  if (block.type === 'p') return <p key={key}>{renderInline(block.children, key)}</p>;
  if (block.type === 'h3') return <h3 key={key}>{block.text}</h3>;
  if (block.type === 'ul' || block.type === 'ol') {
    const Tag = block.type === 'ul' ? 'ul' : 'ol';
    return <Tag key={key}>{block.items.map((item, index) => <li key={`${key}-${index}`}>{renderInline(item, `${key}-${index}`)}</li>)}</Tag>;
  }
  return (
    <table key={key}>
      {block.header && <thead><tr>{block.header.map((cell, index) => <th key={index}>{renderInline(cell, `${key}-h-${index}`)}</th>)}</tr></thead>}
      <tbody>
        {block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{renderInline(cell, `${key}-${rowIndex}-${index}`)}</td>)}</tr>)}
      </tbody>
    </table>
  );
}

/** 导语在 H1 和 3D 目录链接之间。正文标题从 H2 起。CTA 只显示按钮文字，不显示文案里的写作说明。 */
export default function CategoryArticle({ article, catalogHref, catalogLabel }: { article: Article; catalogHref: string; catalogLabel: string }) {
  return (
    <>
      <h1>{article.h1}</h1>
      {article.lead.length > 0 && <div className="lead" data-testid="category-lead">{article.lead.map((block, index) => renderBlock(block, `lead-${index}`))}</div>}
      <p className="catalog-return"><Link href={catalogHref} data-testid="catalog-return-link">{catalogLabel}</Link></p>
      {article.sections.map((section, index) => section.type === 'cta'
        ? <p key={`cta-${index}`} className="category-cta"><Link className="btn" href="/contact">{section.label}</Link></p>
        : <section key={`s-${index}`}>{section.id ? <h2 id={section.id}>{section.heading}</h2> : <h2>{section.heading}</h2>}{section.blocks.map((block, blockIndex) => renderBlock(block, `s-${index}-${blockIndex}`))}</section>)}
    </>
  );
}
