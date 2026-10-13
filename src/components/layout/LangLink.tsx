'use client';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/navigation';

const suffix = () => (typeof window === 'undefined' ? '' : window.location.search + window.location.hash);

/** 语言切换链接：保留当前路径以及 ?query 和 #hash（#124；usePathname 不含这两部分） */
export function useLangSwitch() {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const other = locale === 'en' ? 'ru' : 'en';
  const [tail, setTail] = useState('');
  useEffect(() => {
    const sync = () => setTail(suffix());
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync); };
  }, [pathname]);
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // 点击时再读一次，覆盖 Next 路由 pushState 改了 hash/query 但没触发事件的情况
    e.preventDefault();
    router.push(pathname + suffix(), { locale: other });
  };
  return { other, href: pathname + tail, onClick };
}

export default function LangLink({ className, label }: { className?: string; label?: string }) {
  const { other, href, onClick } = useLangSwitch();
  return <Link href={href} locale={other} hrefLang={other} className={className} onClick={onClick}>{label ?? other.toUpperCase()}</Link>;
}
