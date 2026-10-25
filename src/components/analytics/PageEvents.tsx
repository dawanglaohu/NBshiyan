'use client';
import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { noteNavigation } from '@/lib/client/analytics';

/** Emits page_view after a confirmed consent, on later pathname changes only. */
export default function PageEvents() {
  const pathname = usePathname();
  const locale = useLocale();
  useEffect(() => {
    if (locale !== 'en' && locale !== 'ru') return;
    noteNavigation(pathname || '/', locale);
  }, [pathname, locale]);
  return null;
}
