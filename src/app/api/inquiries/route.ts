import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { randomId, hitRateLimit, rateLimitKeyHash, verifyTurnstile, clientIp, rateLimitSubject, readBody, tooManyRequests } from '@/lib/server/security';
import { trustedCountry } from '@/lib/edge/client-ip';
import { retention } from '@/lib/server/retention';
import { scoreInquiry, REVIEW_THRESHOLD } from '@/lib/server/trust';
import { sendSafely, inquiryNotifyMail, customerAckMail } from '@/lib/server/mail';
import { summarizeItems } from '@/lib/server/email/render';
import { LOGO_ID_RE } from '@/lib/server/uploads';
import { DESIGN_ID_RE, liveDesignIds, designIdFromShareUrl, InquiryItemConfig } from '@/lib/server/designs';
import { PublishedLocaleSchema } from '@/lib/server/published-locales';
import { normalizeEmail, ShippingAddress, SAMPLE_MAX_ITEMS, SAMPLE_EMAIL_WINDOW_DAYS, SAMPLE_IP_LIMIT, sampleRecentResponse } from '@/lib/server/sample';

class LogoInvalid extends Error {}
class SampleLimited extends Error {}

const CART_MAX_ITEMS = 20;

const Body = z.object({
  source: z.enum(['FORM', 'WIZARD', 'CART', 'CUSTOMIZER', 'SAMPLE']),
  locale: PublishedLocaleSchema, // 只收已发布语言；DB 枚举里预留的语言（es/de/fr/ja/hi/ar）在这里 400
  contact: z.object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(200),
    company: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(40).optional(),
    region: z.string().trim().length(2).toUpperCase(),
  }),
  message: z.string().max(5000).optional(),
  items: z.array(z.object({
    productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/),
    quantity: z.number().int().positive().max(100_000_000).optional(),
    config: InquiryItemConfig.optional(), // 严格白名单，未知字段 400
    notes: z.string().trim().max(500).optional(),
    designId: z.string().regex(DESIGN_ID_RE).optional(),
    shareUrl: z.string().max(300).optional(), // 本站 /s/<id>，服务端解析成 designId
  }).strict().transform((i, ctx) => {
    const { shareUrl, ...rest } = i;
    if (shareUrl === undefined) return rest;
    const id = designIdFromShareUrl(shareUrl);
    if (!id || (rest.designId && rest.designId !== id)) { ctx.addIssue({ code: 'custom', message: 'share_url_invalid' }); return z.NEVER; }
    return { ...rest, designId: id };
  })).max(CART_MAX_ITEMS).default([]),
  shippingAddress: ShippingAddress.optional(), // 仅样品申请，PII
  attribution: z.record(z.unknown()).optional(),
  website: z.string().max(500).optional(), // 诱饵字段，有值则静默丢弃
  turnstileToken: z.string().optional(),
  logoUploadId: z.string().regex(LOGO_ID_RE).optional(), // 来自 POST /api/uploads/logo
}).superRefine((b, ctx) => {
  // 询价清单（CART）和样品申请（SAMPLE）必须带产品；样品最多 5 个
  if ((b.source === 'CART' || b.source === 'SAMPLE') && b.items.length === 0) ctx.addIssue({ code: 'custom', path: ['items'], message: 'items_required' });
  if (b.source === 'SAMPLE' && b.items.length > SAMPLE_MAX_ITEMS) ctx.addIssue({ code: 'custom', path: ['items'], message: 'too_many_samples' });
  if (b.source === 'SAMPLE' && !b.shippingAddress) ctx.addIssue({ code: 'custom', path: ['shippingAddress'], message: 'required' });
  if (b.source !== 'SAMPLE' && b.shippingAddress) ctx.addIssue({ code: 'custom', path: ['shippingAddress'], message: 'sample_only' });
  const slugs = b.items.map((i) => i.productSlug + '|' + (i.designId ?? ''));
  if (new Set(slugs).size !== slugs.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'duplicate_items' });
});


