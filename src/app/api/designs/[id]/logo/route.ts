import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { storage } from '@/lib/server/storage';
import { DESIGN_ID_RE } from '@/lib/server/designs';
import { clientIp, hitRateLimit, rateLimitSubject, tooManyRequests } from '@/lib/server/security';
import { storedFileResponse } from '@/lib/server/file-response';

export const runtime = 'nodejs';
const H = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };

/** 公开：方案里的 logo（服务端已用 sharp 重新编码为 PNG），持有短链接的人可见。不暴露上传 id。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ip = clientIp(req);
  const ok = await hitRateLimit(`design-logo:${rateLimitSubject(ip)}`, 300);
  if (!ok) return tooManyRequests(600);
  const { id } = await params;
  if (!DESIGN_ID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: H });
  const now = new Date();
  const d = await prisma.sharedDesign.findFirst({
    where: { id, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, // 过期不再提供 logo
    select: { logoUpload: { select: { path: true } } },
  });
  const data = d?.logoUpload && (await storage.get(d.logoUpload.path));
  if (!d?.logoUpload || !data) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: H });
  // 客户 logo 属于私有文件（持短链接的人可见）：private, no-store；文件名只用方案 id，不暴露上传 id
  return storedFileResponse(data, d.logoUpload.path, `design-${id}-logo`, { access: 'private' }, { 'X-Robots-Tag': H['X-Robots-Tag'] });
}
