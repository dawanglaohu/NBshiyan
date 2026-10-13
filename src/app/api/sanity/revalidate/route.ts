import { NextResponse, after } from 'next/server';
import { revalidateTag } from 'next/cache';
import { secretMatches } from '@/lib/server/uploads';
import { readBody } from '@/lib/server/security';
import { DOC_TYPES } from '@/lib/server/sanity';
import { pathsForSanityDoc, submitIndexNow, type SanityWebhookDoc } from '@/lib/seo/indexnow';

export const runtime = 'nodejs';

/** Sanity webhook：内容发布后按类型刷新 ISR 缓存。需 Authorization: Bearer $SANITY_REVALIDATE_SECRET。 */
export async function POST(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.SANITY_REVALIDATE_SECRET)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const raw = await readBody(req, 8_000);
  let doc: SanityWebhookDoc = {};
  try { doc = raw ? (JSON.parse(raw) as SanityWebhookDoc) ?? {} : {}; } catch {}
  const type = doc._type;
  const tag = typeof type === 'string' && (DOC_TYPES as readonly string[]).includes(type) ? `sanity:${type}` : 'sanity';
  revalidateTag(tag);
  // 密钥校验通过后才推 IndexNow；放在 after() 里，响应先返回，失败不影响 webhook
  const paths = pathsForSanityDoc(doc);
  if (paths.length) after(() => submitIndexNow(paths));
  return NextResponse.json({ revalidated: tag });
}
