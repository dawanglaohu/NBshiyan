import { NextResponse } from 'next/server';
import { listPublishedModels } from '@/lib/server/published-models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 公开：只列出已上架且检查通过的模型 */
export async function GET() {
  const items = await listPublishedModels();
  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60' } });
}
