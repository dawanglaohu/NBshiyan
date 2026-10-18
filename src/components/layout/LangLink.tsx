'use client';
import { useEffect, useState } from 'react';
import { usePathname as useRawPathname } from 'next/navigation';
import { useLocale } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { menuSwitchTarget, type Loc } from '@/lib/i18n/localeSwitch';
import { isBlockedLocalePath } from '@/lib/edge/locale-gate';
import { PUBLISHED_LOCALES, DEFAULT_PUBLISHED_LOCALE, isPublishedLocale } from '@/i18n/published-locales';
import { LOCALE_META } from '@/i18n/locale-meta';
import { useLocaleAlternates } from './LocaleAlternates';

const suffix = () => (typeof window === 'undefined' ? '' : window.location.search + window.location.hash);
const isPlainClick = (e: React.MouseEvent) => !(e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);

export type LangTarget = { locale: Loc; href: string; onClick: (e: React.MouseEvent<HTMLAnchorElement>) => void };

/**
 * 每个已发布语言的切换目标：保留当前路径以及 ?query 和 #hash（#124；usePathname 不含这两部分）。
 * 目标语言的对应页面（各语言 slug 不同）；没有对应页面时回退到列表页，不会 404。
 * 只用服务端 alternates / 站内固定路径生成，不读 query/hash/referrer；校验后去掉前缀交给 next-intl。
 * 返回顺序：当前语言在最前，其余按 PUBLISHED_LOCALES 顺序。
 */
export function useLangTargets(): { current: Loc; targets: LangTarget[] } {
  const rawLocale = useLocale();
  const current: Loc = isPublishedLocale(rawLocale) ? rawLocale : DEFAULT_PUBLISHED_LOCALE;
  const pathname = usePathname();
  // 地址栏的真实路径：未发布语言的 404 页（rewrite）上它是 /ja…，此时各项都指向对应语言首页
  const raw = useRawPathname();
  const router = useRouter();
  const alts = useLocaleAlternates(pathname);
  const [tail, setTail] = useState('');
  useEffect(() => {
    const sync = () => setTail(suffix());
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync); };
  }, [pathname]);
  const order = [current, ...PUBLISHED_LOCALES.filter((l) => l !== current)];
  const targets = order.map((to) => ({
    locale: to,
    href: menuSwitchTarget(raw, pathname, current, to, alts, tail),
    onClick: (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainClick(e)) return;
      // 点击时再读一次，覆盖 Next 路由 pushState 改了 hash/query 但没触发事件的情况
      e.preventDefault();
      if (to === current && !isBlockedLocalePath(raw ?? '')) return;
      router.push(menuSwitchTarget(raw, pathname, current, to, alts, suffix()), { locale: to });
    }
  }));
  return { current, targets };
}

/** 页脚用：其他已发布语言的普通链接（不依赖 JS，也是头部下拉在无 JS 时的兜底），文字是母语名称 */
export default function LangLinks({ className }: { className?: string }) {
  const { targets } = useLangTargets();
  return (
    <>
      {targets.slice(1).map((t) => (
        <Link key={t.locale} href={t.href} locale={t.locale} hrefLang={t.locale} lang={t.locale} dir={LOCALE_META[t.locale].dir} className={className} onClick={t.onClick}>
          {LOCALE_META[t.locale].nativeName}
        </Link>
      ))}
    </>
  );
}
