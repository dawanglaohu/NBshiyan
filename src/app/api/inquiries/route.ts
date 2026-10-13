import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { randomId, rateLimit, verifyTurnstile, escapeHtml } from '@/lib/server/security';
import { scoreInquiry } from '@/lib/server/trust';
import { sendMail, autoReply } from '@/lib/server/mail';

const Body = z.object({
  source: z.enum(['FORM', 'WIZARD', 'CART', 'CUSTOMIZER', 'SAMPLE']),
  locale: z.enum(['en', 'ru']),
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
    config: z.record(z.unknown()).optional(),
    designId: z.string().regex(/^[A-Za-z0-9]{10}$/).optional(),
  })).max(30).default([]),
  attribution: z.record(z.unknown()).optional(),
  website: z.string().max(0).optional(), // 诱饵字段
  turnstileToken: z.string().optional(),
});

const RETAIN_DAYS = 730;

export async function POST(req: Request) {
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  if (!rateLimit(`inq:${ip ?? 'unknown'}`)) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid', issues: parsed.error.flatten() }, { status: 400 });
  const b = parsed.data;
  if (b.website) return NextResponse.json({ ref: 'PJ-OK' }, { status: 201 }); // 机器人，静默丢弃
  if (!(await verifyTurnstile(b.turnstileToken, ip))) return NextResponse.json({ error: 'captcha' }, { status: 403 });

  const ipCountry = req.headers.get('cf-ipcountry');
  const trust = scoreInquiry({ ...b.contact, ipCountry, message: b.message });
  const year = new Date().getFullYear();
  const count = await prisma.inquiry.count({ where: { createdAt: { gte: new Date(`${year}-01-01`) } } });
  const ref = `PJ-${year}-${String(count + 1).padStart(4, '0')}-${randomId(3)}`;

  const inquiry = await prisma.inquiry.create({
    data: {
      ref, replyToken: randomId(24), locale: b.locale, source: b.source, message: b.message,
      trustScore: trust.score, trustReasons: trust.reasons, ipCountry,
      attribution: (b.attribution ?? undefined) as object | undefined,
      retainUntil: new Date(Date.now() + RETAIN_DAYS * 86_400_000),
      contact: { create: b.contact },
      items: { create: b.items.map((i) => ({ ...i, config: (i.config ?? undefined) as object | undefined })) },
      ...(b.source === 'SAMPLE' ? { sample: { create: {} } } : {}),
    },
  });

  const notify = process.env.INQUIRY_NOTIFY_EMAIL;
  const products = b.items.map((i) => `${escapeHtml(i.productSlug)}${i.quantity ? ` × ${i.quantity}` : ''}`).join('<br>') || '—';
  await Promise.allSettled([
    notify && sendMail({
      to: notify,
      subject: `[${trust.score < 40 ? '待核实' : '新询盘'}] ${ref} · ${b.contact.region} · ${b.contact.company ?? b.contact.name}`,
      html: `<p>${escapeHtml(b.contact.name)} &lt;${escapeHtml(b.contact.email)}&gt;</p><p>${products}</p><pre>${escapeHtml(b.message ?? '')}</pre><p>score ${trust.score}</p>`,
    }),
    sendMail({ to: b.contact.email, ...autoReply(b.locale, b.contact.name, ref) }),
  ]);

  return NextResponse.json({ ref: inquiry.ref }, { status: 201 });
}
