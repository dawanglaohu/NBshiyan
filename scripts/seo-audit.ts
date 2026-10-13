/**
 * scripts/seo-audit.ts — local SEO audit for the PackJoyU site (no network beyond the target base URL).
 *
 * Usage:
 *   pnpm build && pnpm start            # in another terminal
 *   pnpm seo:audit [baseUrl] [--max=N] [--out=reports]
 *   SEO_AUDIT_BASE=http://localhost:3000 SEO_AUDIT_MAX=300 pnpm seo:audit
 *
 * Crawl: seeds = /sitemap.xml <loc>s (rewritten onto baseUrl) + /en + /ru (+ /). Follows same-site
 * <a href> links, capped at --max pages (default 300). /admin, /api, /s/ are fetched but not followed.
 *
 * Per-page checks (severity):
 *   title length 30–60 (warn; missing = error) · meta description 70–160 (warn; missing = error on indexable)
 *   exactly one <h1> (error) · canonical present, absolute, same-site, self-referencing (error / warn)
 *   hreflang en<->ru reciprocal, x-default consistent (error) · noindex on sitemap URL (error),
 *   indexable /admin or /s/ page (error) · internal link -> 404 (error) · literal "{{" in HTML (error)
 *
 * Output: reports/seo-audit.md + reports/seo-audit.json. Exit 1 if any error, else 0.
 * Canonical/hreflang/sitemap hosts are production SITE_URL; they are compared by path, and the
 * host is checked against SEO_AUDIT_SITE_ORIGIN (default: NEXT_PUBLIC_SITE_URL or the base URL).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type Severity = 'error' | 'warn';
export interface Finding { url: string; check: string; severity: Severity; message: string }
export interface PageInfo {
  title?: string; description?: string; h1Count: number; canonical?: string; robots?: string;
  hreflang: Record<string, string>; links: string[]; hasPlaceholder: boolean;
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const attr = (tag: string, name: string) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')); return m ? decode(m[2] ?? m[3] ?? '') : undefined; };

export function parsePage(html: string): PageInfo {
  const head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? html;
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const info: PageInfo = { title: title === undefined ? undefined : decode(title.replace(/<[^>]+>/g, '')), h1Count: (html.match(/<h1[\s>]/gi) ?? []).length, hreflang: {}, links: [], hasPlaceholder: false };
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const n = attr(tag, 'name')?.toLowerCase();
    if (n === 'description') info.description = attr(tag, 'content');
    if (n === 'robots') info.robots = attr(tag, 'content')?.toLowerCase();
  }
  for (const tag of html.match(/<link\s[^>]*>/gi) ?? []) {
    const rel = attr(tag, 'rel')?.toLowerCase(), href = attr(tag, 'href');
    if (!href) continue;
    if (rel === 'canonical') info.canonical = href;
    if (rel === 'alternate') { const hl = attr(tag, 'hreflang'); if (hl) info.hreflang[hl.toLowerCase()] = href; }
  }
  for (const tag of html.match(/<a\s[^>]*>/gi) ?? []) { const h = attr(tag, 'href'); if (h) info.links.push(h); }
  // Strip scripts (RSC payload / JSON) before looking for template placeholders in rendered markup + attributes.
  info.hasPlaceholder = html.replace(/<script[\s\S]*?<\/script>/gi, '').includes('{{');
  return info;
}

export const normPath = (u: string) => { const p = new URL(u).pathname.replace(/\/+$/, ''); return p === '' ? '/' : p; };
export const isPrivatePath = (p: string) => /^\/(admin|api)(\/|$)/.test(p) || /^\/[a-z]{2}\/s(\/|$)/.test(p) || /^\/s(\/|$)/.test(p);

export function checkLengths(url: string, p: PageInfo, indexable: boolean): Finding[] {
  const f: Finding[] = [];
  if (!p.title) f.push({ url, check: 'title', severity: 'error', message: 'missing <title>' });
  else if (p.title.length < 30 || p.title.length > 60) f.push({ url, check: 'title', severity: 'warn', message: `title length ${p.title.length} (want 30–60): "${p.title}"` });
  if (!p.description) { if (indexable) f.push({ url, check: 'description', severity: 'error', message: 'missing meta description' }); }
  else if (p.description.length < 70 || p.description.length > 160) f.push({ url, check: 'description', severity: 'warn', message: `description length ${p.description.length} (want 70–160)` });
  return f;
}

export function checkH1(url: string, p: PageInfo): Finding[] {
  return p.h1Count === 1 ? [] : [{ url, check: 'h1', severity: 'error', message: `${p.h1Count} <h1> elements (want exactly 1)` }];
}

export function checkCanonical(url: string, p: PageInfo, siteOrigin: string, indexable: boolean): Finding[] {
  if (!p.canonical) return indexable ? [{ url, check: 'canonical', severity: 'error', message: 'missing canonical' }] : [];
  if (!/^https?:\/\//i.test(p.canonical)) return [{ url, check: 'canonical', severity: 'error', message: `canonical not absolute: ${p.canonical}` }];
  const c = new URL(p.canonical);
  if (c.origin !== new URL(siteOrigin).origin) return [{ url, check: 'canonical', severity: 'error', message: `canonical off-site: ${p.canonical} (site ${siteOrigin})` }];
  if (normPath(p.canonical) !== normPath(url)) return [{ url, check: 'canonical', severity: 'warn', message: `canonical points elsewhere: ${normPath(p.canonical)}` }];
  return [];
}

/** pages: path -> PageInfo for crawled pages. Checks en<->ru reciprocity and x-default consistency. */
export function checkHreflang(pages: Map<string, PageInfo>): Finding[] {
  const f: Finding[] = [];
  for (const [path, p] of pages) {
    const hl = p.hreflang; const langs = Object.keys(hl).filter((k) => k !== 'x-default');
    if (!langs.length) continue;
    for (const need of ['en', 'ru']) if (!hl[need]) f.push({ url: path, check: 'hreflang', severity: 'error', message: `missing hreflang="${need}"` });
    if (!langs.some((l) => hl[l] && normPath(hl[l]) === path)) f.push({ url: path, check: 'hreflang', severity: 'error', message: 'no self-referencing hreflang' });
    for (const l of langs) {
      const target = normPath(hl[l]); if (target === path) continue;
      const tp = pages.get(target); if (!tp) continue;
      const back = Object.values(tp.hreflang).some((h) => normPath(h) === path);
      if (!back) f.push({ url: path, check: 'hreflang', severity: 'error', message: `hreflang ${l} -> ${target} not reciprocated` });
      const a = hl['x-default'], b = tp.hreflang['x-default'];
      if (a && b && normPath(a) !== normPath(b)) f.push({ url: path, check: 'hreflang', severity: 'error', message: `x-default differs from ${target} (${normPath(a)} vs ${normPath(b)})` });
    }
  }
  return f;
}

