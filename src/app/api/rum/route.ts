import { NextResponse } from 'next/server';
import { clientIp, hitRateLimit, readBody } from '@/lib/server/security';
import { parseRum } from '@/lib/server/rum';
import { isProdEnvFrom } from '@/lib/site';

export const runtime = 'nodejs';

/** 真实用户性能（web-vitals）上报，只接受本站同源请求；写入结构化日志，由 Vercel 日志/Log Drain 汇总。 */
export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  const self = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
  if (origin && self && origin !== self && isProdEnvFrom()) return new NextResponse(null, { status: 403 });
  const ip = clientIp(req);
  // 存储故障时放行（open）；拿不到 IP 时走共用的 noip 总闸
  const ok = ip ? await hitRateLimit(`rum:${ip}`, 60, 60_000, { onStoreError: 'open' }) : await hitRateLimit('rum:noip:all', 600, 60_000, { onStoreError: 'open' });
  if (!ok) return new NextResponse(null, { status: 429 });
  const raw = await readBody(req, 1_000);
  const m = raw === null ? null : parseRum(raw);
  if (!m) return new NextResponse(null, { status: 400 });
  console.log(JSON.stringify({ type: 'rum', ...m }));
  return new NextResponse(null, { status: 204 });
}
