import { NextResponse } from 'next/server';
import { lookupDesign, canonicalFor } from '@/lib/server/designs';
import { categorySlugs } from '@/lib/seo/categorySlugs';
import { clientIp, hitRateLimit, tooManyRequests } from '@/lib/server/security';

export const runtime = 'nodejs';

const NO_INDEX = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store' };

/** 公开读取方案：200 / 过期 410（带分类落地页链接）/ 不存在 404。按 IP 限流，降低枚举价值。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ip = clientIp(req);
  if (ip && !(await hitRateLimit(`design-get:${ip}`, 300))) return tooManyRequests(600);
  const { id } = await params;
  const r = await lookupDesign(id);
  if (r.state === 'missing') return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_INDEX });
  if (r.state === 'expired') return NextResponse.json({ error: 'expired', categoryUrl: canonicalFor(r) }, { status: 410, headers: NO_INDEX });
  const d = r.design;
  return NextResponse.json({ ...d, slugs: d.category ? categorySlugs(d.category) : null, canonical: canonicalFor(d) }, { headers: NO_INDEX });
}

/**
 * 轻量状态检查，给 middleware 的 410 规则用：只返回 200 / 404 / 410（或限流 429），无 body，不暴露方案内容。
 * 短暂缓存 60 秒（状态只会从 200 变成 410/404）。
 */
export async function HEAD(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ip = clientIp(req);
  const ok = ip ? await hitRateLimit(`design-head:${ip}`, 600) : await hitRateLimit('design-head:noip', 6000);
  if (!ok) return new Response(null, { status: 429, headers: { 'Retry-After': '600', 'Cache-Control': 'no-store' } });
  const { id } = await params;
  const r = await lookupDesign(id);
  const status = r.state === 'ok' ? 200 : r.state === 'expired' ? 410 : 404;
  return new Response(null, { status, headers: { 'Cache-Control': 'public, max-age=60', 'X-Robots-Tag': 'noindex, nofollow' } });
}
