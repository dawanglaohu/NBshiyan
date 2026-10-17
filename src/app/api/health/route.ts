import { prisma } from '@/lib/server/db';
import { clientIp, rateLimitSubject } from '@/lib/server/security';
import { healthResponse } from '@/lib/server/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 健康检查（Docker HEALTHCHECK / 运维探活）：200 {ok:true} 或 503 {ok:false}，不暴露任何版本或配置。见 src/lib/server/health.ts */
export async function GET(req: Request) {
  return healthResponse({ selectOne: () => prisma.$queryRaw`SELECT 1`, subject: rateLimitSubject(clientIp(req)) });
}
