import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { randomId, hitRateLimit, clientIp, readBody } from '@/lib/server/security';

const Body = z.object({ productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/), config: z.record(z.unknown()) });

export async function POST(req: Request) {
  const ip = clientIp(req) ?? 'unknown';
  if (!(await hitRateLimit(`design:${ip}`, 30))) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  const raw = await readBody(req, 16_000);
  if (raw === null) return NextResponse.json({ error: 'too_large' }, { status: 413 });
  let json: unknown = null;
  try { json = JSON.parse(raw); } catch {}
  const p = Body.safeParse(json);
  if (!p.success || JSON.stringify(p.data.config).length > 8000) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  const id = randomId(10);
  await prisma.sharedDesign.create({ data: { id, productSlug: p.data.productSlug, config: p.data.config as object } });
  return NextResponse.json({ id, url: `/s/${id}` }, { status: 201 });
}
