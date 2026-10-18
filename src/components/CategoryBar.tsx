'use client';
import { useEffect, useRef, useState } from 'react';

// 吸顶分类条：点击平滑滚到卡片锚点，滚动时用 IntersectionObserver 高亮当前分类
export default function CategoryBar({ items, label }: { items: { slug: string; name: string }[]; label: string }) {
  const [active, setActive] = useState(items[0]?.slug);
  const navRef = useRef<HTMLElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // 把分类条的实际高度写进 --catbar-h，卡片的 scroll-margin-top 用它（CSS 里有兜底值）；字体加载、换语言后高度变了会跟着更新
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const root = document.documentElement;
    const upd = () => root.style.setProperty('--catbar-h', `${wrap.getBoundingClientRect().height}px`);
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(wrap);
    return () => { ro.disconnect(); root.style.removeProperty('--catbar-h'); };
  }, []);
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
  // 两端渐隐遮罩和箭头：只在还能往该方向滚动时出现（#64）
  const [edges, setEdges] = useState({ l: false, r: false });
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const upd = () => setEdges({ l: nav.scrollLeft > 4, r: nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4 });
    upd();
    nav.addEventListener('scroll', upd, { passive: true });
    const ro = new ResizeObserver(upd);
    ro.observe(nav);
    return () => { nav.removeEventListener('scroll', upd); ro.disconnect(); };
  }, []);
  const page = (dir: 1 | -1) => navRef.current?.scrollBy({ left: dir * navRef.current.clientWidth * 0.7 });
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
    <div ref={wrapRef} className={`catbar-wrap${edges.l ? ' can-l' : ''}${edges.r ? ' can-r' : ''}`}>
      <button type="button" className="catbar-arrow l" tabIndex={-1} aria-hidden="true" onClick={() => page(-1)}>‹</button>
      <nav ref={navRef} className="catbar" aria-label={label}>
        {items.map((i) => (
          <a key={i.slug} data-slug={i.slug} href={`#${i.slug}`} className={active === i.slug ? 'on' : undefined} aria-current={active === i.slug ? 'true' : undefined} onClick={(e) => go(e, i.slug)}>{i.name}</a>
        ))}
      </nav>
      <button type="button" className="catbar-arrow r" tabIndex={-1} aria-hidden="true" onClick={() => page(1)}>›</button>
    </div>
  );
}
