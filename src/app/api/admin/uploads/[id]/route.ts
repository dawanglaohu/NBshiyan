import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { storage } from '@/lib/server/storage';
import { isAdminPlaceholder, LOGO_ID_RE } from '@/lib/server/uploads';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'private, no-store' };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // TODO(auth): 接入 Auth.js 后台会话 + 角色校验，并写 AuditLog
  if (!(await isAdminPlaceholder(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  const { id } = await params;
  if (!LOGO_ID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  const u = await prisma.logoUpload.findUnique({ where: { id } });
  const data = u && (await storage.get(u.path));
  if (!u || !data) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  return new Response(new Uint8Array(data), {
    headers: {
      ...noStore,
      'Content-Type': u.mime,
      'Content-Length': String(data.length),
      'Content-Disposition': `inline; filename="logo-${u.id}.png"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
