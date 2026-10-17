// standalone / next start 下 req.url 用的是监听地址（如 http://localhost:3000），
// next-intl 用 new URL(path, req.url) 生成跳转，Location 就会指向内部地址（GET / -> http://localhost:3000/en）。
//
// 为什么不改成相对路径：Next 15 的 middleware adapter（next/dist/server/web/adapter）会用 new NextURL(Location)
// 再解析一遍 Location，相对路径直接抛 Invalid URL（页面 500）；而且主机和 req.url 相同时它会把 Location 重新写回
// 绝对地址。所以这里改成 NEXT_PUBLIC_SITE_URL 的 origin + 路径（https://geiom.com/en）。
//
// "本站"只由两样决定：回环/监听地址，以及 NEXT_PUBLIC_SITE_URL 的 origin。判断只看 Location 自身和构建时配置，
// 不读请求的 Host / X-Forwarded-Host，避免被伪造的头带成开放跳转。其它主机的绝对地址一律不动。

const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** 主机名是否是回环或监听地址：localhost、127.0.0.0/8、::1、0.0.0.0、:: */
export function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  return h === 'localhost' || IPV4_LOOPBACK.test(h) || h === '::1' || h === '0.0.0.0' || h === '::';
}

/** NEXT_PUBLIC_SITE_URL 的 origin；未设置、无效、非 http(s) 或本身就是本机地址（开发环境）时为 null */
export function publicSiteOrigin(site: string | undefined): string | null {
  if (!site?.trim()) return null;
  try {
    const u = new URL(site.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isInternalHostname(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** 把开头连续的 / 和 \ 压成一个 /，保证路径不会被当成 //host 协议相对地址 */
export function collapseLeadingSlashes(path: string): string {
  return path.replace(/^[/\\]+/, '/') || '/';
}

/**
 * Location 指向回环/监听地址或 NEXT_PUBLIC_SITE_URL 的 origin 时，返回 `<SITE_URL origin><路径>`
 * （路径 = pathname+search+hash，至少是 "/"，开头只有一个 /）；不需要改时返回 null。
 * SITE_URL 不可用时（未设置、无效、本机地址）不改：相对路径过不了 Next 的 adapter。
 */
export function canonicalizeRedirectLocation(location: string, site: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): string | null {
  const origin = publicSiteOrigin(site);
  if (!origin) return null;
  // 只处理绝对 http(s) 地址；相对路径和 //host 协议相对地址保持原样（next-intl 不会生成这两种）
  if (!/^https?:\/\//i.test(location)) return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (!isInternalHostname(url.hostname) && url.origin !== origin) return null;
  // WHATWG URL 对 http(s) 的 pathname 至少是 "/"，不会得到空路径
  const out = origin + collapseLeadingSlashes(url.pathname) + url.search + url.hash;
  return out === location ? null : out;
}

/** 3xx 且 Location 指向本机/本站时改写 Location；其它头（cookie、rewrite 等）保持不变 */
export function canonicalizeRedirect<T extends Response>(res: T): T {
  if (res.status < 300 || res.status >= 400) return res;
  const loc = res.headers.get('location');
  if (!loc) return res;
  const next = canonicalizeRedirectLocation(loc);
  if (next === null) return res;
  try {
    res.headers.set('location', next);
    return res;
  } catch {
    // Response.redirect() 生成的头是只读的：复制一份响应，只换 Location，其余头原样保留
    const headers = new Headers(res.headers);
    headers.set('location', next);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers }) as T;
  }
}
