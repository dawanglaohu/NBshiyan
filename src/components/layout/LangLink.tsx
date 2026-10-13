'use client';
import { useLocale } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';

// 切换到另一种语言，保留当前页面路径
export default function LangLink({ className, label }: { className?: string; label?: string }) {
  const locale = useLocale();
  const pathname = usePathname();
  const other = locale === 'en' ? 'ru' : 'en';
  return <Link href={pathname} locale={other} hrefLang={other} className={className}>{label ?? other.toUpperCase()}</Link>;
}
