import { NextResponse } from 'next/server';
import { clientIp, hitRateLimit, rateLimitSubject, readBody } from '@/lib/server/security';
import { parseRum } from '@/lib/server/rum';
import { isProdEnvFrom } from '@/lib/site';

export const runtime = 'nodejs';

/** 真实用户性能（web-vitals）上报，只接受本站同源请求；写入结构化日志，由 Vercel 日志/Log Drain 汇总。 */
export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  const self = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
  if (origin && self && origin !== self && isProdEnvFrom()) return new NextResponse(null, { status: 403 });
  const ip = clientIp(req);
  // 存储故障时放行（open）；不可信来源（没有可信 IP）全部共用一个 untrusted 桶
  const ok = await hitRateLimit(`rum:${rateLimitSubject(ip)}`, 60, 60_000, { onStoreError: 'open' });
  if (!ok) return new NextResponse(null, { status: 429 });
  const raw = await readBody(req, 1_000);
  const m = raw === null ? null : parseRum(raw);
  if (!m) return new NextResponse(null, { status: 400 });
  console.log(JSON.stringify({ type: 'rum', ...m }));
  return new NextResponse(null, { status: 204 });
}
