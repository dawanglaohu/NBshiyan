'use client';
import { useEffect, useRef, useState } from 'react';

// 吸顶分类条：点击平滑滚到卡片锚点，滚动时用 IntersectionObserver 高亮当前分类
export default function CategoryBar({ items, label }: { items: { slug: string; name: string }[]; label: string }) {
  const [active, setActive] = useState(items[0]?.slug);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: '-140px 0px -55% 0px' });
    items.forEach((i) => { const el = document.getElementById(i.slug); if (el) io.observe(el); });
    return () => io.disconnect();
  }, [items]);
  // 当前项在手机横向滚动条里保持可见
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>(`[data-slug="${active}"]`);
    const nav = navRef.current;
    if (el && nav) nav.scrollTo({ left: el.offsetLeft - nav.clientWidth / 2 + el.clientWidth / 2, behavior: 'auto' });
  }, [active]);
  const go = (e: React.MouseEvent, slug: string) => {
    const el = document.getElementById(slug);
    if (!el) return;
    e.preventDefault();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    history.replaceState(null, '', `#${slug}`);
    setActive(slug);
  };
  return (
    <nav ref={navRef} className="catbar" aria-label={label}>
      {items.map((i) => (
        <a key={i.slug} data-slug={i.slug} href={`#${i.slug}`} className={active === i.slug ? 'on' : undefined} aria-current={active === i.slug ? 'true' : undefined} onClick={(e) => go(e, i.slug)}>{i.name}</a>
      ))}
    </nav>
  );
}
