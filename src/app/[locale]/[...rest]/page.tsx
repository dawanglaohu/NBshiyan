import { notFound } from 'next/navigation';

// 未匹配的 /{locale}/... 路径交给 [locale]/not-found.tsx，显示本地化的 404（真实 404 状态码，#195）
export default function CatchAll() {
  notFound();
}
