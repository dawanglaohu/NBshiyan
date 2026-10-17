import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { clientIp, hitRateLimit } from '@/lib/server/security';
import { audit } from '@/lib/server/admin/audit';
import { mailSwitchGate } from '@/lib/server/mail/http';
import { webhookSecret } from '@/lib/server/mail/config';
import { createHash } from 'node:crypto';
import { ingestRaw, webhookHeaderProblem, verifyWebhookSignature, WEBHOOK_MAX_BODY, WEBHOOK_RATE, WEBHOOK_REPLAY_WINDOW_MS, type WebhookAuthReason } from '@/lib/server/mail/inbound';
import { mailLog } from '@/lib/server/mail/adapter';

export const runtime = 'nodejs';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };
/** 所有鉴权失败同一个响应（同一状态码、同一体、同一头），原因只进日志（原因码，无请求内容） */
const UNAUTHORIZED_BODY = { error: 'unauthorized' } as const;
function unauthorized(reason: WebhookAuthReason) {
  mailLog('warn', 'mail.webhook_unauthorized', { reason });
  return NextResponse.json(UNAUTHORIZED_BODY, { status: 401, headers: NO_STORE });
}

/** 流式读取，累计超过上限立即取消读取并返回 null（Content-Length 已预检，这里防止头和实际长度不符） */
async function readRaw(req: Request, max: number): Promise<Buffer | null> {
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * 收信 webhook（backend-plan v4 §4.0 方案 A）：收信 Worker 推送 { id, raw }。
 * 鉴权：X-Geiom-Timestamp / X-Geiom-Mail-Id / X-Geiom-Signature（HMAC-SHA256，密钥 MAIL_WEBHOOK_SECRET），±5 分钟；任何签名问题一律 401。
 * 防重放：时间窗 + 签名绑定邮件 id + Worker 邮件 id 唯一约束（重复推送回 200 duplicate）。持久化成功后才回 200；数据库不可用 → 503（Worker 重试）。
 * 顺序：开关/密钥（404）→ 限流（429）→ 鉴权头预检（401，不读体）→ Content-Length（411/413，不读体）→ 流式读体（413）→ HMAC（401）→ 防重放（签名 / Message-ID，200 duplicate）。
 * 所有 401 完全相同（{ error: 'unauthorized' }），日志只记原因码。
 * 邮件开关不是 http，或没配 MAIL_WEBHOOK_SECRET → 404。永不记录请求体；日志只有 mailId 类的短码和状态。
 */
export async function POST(req: Request) {
  const off = mailSwitchGate();
  if (off) return off;
  const secret = webhookSecret();
  if (!secret) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  const ip = clientIp(req);
  const sourceOk = ip
    ? await hitRateLimit(`mail:rl:webhook:ip:${ip}`, WEBHOOK_RATE.perSource, WEBHOOK_RATE.windowMs)
    : await hitRateLimit('mail:rl:webhook:untrusted', WEBHOOK_RATE.untrusted, WEBHOOK_RATE.windowMs);
  if (!sourceOk || !(await hitRateLimit('mail:rl:webhook', WEBHOOK_RATE.global, WEBHOOK_RATE.windowMs))) {
    return NextResponse.json({ error: 'rate_limited', retryAfter: 60 }, { status: 429, headers: { ...NO_STORE, 'Retry-After': '60' } });
  }
  // 1) 先只看头：鉴权头缺失 / 格式错 / 时间超窗 → 立即 401，请求体一个字节都不读
  const h = { timestamp: req.headers.get('x-geiom-timestamp'), mailId: req.headers.get('x-geiom-mail-id'), signature: req.headers.get('x-geiom-signature') };
  const headerProblem = webhookHeaderProblem(h);
  if (headerProblem) return unauthorized(headerProblem);
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return unauthorized('bad_content_type');
  // 2) 体积预检：必须有 Content-Length（411），超过上限 36,700,160 字节 → 413；仍然不读请求体
  const lenHeader = req.headers.get('content-length');
  if (lenHeader === null || !/^\d{1,15}$/.test(lenHeader.trim())) return NextResponse.json({ error: 'length_required' }, { status: 411, headers: NO_STORE });
  if (Number(lenHeader) > WEBHOOK_MAX_BODY) return NextResponse.json({ error: 'too_large' }, { status: 413, headers: NO_STORE });
  // 3) 流式读取（同一上限），再验 HMAC（签名覆盖请求体，只能读完再验）
  const raw = await readRaw(req, WEBHOOK_MAX_BODY);
  if (raw === null) return NextResponse.json({ error: 'too_large' }, { status: 413, headers: NO_STORE });
  if (!verifyWebhookSignature(h, raw, secret)) return unauthorized('bad_signature');
  let body: { id?: unknown; raw?: unknown };
  try { body = JSON.parse(raw.toString('utf8')); } catch { return unauthorized('bad_body'); }
  if (!body || typeof body !== 'object' || typeof body.raw !== 'string') return unauthorized('bad_body');
  if (body.id !== h.mailId) return unauthorized('id_mismatch');
  // 4) 防重放（签名通过后）：同一签名在时间窗（±5 分钟，按 10 分钟记）内第二次出现 → 若已入库则 200 duplicate、不处理。
  //    已出现但还没入库（上次 503 或正在处理）→ 继续走一遍，由 Worker 邮件 id / Message-ID 唯一约束保证不重复入库——不会因重放标记丢信。
  //    同一 Message-ID 已入库 → ingestRaw 返回 duplicate，同样 200 不处理。
  const sigKey = `mail:wh:sig:${createHash('sha256').update(h.signature!.toLowerCase()).digest('hex')}`;
  const firstSeen = await hitRateLimit(sigKey, 1, WEBHOOK_REPLAY_WINDOW_MS).catch(() => true);
  if (!firstSeen) {
    try {
      const prev = await prisma.mailMessage.findUnique({ where: { remoteMailId: h.mailId! }, select: { id: true } });
      if (prev) {
        mailLog('info', 'mail.webhook_replay', { reason: 'signature_seen' });
        return NextResponse.json({ ok: true, duplicate: true }, { headers: NO_STORE });
      }
    } catch (e) {
      mailLog('error', 'mail.inbound_store_failed', { kind: (e as { name?: string })?.name ?? 'Error' });
      return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
    }
  }
  // 防重放：签名带时间戳（±5 分钟）且绑定 Worker 邮件 id；同一 id 再次推送由唯一约束识别为 duplicate，绝不重复入库或覆盖。
  // 不另设“签名 nonce 先占位”：那样入库失败（503）后 Worker 用同一签名重推会被当成重复而丢信。
  try {
    const r = await ingestRaw(prisma, h.mailId!, Buffer.from(body.raw, 'utf8'), { replyDomain: process.env.REPLY_DOMAIN, audit });
    mailLog('info', 'mail.inbound', { status: r.result, mailId: r.id ?? 'none' });
    return NextResponse.json({ ok: true, ...(r.result === 'duplicate' ? { duplicate: true } : {}) }, { headers: NO_STORE });
  } catch (e) {
    mailLog('error', 'mail.inbound_store_failed', { kind: (e as { name?: string })?.name ?? 'Error' });
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
  }
}
