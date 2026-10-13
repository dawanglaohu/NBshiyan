import { NextResponse } from 'next/server';
import { cleanupOrphanLogos, secretMatches } from '@/lib/server/uploads';

export const runtime = 'nodejs';

/** 定时任务：删除 24 小时未绑定询盘的 logo 上传。需 Authorization: Bearer $CRON_SECRET（Vercel Cron 会自动带上）。 */
async function handle(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.CRON_SECRET)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const deleted = await cleanupOrphanLogos();
  return NextResponse.json({ deleted });
}
export { handle as GET, handle as POST };
