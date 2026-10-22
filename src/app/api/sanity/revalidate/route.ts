import { NextResponse, after } from 'next/server';
import { revalidateTag } from 'next/cache';
import { readBody } from '@/lib/server/security';
import { handleSanityWebhook, MAX_BODY, SIGNATURE_HEADER_NAME } from '@/lib/server/sanity-webhook';
import { pathsForSanityDoc, submitIndexNow, type SanityWebhookDoc } from '@/lib/seo/indexnow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Sanity webhook：用 SANITY_WEBHOOK_SECRET 校验原始请求体签名，通过后刷新白名单类型的 ISR 缓存。 */
export async function POST(req: Request) {
  const signature = req.headers.get(SIGNATURE_HEADER_NAME);
  const raw = process.env.SANITY_WEBHOOK_SECRET && signature ? await readBody(req, MAX_BODY) : '';
  const r = handleSanityWebhook(raw, signature, { env: process.env, revalidateTag });
  if (r.status === 200 && r.document) {
    const paths = pathsForSanityDoc(r.document as SanityWebhookDoc);
    if (paths.length) after(() => submitIndexNow(paths));
  }
  return NextResponse.json(r.body, { status: r.status, headers: { 'Cache-Control': 'no-store' } });
}
