import { NextResponse } from 'next/server';
import { lookupDesign, canonicalFor, designStatus, isDbUnavailable, errorSummary } from '@/lib/server/designs';
import { categorySlugs } from '@/lib/seo/categorySlugs';
import { clientIp, hitRateLimit, tooManyRequests } from '@/lib/server/security';
import { probeClientIp } from '@/lib/server/probe';

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
 * 显式 HEAD（不依赖 Next 的 GET 回退）。轻量状态检查，给 middleware 的 410 规则用：只返回 200 / 404 / 410（或限流 429），无 body，不暴露方案内容。
 * 短暂缓存 60 秒（状态只会从 200 变成 410/404）。
 */
export async function HEAD(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // middleware 探测带密钥时按它转发的客户端 IP 单独计数，避免所有探测共用一个桶；否则按连接 IP
  const probeIp = probeClientIp(req);
  const ip = clientIp(req);
  const ok = probeIp ? await hitRateLimit(`design-head:probe:${probeIp}`, 600)
    : ip ? await hitRateLimit(`design-head:${ip}`, 600) : await hitRateLimit('design-head:noip', 6000);
  if (!ok) return new Response(null, { status: 429, headers: { 'Retry-After': '600', 'Cache-Control': 'no-store' } });
  const { id } = await params;
  let st: Awaited<ReturnType<typeof designStatus>>;
  try {
    st = await designStatus(id); // 只查 expiresAt + category
  } catch (err) {
    if (!isDbUnavailable(err)) throw err;
    console.error('[HEAD /api/designs/:id] db unavailable', errorSummary(err));
    return new Response(null, { status: 503, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
  }
  const { status, category } = st;
  const headers: Record<string, string> = { 'Cache-Control': 'public, max-age=60', 'X-Robots-Tag': 'noindex, nofollow' };
  if (status === 410 && category) headers['X-Design-Category'] = category; // 仅 categoryMeta key，供 middleware 拼分类页链接
  return new Response(null, { status, headers });
}
