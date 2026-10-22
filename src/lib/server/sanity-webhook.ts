import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DOC_TYPES } from '@/lib/server/sanity';

/** 与 @sanity/webhook 相同的签名格式：`sanity-webhook-signature: t=<毫秒时间戳>,v1=<base64url(HMAC-SHA256(secret, "<t>.<原始请求体>"))>` */
export const SIGNATURE_HEADER_NAME = 'sanity-webhook-signature';
export const MAX_SKEW_MS = 5 * 60_000;
export const MAX_BODY = 8_000;

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function signPayload(body: string, secret: string, t: number): string {
  return `t=${t},v1=${b64url(createHmac('sha256', secret).update(`${t}.${body}`).digest())}`;
}

export type SigResult = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

export function verifySignature(body: string, header: string | null, secret: string, now = Date.now()): SigResult {
  if (!header) return { ok: false, reason: 'missing' };
  const m = /^t=(\d{10,16}),v1=([A-Za-z0-9_-]{20,100})$/.exec(header.trim());
  if (!m) return { ok: false, reason: 'malformed' };
  const t = Number(m[1]);
  if (!Number.isSafeInteger(t) || Math.abs(now - t) > MAX_SKEW_MS) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(signPayload(body, secret, t).split(',v1=')[1]);
  const got = Buffer.from(m[2]);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}

/** webhook 的 projection 只需 { _type }；_id、slug 可带可不带 */
export const WebhookPayload = z.object({
  _type: z.enum(DOC_TYPES),
  _id: z.string().max(200).optional(),
  slug: z.unknown().optional(),
}).passthrough();

export type HandleDeps = { env: Record<string, string | undefined>; revalidateTag: (t: string) => void; log?: (o: { errorSummary: string }) => void; now?: number };
export type HandleResult = { status: number; body: Record<string, unknown>; document?: z.infer<typeof WebhookPayload> };

/** 纯处理逻辑（便于测试）：先验签原始请求体，再 JSON.parse + zod，最后只刷新白名单内的 tag */
export function handleSanityWebhook(raw: string | null, sigHeader: string | null, d: HandleDeps): HandleResult {
  const log = d.log ?? ((o) => console.warn('[sanity-webhook]', o));
  const secret = d.env.SANITY_WEBHOOK_SECRET;
  if (!secret) {
    if (d.env.NODE_ENV === 'production') { log({ errorSummary: 'missing SANITY_WEBHOOK_SECRET' }); return { status: 503, body: { error: 'not_configured' } }; }
    return { status: 401, body: { error: 'unauthorized' } }; // 非生产也不放行未签名请求
  }
  if (raw === null) return { status: 413, body: { error: 'too_large' } };
  const v = verifySignature(raw, sigHeader, secret, d.now);
  if (!v.ok) { log({ errorSummary: `signature ${v.reason}` }); return { status: 401, body: { error: 'unauthorized' } }; }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { log({ errorSummary: 'invalid json' }); return { status: 400, body: { error: 'invalid_payload' } }; }
  const p = WebhookPayload.safeParse(json);
  if (!p.success) { log({ errorSummary: 'payload rejected' }); return { status: 400, body: { error: 'invalid_payload' } }; }
  const tag = `sanity:${p.data._type}`;
  d.revalidateTag(tag);
  return { status: 200, body: { revalidated: tag }, document: p.data };
}
