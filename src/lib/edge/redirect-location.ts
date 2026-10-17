// standalone / next start 下 req.url 用的是监听地址（如 http://localhost:3000），
// next-intl 用 new URL(path, req.url) 生成跳转，Location 就会指向内部地址。
// 这里只把主机名是回环或监听地址的 Location 改成相对路径；其它绝对地址（包括 geiom.com）一律不动。
// 判断只看 Location 自身，不读请求的 Host / X-Forwarded-Host，避免被伪造的头带成开放跳转。

const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** 主机名是否是回环或监听地址：localhost、127.0.0.0/8、::1、0.0.0.0、:: */
export function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  return h === 'localhost' || IPV4_LOOPBACK.test(h) || h === '::1' || h === '0.0.0.0' || h === '::';
}

/**
 * 如果 Location 是指向回环/监听地址的绝对 http(s) 地址，返回相对路径（pathname+search+hash，至少是 "/"）；
 * 否则返回 null，表示保持原样。
 */
export function internalLocationToRelative(location: string): string | null {
  // 已经是相对路径（但不是 // 开头的协议相对地址）就不用改
  if (!/^[a-z][a-z\d+.-]*:/i.test(location)) return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isInternalHostname(url.hostname)) return null;
  // WHATWG URL 对 http(s) 的 pathname 至少是 "/"，所以不会得到空的 Location；
  // 再把开头多个斜杠压成一个，避免生成 //evil.com 这种协议相对地址
  const path = url.pathname.replace(/^\/+/, '/') || '/';
  return path + url.search + url.hash;
}

/** 3xx 且 Location 指向内部地址时，原地改写 Location；其它头（cookie、rewrite 等）保持不变 */
export function relativizeInternalRedirect<T extends Response>(res: T): T {
  if (res.status < 300 || res.status >= 400) return res;
  const loc = res.headers.get('location');
  if (!loc) return res;
  const rel = internalLocationToRelative(loc);
  if (rel === null) return res;
  try {
    res.headers.set('location', rel);
    return res;
  } catch {
    // Response.redirect() 生成的头是只读的：复制一份响应，只换 Location，其余头原样保留
    const headers = new Headers(res.headers);
    headers.set('location', rel);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers }) as T;
  }
}
