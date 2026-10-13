import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { secretMatches } from '@/lib/server/uploads';
import { readBody } from '@/lib/server/security';
import { DOC_TYPES } from '@/lib/server/sanity';

export const runtime = 'nodejs';

/** Sanity webhook：内容发布后按类型刷新 ISR 缓存。需 Authorization: Bearer $SANITY_REVALIDATE_SECRET。 */
export async function POST(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.SANITY_REVALIDATE_SECRET)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const raw = await readBody(req, 8_000);
  let type: unknown;
  try { type = raw ? (JSON.parse(raw) as { _type?: unknown })._type : undefined; } catch {}
  const tag = typeof type === 'string' && (DOC_TYPES as readonly string[]).includes(type) ? `sanity:${type}` : 'sanity';
  revalidateTag(tag);
  return NextResponse.json({ revalidated: tag });
}
