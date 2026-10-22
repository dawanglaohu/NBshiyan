import { notFound } from 'next/navigation';

// 不预渲染、不缓存：静态 404 会带 s-maxage=31536000，CDN 会把 /ja 之类的 404 缓存一年，以后开放该语言时还得清缓存
export const dynamic = 'force-dynamic';

// 多语言第 0 期：middleware 把未发布 / 未知语言前缀 rewrite 到 /en/locale-unavailable。
// 页面本身永远 notFound()（真实 404 状态码），由同目录的 not-found.tsx 渲染专用 404 页；直接访问这个地址也一样是 404。
export default function LocaleUnavailablePage() {
  notFound();
}
