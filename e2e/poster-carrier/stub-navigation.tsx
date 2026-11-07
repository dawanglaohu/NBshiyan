import { createElement, type ReactNode } from 'react';

// 只替换 next-intl 的 Link/路由边界；保留真实 <a> 语义与传入属性（id/style/onClick）。
export function Link({ href, children, ...rest }: { href?: unknown; children?: ReactNode } & Record<string, unknown>) {
  const url = typeof href === 'string' ? href : '#';
  return createElement('a', { href: url, ...rest }, children);
}
export const redirect = () => undefined;
export const usePathname = () => '/en/products';
export const useRouter = () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined });
