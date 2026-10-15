/**
 * 上线冒烟检查（只读）：pnpm smoke --base https://example.com [--privacy-indexed] [--timeout 10000]
 * - 只发 GET/HEAD；唯一的 POST 是不带签名的 Sanity webhook 请求，预期被拒（401）。
 * - 不发送任何密钥、Cookie 或 Authorization 头；redirect: 'manual'，只跟随同源跳转（最多 5 次），跨域跳转直接判 FAIL。
 * - 每个请求有超时。任一检查 FAIL 时退出码为 1。
 */
export type Fetch = typeof fetch;
export type Result = { name: string; ok: boolean; detail: string };
export type Res = { status: number; headers: Headers; body: string; url: string; chain: string[] };

export const SANITY_WEBHOOK_PATH = '/api/sanity/revalidate';
const UA = 'packjoyu-smoke/1.0';

export function parseArgs(argv: string[]) {
  let base: string | undefined; let privacyIndexed = false; let timeout = 10_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') base = argv[++i];
    else if (a.startsWith('--base=')) base = a.slice(7);
    else if (a === '--privacy-indexed') privacyIndexed = true;
    else if (a === '--timeout') timeout = Number(argv[++i]);
    else if (a === '--') continue;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!base) throw new Error('--base <url> is required');
  return { base: normalizeBase(base), privacyIndexed, timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000 };
}

