import { NextResponse } from 'next/server';
import { clientIp, rateLimit, readBody } from '@/lib/server/security';
import { parseRum } from '@/lib/server/rum';

export const runtime = 'nodejs';

/** 真实用户性能（web-vitals）上报，只接受本站同源请求；写入结构化日志，由 Vercel 日志/Log Drain 汇总。 */
export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  const self = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
  if (origin && self && origin !== self && process.env.VERCEL_ENV === 'production') return new NextResponse(null, { status: 403 });
  const ip = clientIp(req) ?? 'unknown';
  if (!(await rateLimit(`rum:${ip}`, 60, 60_000))) return new NextResponse(null, { status: 429 });
  const raw = await readBody(req, 1_000);
  const m = raw === null ? null : parseRum(raw);
  if (!m) return new NextResponse(null, { status: 400 });
  console.log(JSON.stringify({ type: 'rum', ...m }));
  return new NextResponse(null, { status: 204 });
}
