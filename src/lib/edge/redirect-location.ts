// standalone / next start 下 req.url 用的是监听地址（如 http://localhost:3000），
// next-intl 用 new URL(path, req.url) 生成跳转，Location 就会指向内部地址（GET / -> http://localhost:3000/en）。
//
// Next 15 对 middleware 的 Location 有两层处理，所以不能在 middleware 里直接写相对路径：
// 1. middleware adapter 用 new NextURL(Location) 再解析一遍，相对路径直接抛 Invalid URL（500）；
// 2. 路由层（router-utils/resolve-routes）用 getRelativeURL(Location, initURL) 把和 initURL 同 origin 的 Location 改成相对路径。
//    initURL = `${协议}://${HOSTNAME}:${端口}`，协议和端口跟 middleware 的 req.url 相同，但主机名用的是启动时的 HOSTNAME
//    （HOSTNAME=0.0.0.0 时是 0.0.0.0，HOSTNAME=127.0.0.1 时是 127.0.0.1），而 req.url 的主机名可能是 localhost。
// 所以这里把指向本站的 Location 改写成"监听 origin + 路径"，由路由层输出相对 Location（/en）。
// HOSTNAME 不是回环/未指定地址（或拿不到）时，退回 NEXT_PUBLIC_SITE_URL 的 origin（https://geiom.com/en），保证 Location 里不会出现内部地址。
//
// "本站"只由两样决定：回环/监听地址，以及 NEXT_PUBLIC_SITE_URL 的 origin。判断只看 Location 自身和配置，
// 不读请求的 Host / X-Forwarded-Host，避免被伪造的头带成开放跳转。其它主机的绝对地址一律不动。

const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** 主机名是否是回环或监听地址：localhost、127.0.0.0/8、::1、0.0.0.0、:: */
export function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  return h === 'localhost' || IPV4_LOOPBACK.test(h) || h === '::1' || h === '0.0.0.0' || h === '::';
}

/** NEXT_PUBLIC_SITE_URL 的 origin；未设置、无效、非 http(s) 时为 null */
export function siteOrigin(site: string | undefined): string | null {
  if (!site?.trim()) return null;
  try {
    const u = new URL(site.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** 把开头连续的 / 和 \ 压成一个 /，保证路径不会被当成 //host 协议相对地址 */
export function collapseLeadingSlashes(path: string): string {
  return path.replace(/^[/\\]+/, '/') || '/';
}

/** 相对 Location 是否安全：正好一个 / 开头，后面不是 / 或 \；不含反斜杠、空白和控制字符 */
export function isSafeRelativeLocation(path: string): boolean {
  return /^\/(?![/\\])/.test(path) && !/[\\\s\u0000-\u001f\u007f]/.test(path);
}

/**
 * Location 是指向回环/监听地址或 NEXT_PUBLIC_SITE_URL 的 origin 的绝对 http(s) 地址时，
 * 返回相对路径（pathname+search+hash，至少是 "/"，开头只有一个 /）；否则返回 null，表示保持原样。
 */
export function sameSiteRedirectPath(location: string, site: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): string | null {
  // 只处理绝对 http(s) 地址；相对路径和 //host 协议相对地址保持原样（next-intl 不会生成这两种）
  if (!/^https?:\/\//i.test(location)) return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (!isInternalHostname(url.hostname) && url.origin !== siteOrigin(site)) return null;
  // WHATWG URL 对 http(s) 的 pathname 至少是 "/"，不会得到空路径；URL 序列化后不含空白和反斜杠
  const out = collapseLeadingSlashes(url.pathname) + url.search + url.hash;
  return isSafeRelativeLocation(out) ? out : null;
}

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 路由层 initURL 的主机名在 Location 里的写法。Next 的 NextURL 会把 127.0.0.1 / [::1] 统一改成 localhost
 * （next/dist/server/web/next-url 的 REGEX_LOCALHOST_HOSTNAME），middleware adapter 在主机和 req.url 相同时又会用
 * 改过的值覆盖 Location，结果和 initURL（127.0.0.1）对不上，路由层就不再改成相对路径。
 * 所以 127.a.b.c 写成等价的三段式 127.a.(b*256+c)、::1 写成 [0:0:0:0:0:0:0:1]：NextURL 不会改写，
 * 路由层用 new URL() 解析后和 initURL 同 origin，最后输出相对 Location。
 */
function routerHost(host: string): string | null {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === '0.0.0.0' || h === 'localhost') return h;
  if (h === '::') return '[::]';
  if (h === '::1') return '[0:0:0:0:0:0:0:1]';
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m && IPV4_LOOPBACK.test(h)) return `127.${Number(m[1])}.${Number(m[2]) * 256 + Number(m[3])}`;
  return null;
}

/**
 * 路由层 initURL 的 origin：协议、端口取自 req.url（Next 按监听端口和 X-Forwarded-Proto 生成，不含 Host 头），
 * 主机名取启动时的 HOSTNAME（未设置时 standalone 默认 0.0.0.0）。只接受回环/未指定地址，其它返回 null。
 */
export function listenOrigin(reqUrl: URL, hostnameEnv: string | undefined = process.env.HOSTNAME): string | null {
  const host = routerHost(hostnameEnv?.trim() || '0.0.0.0');
  if (!host || !reqUrl.port) return null;
  return `${reqUrl.protocol}//${host}:${reqUrl.port}`;
}

/** 3xx 且 Location 指向本站时改写 Location（监听 origin 或 SITE_URL origin + 路径）；其它头（cookie 等）保持不变 */
export function rewriteSameSiteRedirect<T extends Response>(reqUrl: URL, res: T, env: { HOSTNAME?: string; NEXT_PUBLIC_SITE_URL?: string } = {
  HOSTNAME: process.env.HOSTNAME, NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL
}): T {
  if (!REDIRECT_STATUSES.has(res.status)) return res;
  const loc = res.headers.get('location');
  const path = loc ? sameSiteRedirectPath(loc, env.NEXT_PUBLIC_SITE_URL) : null;
  if (path === null) return res;
  const origin = listenOrigin(reqUrl, env.HOSTNAME) ?? siteOrigin(env.NEXT_PUBLIC_SITE_URL);
  if (!origin) return res;
  const next = origin + path;
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
