import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from './i18n/routing';
import { PUBLISHED_LOCALES } from './i18n/published-locales';
import { isBlockedLocalePath, LOCALE_GATE_REWRITE } from './lib/edge/locale-gate';
import { EXPIRED_RE, probeConfig, probeHeaders, probeShortlink, parseShortlink } from './lib/edge/shortlink';
import { resolveClientIp } from './lib/edge/client-ip';
import { listenOrigin, rewriteSameSiteRedirect } from './lib/edge/redirect-location';

// 语言检测（Accept-Language / NEXT_LOCALE cookie）只在已发布语言里选，`/` 不会被跳到未发布语言
const intl = createMiddleware({ ...routing, locales: PUBLISHED_LOCALES });
const NOINDEX = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store' };
const UNAVAILABLE = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'Retry-After': '60' };

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // /admin 只把当前路径交给服务端 layout 用作登录回跳（callbackUrl 在 layout 里再校验），不走多语言路由
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    const h = new Headers(req.headers);
    h.set('x-admin-path', pathname + req.nextUrl.search);
    return NextResponse.next({ request: { headers: h } });
  }
  // 过期页只能由下面的 rewrite 到达，直接访问一律 404
  if (EXPIRED_RE.test(pathname)) return new NextResponse(null, { status: 404, headers: NOINDEX });
  const sl = parseShortlink(pathname);
  if (sl) {
    const cfg = probeConfig(process.env);
    // 带内部密钥和原始客户端 IP，API 按客户端 IP 限流，而不是所有探测共用服务器 IP。
    // IP 和 API 一样走 resolveClientIp：只有 X-Edge-Auth 正确时才取 CF-Connecting-IP；不可信时不带 IP（探测按连接来源限流）
    const { ip } = resolveClientIp(req.headers, process.env);
    const probe = cfg ? await probeShortlink(cfg.origin, sl.id, fetch, Date.now(), probeHeaders(cfg.secret, ip)) : null;
    const locale = sl.locale ?? (/^ru\b/i.test(req.headers.get('accept-language') ?? '') ? 'ru' : 'en');
    if (probe?.unavailable) {
      // 数据库不可用：503 + Retry-After，不缓存，不暴露错误细节
      return NextResponse.rewrite(new URL(`/${locale}/s/unavailable`, req.url), { status: 503, headers: UNAVAILABLE });
    }
    if (probe?.expired) {
      const to = new URL(`/${locale}/s/expired`, req.url);
      to.search = probe.category ? `?category=${encodeURIComponent(probe.category)}` : '';
      return NextResponse.rewrite(to, { status: 410, headers: NOINDEX });
    }
    // 未过期、超时或出错：照常交给页面处理
    if (!sl.locale) return NextResponse.next();
  }
  // 多语言第 0 期：未发布 / 未知 / 非规范写法的语言前缀 → 404 + noindex，不跳转（白名单见 lib/edge/locale-gate.ts）。
  // rewrite 到 /en/locale-unavailable（真实 404，带头部页脚的英文 404 页），URL 不变；页面安全头照常由 next.config headers() 加上。
  // 目标用监听 origin（同 redirect-location.ts），路由层按站内 rewrite 处理，不走内部代理
  if (isBlockedLocalePath(pathname)) {
    return NextResponse.rewrite(new URL(LOCALE_GATE_REWRITE, listenOrigin(req.nextUrl) ?? req.nextUrl.origin), { status: 404, headers: NOINDEX });
  }
  // next-intl 的跳转地址基于 req.url（监听地址）：指向本站的 Location 改成监听 origin + 路径，由路由层输出相对 Location（/en）
  return rewriteSameSiteRedirect(req.nextUrl, intl(req));
}

// /admin、/api 和静态资源不走中间件；/s/<id> 只做过期检查，不走多语言路由
// 分享图接口不走中间件（否则 next-intl 会下发 NEXT_LOCALE cookie）：只排除这两个确切形状，locale 由路由自己按 PUBLISHED_LOCALES 校验
//   /<seg>/articles/<seg>/og、/<seg>/about/og（最后一段恰好是 og）。不按「最后一段是 og」泛排除，slug 叫 og 的普通页面照常走中间件。
export const config = { matcher: ['/((?!api|admin|s/|_next|_vercel|models|images|[^/]+/articles/[^/]+/og/?$|[^/]+/about/og/?$|.*\\..*).*)', '/s/:id', '/admin', '/admin/:path*'] };