export function checkNoindex(url: string, p: PageInfo, inSitemap: boolean, headerRobots = ''): Finding[] {
  const noindex = /noindex/.test(`${p.robots ?? ''} ${headerRobots.toLowerCase()}`); const path = normPath(url);
  if (noindex && inSitemap) return [{ url, check: 'noindex', severity: 'error', message: 'noindex page is listed in sitemap.xml' }];
  if (!noindex && isPrivatePath(path)) return [{ url, check: 'noindex', severity: 'error', message: 'private page (/admin, /s/) is indexable' }];
  return [];
}

export function checkPlaceholder(url: string, p: PageInfo): Finding[] {
  return p.hasPlaceholder ? [{ url, check: 'placeholder', severity: 'error', message: 'literal "{{" placeholder in HTML' }] : [];
}

export function parseSitemap(xml: string): string[] { return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => decode(m[1])); }

async function main() {
  const args = process.argv.slice(2); const opt = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
  const base = (args.find((a) => !a.startsWith('--')) ?? process.env.SEO_AUDIT_BASE ?? 'http://localhost:3000').replace(/\/$/, '');
  const max = Number(opt('max') ?? process.env.SEO_AUDIT_MAX ?? 300); const outDir = opt('out') ?? 'reports';
  const siteOrigin = process.env.SEO_AUDIT_SITE_ORIGIN ?? process.env.NEXT_PUBLIC_SITE_URL ?? base;
  const findings: Finding[] = []; const pages = new Map<string, PageInfo>(); const status = new Map<string, number>();
  const linkedFrom = new Map<string, Set<string>>();
  let sitemap: string[] = [];
  try { const r = await fetch(`${base}/sitemap.xml`); if (r.ok) sitemap = parseSitemap(await r.text()).map(normPath); else findings.push({ url: '/sitemap.xml', check: 'sitemap', severity: 'error', message: `HTTP ${r.status}` }); }
  catch (e) { console.error(`cannot reach ${base}: ${(e as Error).message}`); process.exit(2); }
  const sitemapSet = new Set(sitemap);
  const queue = [...new Set(['/', '/en', '/ru', ...sitemap])]; const seen = new Set(queue);
  while (queue.length && status.size < max) {
    const path = queue.shift()!;
    let r: Response; try { r = await fetch(base + path, { redirect: 'follow' }); } catch (e) { findings.push({ url: path, check: 'fetch', severity: 'error', message: (e as Error).message }); continue; }
    status.set(path, r.status);
    const finalPath = normPath(r.url);
    if (r.status === 404) { findings.push({ url: path, check: 'links', severity: 'error', message: `404 (linked from: ${[...(linkedFrom.get(path) ?? ['seed'])].slice(0, 5).join(', ')})` }); continue; }
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('text/html')) continue;
    if (finalPath !== path && pages.has(finalPath)) continue;
    const p = parsePage(await r.text()); const url = base + finalPath; pages.set(finalPath, p);
    const robotsHdr = r.headers.get('x-robots-tag') ?? '';
    const indexable = !/noindex/.test(`${p.robots ?? ''} ${robotsHdr}`);
    findings.push(...checkLengths(finalPath, p, indexable), ...checkH1(finalPath, p), ...checkCanonical(url, p, siteOrigin, indexable).map((x) => ({ ...x, url: finalPath })),
      ...checkNoindex(url, p, sitemapSet.has(finalPath), robotsHdr).map((x) => ({ ...x, url: finalPath })), ...checkPlaceholder(finalPath, p));
    if (isPrivatePath(finalPath)) continue;
    for (const h of p.links) {
      let u: URL; try { u = new URL(h, url); } catch { continue; }
      if (u.origin !== new URL(base).origin && u.origin !== new URL(siteOrigin).origin) continue;
      if (!/^https?:$/.test(u.protocol)) continue;
      const lp = normPath(u.href); if (/\.(png|jpe?g|webp|svg|pdf|glb|xml|txt|ico)$/i.test(lp)) continue;
      (linkedFrom.get(lp) ?? linkedFrom.set(lp, new Set()).get(lp)!).add(finalPath);
      if (!seen.has(lp)) { seen.add(lp); queue.push(lp); }
    }
  }
  findings.push(...checkHreflang(pages));
  const errors = findings.filter((f) => f.severity === 'error').length, warns = findings.length - errors;
  const summary = { base, siteOrigin, generatedAt: new Date().toISOString(), crawled: status.size, htmlPages: pages.size, sitemapUrls: sitemap.length, capped: queue.length > 0, errors, warnings: warns };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/seo-audit.json`, JSON.stringify({ summary, findings, status: Object.fromEntries(status) }, null, 2));
  const byCheck = findings.reduce<Record<string, Finding[]>>((a, f) => ((a[f.check] ??= []).push(f), a), {});
  const md = [`# SEO audit — ${base}`, '', `Generated ${summary.generatedAt}. Crawled ${summary.crawled} URLs (${summary.htmlPages} HTML pages, ${summary.sitemapUrls} in sitemap${summary.capped ? ', **capped**' : ''}).`, '', `**${errors} errors, ${warns} warnings**`, '',
    '| check | errors | warnings |', '|---|---|---|', ...Object.entries(byCheck).map(([k, v]) => `| ${k} | ${v.filter((f) => f.severity === 'error').length} | ${v.filter((f) => f.severity === 'warn').length} |`), '',
    ...Object.entries(byCheck).flatMap(([k, v]) => [`## ${k}`, '', ...v.map((f) => `- **${f.severity}** \`${f.url}\` — ${f.message.replace(/\|/g, '\\|')}`), ''])].join('\n');
  writeFileSync(`${outDir}/seo-audit.md`, md);
  console.log(`seo-audit: ${summary.crawled} URLs, ${errors} errors, ${warns} warnings → ${outDir}/seo-audit.{md,json}`);
  process.exit(errors ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
