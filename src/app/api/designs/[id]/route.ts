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
