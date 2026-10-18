import { getDocBySlug } from '@/lib/server/sanity';
import { renderArticleOgPng } from '@/lib/seo/og/renderArticleOg';
import { handleArticleOg } from '@/lib/seo/og/articleOgHandler';

// 文章专属分享图 /<locale>/articles/<slug>/og（1200×630 PNG）。og:image 由 src/lib/seo/articleOg.ts 输出（带 ?v=，这里不读）。
// 安全要求（全栈/安全审）：
// - 不读请求的其他内容（Host、X-Forwarded-Host、请求头、除 v 以外的查询参数都不用）；只用路径参数 locale + slug 和查询参数 v。
// - slug 先过白名单 ^[a-z0-9-]{1,120}$，不合规直接 404，不查 CMS、不渲染；locale 只认 en/ru。
// - #350（全栈 + PM）：v 必须等于当前标题的 articleOgVersion（与 og:image 里的 ?v= 同一函数）。缺 v、v 不对、
//   文章不存在 → 404 no-store，不渲染。URL 里的任何内容都不会画进图里（标题只来自 CMS）。
//   v 和内容一一对应，所以 200 可以 immutable 长缓存；标题改了 v 就变，旧 v 变 404（页面 / CMS 缓存期内短暂 404 属预期）。
// - v 正确但标题渲染不出来 / 字体或渲染出错 → 302 到该语言的通用图。Location 是相对路径 /og/home-<l>.jpg?v=…
//   （只取 ogImageUrl 的 path + query，不含主机名），能通过 #328 的同站跳转检查和 deploy/smoke-lib.sh 的 loc_bad。
// - 缓存：200 → public, max-age=31536000, immutable；302 / 404 → no-store。路由本身不做 ISR（force-dynamic），
//   响应头完全由这里决定；CMS 数据仍按 sanityFetch 的 revalidate 缓存。
// - 标题只作为 JSX 文本子节点交给 Satori（不解析 HTML），不进任何响应头。
// - 渲染只走 renderArticleOgPng（src/lib/seo/og/renderArticleOg.tsx，唯一入口）：字体只读仓库里的 src/assets/og-fonts，
//   标题先去掉字体外的字符（ogSafeText），Satori 不会去网上补字体或 emoji。
// - X-Robots-Tag: noindex 在这里设置（所有环境、所有响应），不靠 middleware；robots.txt 不加 Disallow（社交爬虫要能抓到图）。
// 逻辑在 src/lib/seo/og/articleOgHandler.ts（依赖注入，便于测试「v 格式不对时不查 CMS」）；这里只接真实依赖。
// 渲染结果先完整读进内存再返回：ImageResponse 是流式的，不读完的话渲染错误会在 200 之后才出现，回退不了。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { params: Promise<{ locale: string; slug: string }> };

export async function GET(req: Request, { params }: P) {
  const { locale, slug } = await params;
  return handleArticleOg(req.url, locale, slug, {
    getDoc: (l, s) => getDocBySlug('article', l, s),
    render: (title, l) => renderArticleOgPng(title, l),
  });
}
