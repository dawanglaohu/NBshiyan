import type { AboutContent } from '@/lib/server/site-settings';
import { isPublishedLocale, type PublishedLocale } from '@/lib/server/published-locales';

/**
 * #350 /<locale>/about/og 的处理逻辑（路由 src/app/[locale]/about/og/route.tsx 只是把真实依赖传进来；测试传假的）。
 * 规则（全栈 + PM 定稿）：
 * 1. locale 先过 isPublishedLocale；不通过 → 404 no-store，不读内容、不渲染。
 * 2. 内容只来自 getAboutContent；请求里只读查询参数 v，其他参数一律忽略，URL 里的任何东西都不会画进图里。
 * 3. 只有 v 等于当前内容的版本（SEO 的 aboutOgVersion(locale, title, badge)，和页面 og:image 的 ?v= 同一个函数）才渲染；
 *    缺 v、v 不对、内容为 null → 404 no-store，不渲染。v 格式（8 位小写 hex）先校验，不对就不读内容。
 * 角标 badge = 导航 About 的文案（Nav.about）；画出来的角标、v 校验、页面 buildAboutMetadata({ ogBadge }) 用同一个值。
 * 4. 200 → public, max-age=31536000, immutable（v 和内容一一对应）；404 / 出错 → no-store。所有响应 X-Robots-Tag: noindex。
 *    设置缓存 60 秒，内容刚改时旧 v 短暂 404 属预期。
 * 渲染只走 renderArticleOgPng（文章分享图唯一入口：1200×630、标题 + 品牌、本地字体、ogSafeText 过滤）。
 */
export type AboutOgDeps = {
  getAboutContent: (locale: PublishedLocale) => Promise<AboutContent | null>;
  /** 角标文案：Nav.about（该语言） */
  getBadge: (locale: 'en' | 'ru') => Promise<string>;
  /** 当前内容应有的 v；返回 null 表示这个标题不出专属图（SEO 用首页通用图） */
  expectedVersion: (locale: 'en' | 'ru', title: string, badge: string) => string | null;
  render: (title: string, locale: 'en' | 'ru', badge: string) => Promise<ArrayBuffer | null>;
};

const OG_ROBOTS = { 'X-Robots-Tag': 'noindex' } as const;
const NO_STORE = { ...OG_ROBOTS, 'Cache-Control': 'no-store' } as const;
const notFound = () => new Response(null, { status: 404, headers: NO_STORE });

/** 只读 v；不是 8 位小写十六进制就当没有 */
export const aboutOgVersionParam = (url: string): string | null => {
  const v = new URL(url).searchParams.get('v');
  return v && /^[0-9a-f]{8}$/.test(v) ? v : null;
};

export async function aboutOgResponse(reqUrl: string, locale: string, deps: AboutOgDeps): Promise<Response> {
  if (!isPublishedLocale(locale)) return notFound();
  // renderArticleOgPng 的字体只覆盖 en/ru；以后上线的语言要先确认模板字体再放开
  if (locale !== 'en' && locale !== 'ru') return notFound();
  const v = aboutOgVersionParam(reqUrl);
  if (!v) return notFound();
  try {
    const c = await deps.getAboutContent(locale);
    if (!c) return notFound();
    const badge = await deps.getBadge(locale);
    const expected = deps.expectedVersion(locale, c.title, badge);
    if (!expected || expected !== v) return notFound();
    const png = await deps.render(c.title, locale, badge);
    if (!png) return notFound();
    return new Response(png, { status: 200, headers: { ...OG_ROBOTS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  } catch (e) {
    console.error('[about-og] render failed:', e instanceof Error ? e.message : 'unknown error');
    return notFound();
  }
}
