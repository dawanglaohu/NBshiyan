'use client';
import { useEffect, useSyncExternalStore } from 'react';
import type { LocaleAlternates as Alts } from '@/lib/i18n/localeSwitch';

// 当前页面的各语言对应路径（详情页在服务端拿到各语言 slug 后渲染 <LocaleAlternates>）
let current: { path: string; alts: Alts } | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function useLocaleAlternates(pathname: string): Alts | null {
  const v = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => current, () => null);
  return v && v.path === pathname ? v.alts : null;
}

/** pathname：不含 locale 前缀的当前路径，避免客户端跳转后沿用上一页的数据 */
export default function LocaleAlternates({ pathname, value }: { pathname: string; value: Alts }) {
  const key = JSON.stringify(value);
  useEffect(() => {
    current = { path: pathname, alts: JSON.parse(key) };
    emit();
    return () => { if (current?.path === pathname) { current = null; emit(); } };
  }, [pathname, key]);
  return null;
}
