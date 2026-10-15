'use client';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { langSwitchTarget, type Loc } from '@/lib/i18n/localeSwitch';
import { useLocaleAlternates } from './LocaleAlternates';

const suffix = () => (typeof window === 'undefined' ? '' : window.location.search + window.location.hash);

/** 语言切换链接：保留当前路径以及 ?query 和 #hash（#124；usePathname 不含这两部分） */
export function useLangSwitch() {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const alts = useLocaleAlternates(pathname);
  const other: Loc = locale === 'en' ? 'ru' : 'en';
  // 目标语言的对应页面（各语言 slug 不同）；没有对应页面时回退到列表页，不会 404
  // 只用服务端 alternates / 站内固定路径生成，不读 query/hash/referrer；校验后去掉前缀交给 next-intl
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
    router.push(langSwitchTarget(pathname, locale as Loc, other, alts, suffix()), { locale: other });
  };
  return { other, href: langSwitchTarget(pathname, locale as Loc, other, alts, tail), onClick };
}

export default function LangLink({ className, label }: { className?: string; label?: string }) {
  const { other, href, onClick } = useLangSwitch();
  return <Link href={href} locale={other} hrefLang={other} className={className} onClick={onClick}>{label ?? other.toUpperCase()}</Link>;
}