export async function POST(req: Request) {
  const ip = clientIp(req);

  const raw = await readBody(req, 32_000);
  if (raw === null) return NextResponse.json({ error: 'too_large' }, { status: 413 });
  let json: unknown = null;
  try { json = JSON.parse(raw); } catch {}
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    // 无效请求单独计数，不占用正常提交的额度；不可信来源全部共用一个 untrusted 桶
    if (!(await hitRateLimit(`inq-bad:${rateLimitSubject(ip)}`, 30))) return tooManyRequests(600);
    return NextResponse.json({ error: 'invalid', issues: parsed.error.flatten() }, { status: 400 });
  }
  const b = parsed.data;
  // 正常提交的限流：IP 桶和邮箱桶同时计数，任意一个超限就 429（两个都要先计数，不能短路）。
  // 拿不到 IP（如本地 pnpm start）时用所有无 IP 请求共用的宽松总闸代替 IP 桶。
  const email = b.contact.email.trim().toLowerCase();
  // 邮箱桶用规范化邮箱（去 +后缀、Gmail 去点），别名不能绕过
  const [ipOk, emailOk] = await Promise.all([hitRateLimit(`inq:${rateLimitSubject(ip)}`), hitRateLimit(`inq:email:${rateLimitKeyHash(normalizeEmail(email))}`)]);
  const limited = !ipOk || !emailOk;
  if (limited) return tooManyRequests(600);
  const sampleEmail = b.source === 'SAMPLE' ? normalizeEmail(email) : null;
  if (b.website) return NextResponse.json({ ref: 'PJ-OK' }, { status: 201 }); // 机器人，静默丢弃
  const captcha = await verifyTurnstile(b.turnstileToken, ip);
  if (captcha === 'unavailable') {
    console.error('[turnstile] verify unavailable');
    return NextResponse.json({ error: 'captcha_unavailable' }, { status: 503, headers: { 'Retry-After': '30' } });
  }
  if (captcha === 'fail') return NextResponse.json({ error: 'captcha' }, { status: 403 });
  // 样品：每 IP 30 天 3 次，Turnstile 通过后才计数；按规范化邮箱 30 天 1 次在事务里判断
  if (sampleEmail && !(await hitRateLimit(`inq:sample:ip:${rateLimitSubject(ip)}`, SAMPLE_IP_LIMIT, SAMPLE_EMAIL_WINDOW_DAYS * 86_400_000))) return tooManyRequests(SAMPLE_EMAIL_WINDOW_DAYS * 86_400, { reason: 'sample_ip_limit' });

  // 引用的方案必须存在且未过期
  const designIds = [...new Set(b.items.flatMap((i) => (i.designId ? [i.designId] : [])))];
  const live = await liveDesignIds(designIds);
  if (live.size !== designIds.length) return NextResponse.json({ error: 'design_invalid' }, { status: 422 });

  // 国家代码同样只在请求经过认证的 nginx（X-Edge-Auth 正确）时才信任
  const ipCountry = trustedCountry(req.headers);
  // 产品备注和留言一起评分（链接、垃圾词同样计入）
  const scoredText = [b.message, ...b.items.map((i) => i.notes)].filter(Boolean).join('\n');
  const trust = scoreInquiry({ ...b.contact, ipCountry, message: scoredText || undefined });
  // 编号完全随机，不依赖计数，并发下不会重复（ref 有唯一约束兜底）
  const d = new Date();
  const ref = `PJ-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}-${randomId(6).toUpperCase()}`;

  // 建询盘和绑定 logo 在同一事务里：logo 必须存在、未过期、未绑定，条件更新只有一个请求能成功；失败整体回滚
  let inquiry;
  try {
    inquiry = await prisma.$transaction(async (tx) => {
      if (sampleEmail) {
        // 同一规范化邮箱排队判断，避免并发绕过
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'sample:' + sampleEmail}))`;
        const since = new Date(Date.now() - SAMPLE_EMAIL_WINDOW_DAYS * 86_400_000);
        if (await tx.sampleRequest.findFirst({ where: { normalizedEmail: sampleEmail, createdAt: { gte: since } }, select: { id: true } })) throw new SampleLimited();
      }
      const created = await tx.inquiry.create({
        data: {
          ref, replyToken: randomId(24), locale: b.locale, source: b.source, message: b.message,
          trustScore: trust.score, trustReasons: trust.reasons, ipCountry,
          attribution: (b.attribution ?? undefined) as object | undefined,
          retainUntil: new Date(Date.now() + retention.inquiryDays * 86_400_000),
          contact: { create: { ...b.contact, normalizedEmail: normalizeEmail(b.contact.email) } },
          items: { create: b.items.map((i) => ({ ...i, config: (i.config ?? undefined) as object | undefined })) },
          ...(sampleEmail ? { sample: { create: { normalizedEmail: sampleEmail, shippingAddress: b.shippingAddress } } } : {}),
        },
      });
      // 被询盘引用的方案不再过期，跟随询盘保留期
      if (designIds.length) await tx.sharedDesign.updateMany({ where: { id: { in: designIds } }, data: { expiresAt: null } });
      if (b.logoUploadId) {
        const r = await tx.logoUpload.updateMany({
          where: { id: b.logoUploadId, inquiryId: null, expiresAt: { gt: new Date() } },
          data: { inquiryId: created.id },
        });
        if (r.count !== 1) throw new LogoInvalid();
      }
      return created;
    });
  } catch (e) {
    // 按邮箱的限制不返回 retryAfter / Retry-After，避免借此探测某邮箱何时申请过
    if (e instanceof SampleLimited) return sampleRecentResponse();
    if (e instanceof LogoInvalid) return NextResponse.json({ error: 'logo_invalid' }, { status: 422 });
    throw e;
  }

  // 邮件：失败不影响提交（sendSafely 记日志 + 后台告警）。模板变量全部转义；不回显留言；后台链接只用 SITE_URL + 内部 id
  const notify = process.env.INQUIRY_NOTIFY_EMAIL;
  const vars = { name: b.contact.name, company: b.contact.company, ...summarizeItems(b.items), inquiryId: ref, locale: b.locale };
  try {
    await Promise.allSettled([
      notify && sendSafely('inquiry-notify', { to: notify, ...inquiryNotifyMail({ ...vars, adminId: inquiry.id, score: trust.score }) }),
      // 自动回复只发给可信询盘；同一邮箱 24 小时 1 封（数据库）+ 按邮箱和 IP 限流，防止被当作发信跳板
      trust.score >= REVIEW_THRESHOLD && sendAutoReplyOnce(inquiry.id, email, ip, b.source === 'SAMPLE' ? 'sample' : 'inquiry', { ...vars, ...summarizeItems(b.items, b.locale) }),
    ]);
  } catch (e) { console.error('[mail] unexpected', (e as Error).message); }

  return NextResponse.json({ ref: inquiry.ref }, { status: 201 });
}

/**
 * 自动回复限制存在数据库里：多实例、重启都不会失效。
 * 在事务里按邮箱加 Postgres 事务级咨询锁，同一邮箱的并发请求排队判断，只有一条能抢到。
 */
async function sendAutoReplyOnce(inquiryId: string, email: string, ip: string | null, kind: 'inquiry' | 'sample', vars: Parameters<typeof customerAckMail>[1]) {
  // 限流 key、咨询锁、数据库 24 小时判断都用规范化邮箱（去 +后缀、Gmail 去点），别名不能绕过
  const key = normalizeEmail(email);
  const [emailOk, ipOk] = await Promise.all([hitRateLimit(`autoreply:e:${rateLimitKeyHash(key)}`, 1, 86_400_000, { onStoreError: 'closed' }), hitRateLimit(`autoreply:ip:${rateLimitSubject(ip)}`, 5, 86_400_000, { onStoreError: 'closed' })]);
  if (!emailOk || !ipOk) return;
  const since = new Date(Date.now() - 86_400_000);
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'autoreply:' + key}))`;
    // 24 小时内同一规范化邮箱发过自动回复就不再发（Contact.normalizedEmail 精确匹配，有索引）
    const recent = await tx.inquiry.findFirst({ where: { id: { not: inquiryId }, autoReplyAt: { gte: since }, contact: { normalizedEmail: key } }, select: { id: true } });
    if (recent) return false;
    const r = await tx.inquiry.updateMany({ where: { id: inquiryId, autoReplyAt: null }, data: { autoReplyAt: new Date() } });
    return r.count === 1;
  });
  if (claimed) await sendSafely(`${kind}-ack`, { to: email, ...customerAckMail(kind, vars) });
}