/** 只接受 http(s)，不带用户名密码、query、hash；返回 origin（去掉末尾 /） */
export function normalizeBase(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`--base is not a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('--base must be http(s)');
  if (u.username || u.password) throw new Error('--base must not contain credentials');
  if (u.search || u.hash) throw new Error('--base must not contain query or hash');
  if (u.pathname !== '/' && u.pathname !== '') throw new Error('--base must be an origin (no path)');
  return new URL(u.origin);
}

/** 同源跳转最多跟 5 次；跨域或非 http(s) 跳转抛错，不会请求外部主机 */
export async function get(f: Fetch, base: URL, path: string, opt: { method?: 'GET' | 'HEAD' | 'POST'; body?: string; headers?: Record<string, string>; timeout: number; follow?: boolean }): Promise<Res> {
  let url = new URL(path, base);
  const chain: string[] = [];
  for (let hop = 0; ; hop++) {
    if (url.origin !== base.origin) throw new Error(`redirect to other origin blocked: ${url.origin}`);
    const r = await f(url, { method: opt.method ?? 'GET', body: opt.body, headers: { 'user-agent': UA, ...(opt.headers ?? {}) }, redirect: 'manual', signal: AbortSignal.timeout(opt.timeout), credentials: 'omit' } as RequestInit);
    const loc = r.headers.get('location');
    if (opt.follow !== false && r.status >= 300 && r.status < 400 && loc) {
      if (hop >= 5) throw new Error('too many redirects');
      chain.push(`${r.status} ${url.pathname}`);
      const next = new URL(loc, url);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('redirect to non-http(s) blocked');
      url = next; await r.body?.cancel(); continue;
    }
    const body = opt.method === 'HEAD' ? '' : (await r.text()).slice(0, 2_000_000);
    return { status: r.status, headers: r.headers, body, url: url.toString(), chain };
  }
}

// ---------- 解析 / 断言辅助 ----------
export function metaRobots(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (/\bname\s*=\s*["']?(robots|googlebot)["']?/i.test(tag)) { const c = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag); if (c) out.push(c[1].toLowerCase()); }
  }
  return out;
}
export function isNoindex(r: Pick<Res, 'headers' | 'body'>) {
  const h = (r.headers.get('x-robots-tag') ?? '').toLowerCase();
  return /\bnoindex\b|\bnone\b/.test(h) || metaRobots(r.body).some((c) => /\bnoindex\b|\bnone\b/.test(c));
}
export const htmlLang = (html: string) => /<html\b[^>]*\blang\s*=\s*["']?([\w-]+)/i.exec(html)?.[1] ?? null;
export function hreflangs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const t = m[0];
    if (!/\brel\s*=\s*["']?alternate/i.test(t)) continue;
    const l = /\bhref[lL]ang\s*=\s*["']([^"']+)["']/.exec(t); const h = /\bhref\s*=\s*["']([^"']+)["']/i.exec(t);
    if (l && h) out[l[1].toLowerCase()] = h[1].replace(/&amp;/g, '&');
  }
  return out;
}
export function robotsRules(txt: string) {
  const disallow: string[] = []; const sitemaps: string[] = [];
  let star = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const [k, ...rest] = line.split(':'); const v = rest.join(':').trim(); const key = k.trim().toLowerCase();
    if (key === 'user-agent') star = v === '*';
    else if (key === 'disallow' && star) disallow.push(v);
    else if (key === 'sitemap') sitemaps.push(v);
  }
  return { disallow, sitemaps };
}
/** 极简 XML 校验：有 <urlset> 或 <sitemapindex> 根、标签配对；返回 <loc> 列表 */
export function sitemapLocs(xml: string): string[] {
  const body = xml.replace(/^\uFEFF/, '').replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!/^<(urlset|sitemapindex)\b/.test(body)) throw new Error('root is not <urlset>/<sitemapindex>');
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    if (self) continue;
    if (!close) stack.push(name); else if (stack.pop() !== name) throw new Error(`mismatched </${name}>`);
  }
  if (stack.length) throw new Error(`unclosed <${stack.at(-1)}>`);
  return [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
}
const ADMIN_LEAK = /PJ-\d{4}-[A-Z0-9]{4,}|询盘列表|adm-main|"inquiries"\s*:|replyToken|shippingAddress/;

// ---------- 检查 ----------
export async function runChecks(f: Fetch, base: URL, o: { privacyIndexed: boolean; timeout: number }): Promise<Result[]> {
  const results: Result[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }); }
  };
  const need = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };
  const g = (p: string, extra: Partial<Parameters<typeof get>[3]> = {}) => get(f, base, p, { timeout: o.timeout, ...extra });

  await check('homepage 200, indexable', async () => {
    const r = await g('/');
    need(r.status === 200, `status ${r.status}${r.chain.length ? ` after ${r.chain.join(' → ')}` : ''}`);
    need(!isNoindex(r), 'noindex found (meta robots or X-Robots-Tag)');
    return `200${r.chain.length ? ` via ${r.chain.join(' → ')}` : ''}`;
  });
  for (const loc of ['en', 'ru']) {
    await check(`/${loc} 200, lang + hreflang`, async () => {
      const r = await g(`/${loc}`);
      need(r.status === 200, `status ${r.status}`);
      need(htmlLang(r.body)?.toLowerCase().startsWith(loc), `html lang=${htmlLang(r.body)}`);
      const hl = hreflangs(r.body);
      for (const k of ['en', 'ru', 'x-default']) need(hl[k], `missing hreflang ${k}`);
      for (const [k, v] of Object.entries(hl)) need(new URL(v, base).origin === base.origin, `hreflang ${k} on other origin: ${v}`);
      need(!isNoindex(r), 'noindex found');
      return `lang=${htmlLang(r.body)}, hreflang ${Object.keys(hl).join('/')}`;
    });
  }
  await check('robots.txt', async () => {
    const r = await g('/robots.txt');
    need(r.status === 200, `status ${r.status}`);
    const { disallow, sitemaps } = robotsRules(r.body);
    need(!disallow.includes('/'), 'Disallow: / (whole site blocked — not production env?)');
    need(disallow.some((d) => d === '/admin' || d === '/admin/'), 'no Disallow /admin');
    need(disallow.some((d) => d === '/api/' || d === '/api'), 'no Disallow /api/');
    need(sitemaps.some((s) => /\/sitemap\.xml$/.test(s)), 'no Sitemap: line');
    return `disallow ${disallow.join(' ')}; sitemap ${sitemaps.join(' ')}`;
  });
  await check('sitemap.xml', async () => {
    const r = await g('/sitemap.xml');
    need(r.status === 200, `status ${r.status}`);
    const locs = sitemapLocs(r.body);
    need(locs.length > 0, 'no <loc> entries');
    const bad = locs.filter((l) => { try { const u = new URL(l); return u.origin !== base.origin; } catch { return true; } });
    need(!bad.length, `${bad.length} non-absolute or other-origin URLs, e.g. ${bad[0]}`);
    return `${locs.length} URLs, all on ${base.origin}`;
  });
  await check('/admin requires login, no admin content', async () => {
    const r = await g('/admin');
    const path = new URL(r.url).pathname;
    need(!ADMIN_LEAK.test(r.body), `admin content served without login (final ${r.status} ${path})`);
    const toLogin = /login|signin|sign-in/i.test(path);
    need(toLogin || r.status === 401 || r.status === 403, `not redirected to login: final ${r.status} ${path}${r.chain.length ? ` via ${r.chain.join(' → ')}` : ''}`);
    return `${r.chain.join(' → ') || 'no redirect'} → ${r.status} ${path}`;
  });
  for (const loc of ['en', 'ru']) {
    await check(`/${loc}/privacy ${o.privacyIndexed ? 'indexable' : 'noindex'}`, async () => {
      const r = await g(`/${loc}/privacy`);
      need(r.status !== 404, 'privacy page 404 — branch not deployed?');
      need(r.status === 200, `status ${r.status}`);
      const ni = isNoindex(r);
      if (o.privacyIndexed) need(!ni, 'still noindex (expected indexable: --privacy-indexed)');
      else need(ni, 'indexable, but privacy noindex constant should still be on (pass --privacy-indexed after it is turned off)');
      return ni ? 'noindex' : 'indexable';
    });
  }
  await check('Sanity webhook rejects unsigned POST', async () => {
    const r = await g(SANITY_WEBHOOK_PATH, { method: 'POST', follow: false, body: '{"_type":"smoke"}', headers: { 'content-type': 'application/json' } });
    need(r.status !== 503, 'SANITY_WEBHOOK_SECRET not set');
    need(r.status === 401, `expected 401, got ${r.status}`);
    return '401';
  });
  return results;
}

export function table(rs: Result[]) {
  const w = Math.max(...rs.map((r) => r.name.length));
  return rs.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail.replace(/[\r\n]+/g, ' ').slice(0, 200)}`).join('\n');
}

async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`smoke: ${(e as Error).message}`); process.exit(2); }
  console.log(`smoke: ${a.base.origin}${a.privacyIndexed ? ' (privacy indexed)' : ''}`);
  const rs = await runChecks(fetch, a.base, a);
  console.log(table(rs));
  const failed = rs.filter((r) => !r.ok).length;
  console.log(`\n${rs.length - failed}/${rs.length} passed`);
  process.exit(failed ? 1 : 0);
}
if (process.argv[1] && /smoke\.ts$/.test(process.argv[1])) void main();
