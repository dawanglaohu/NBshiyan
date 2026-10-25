'use client';
import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { noteNavigation } from '@/lib/client/analytics';

/** Emits the loaded page view when analytics is already allowed, then later pathname changes while collection is on. */
export default function PageEvents() {
  const pathname = usePathname();
  const locale = useLocale();
  useEffect(() => {
    if (locale !== 'en' && locale !== 'ru') return;
    noteNavigation(pathname || '/', locale);
  }, [pathname, locale]);
  return null;
}
