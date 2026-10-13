import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9]{10}$/.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const d = await prisma.sharedDesign.findUnique({ where: { id }, select: { id: true, productSlug: true, config: true } });
  if (!d) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(d, { headers: { 'X-Robots-Tag': 'noindex' } });
}
