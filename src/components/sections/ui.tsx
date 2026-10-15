import type { ReactNode } from 'react';
import Image from 'next/image';
import { Link } from '@/i18n/navigation';

// #108 共用区块组件（design-notes/107-for-108.md §2）。样式在 sections.css，只用 tokens.css 变量。

export function SectionHeader({ eyebrow, title, lead, as: H = 'h2', id }: { eyebrow?: string; title: string; lead?: string; as?: 'h1' | 'h2'; id?: string }) {
  return (
    <header className="sx-head">
      {eyebrow && <p className="sx-eyebrow">{eyebrow}</p>}
      <H id={id} className="sx-h">{title}</H>
      {lead && <p className="sx-lead">{lead}</p>}
    </header>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="sx-tag">{children}</span>;
}

/** 斜纹占位 + 目标路径；有 src 才用 next/image，加载中/失败都保留占位底色 */
export function ImagePlaceholder({ path, src, alt = '', ratio = '4 / 3' }: { path: string; src?: string; alt?: string; ratio?: string }) {
  return (
    <div className="sx-img" style={{ aspectRatio: ratio }}>
      {src ? <Image src={src} alt={alt} fill sizes="(max-width:767px) 100vw, 33vw" /> : <span aria-hidden="true">{path}</span>}
    </div>
  );
}

/** 整卡可点用 stretched-link：只有底部链接一个 tab 停留 */
export function Card({ href, title, desc, tags = [], more, image }: { href?: string; title: string; desc?: string; tags?: string[]; more?: string; image?: ReactNode }) {
  return (
    <article className={`sx-card${href ? ' is-link' : ''}`}>
      {image}
      <div className="sx-card-body">
        <h3>{title}</h3>
        {desc && <p className="sx-desc">{desc}</p>}
        {tags.length > 0 && <div className="sx-tags">{tags.map((t) => <Tag key={t}>{t}</Tag>)}</div>}
        {href && more && <Link href={href} className="sx-more">{more} <span aria-hidden="true">→</span><span className="sx-sr"> — {title}</span></Link>}
      </div>
    </article>
  );
}

export function Kpi({ value, label }: { value: string; label: string }) {
  return <div className="sx-kpi"><b>{value}</b><span>{label}</span></div>;
}

export function Steps({ items }: { items: { title: string; desc?: string }[] }) {
  return (
    <ol className="sx-steps">
      {items.map((s, i) => (
        <li key={s.title}>
          <span className="sx-step-n" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
          <b className="sx-step-name">{s.title}</b>
          {s.desc && <p className="sx-step-desc">{s.desc}</p>}
        </li>
      ))}
    </ol>
  );
}

export function CertBadge({ children }: { children: ReactNode }) {
  return <span className="sx-cert">{children}</span>;
}

type BtnProps = { children: ReactNode; variant?: 'primary' | 'ghost'; href?: string; disabled?: boolean; loading?: boolean; onClick?: () => void };
export function Button({ children, variant = 'primary', href, disabled, loading, onClick }: BtnProps) {
  const cls = `sx-btn sx-btn-${variant}`;
  if (href && !disabled) return <Link href={href} className={cls}>{children}</Link>;
  return (
    <button type="button" className={cls} aria-disabled={disabled || undefined} aria-busy={loading || undefined}
      onClick={disabled || loading ? undefined : onClick}>
      {loading && <i className="sx-spin" aria-hidden="true" />}<span className={loading ? 'sx-hide' : undefined}>{children}</span>
    </button>
  );
}

export function CtaBand({ title, cta, href = '/contact' }: { title: string; cta: string; href?: string }) {
  return (
    <section className="sx-cta">
      <h3>{title}</h3>
      <Button href={href}>{cta}</Button>
    </section>
  );
}
