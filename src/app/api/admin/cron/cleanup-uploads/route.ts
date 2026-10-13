import { NextResponse } from 'next/server';
import { cleanupOrphanLogos, secretMatches } from '@/lib/server/uploads';
import { cleanupExpiredDesigns } from '@/lib/server/designs';

export const runtime = 'nodejs';

/** 定时任务：删除过期方案短链接，以及 24 小时未绑定询盘且没被有效方案引用的 logo 上传。需 Authorization: Bearer $CRON_SECRET（Vercel Cron 会自动带上）。 */
async function handle(req: Request) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!secretMatches(token, process.env.CRON_SECRET)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // 先删过期方案，它们引用的 logo 随后才会被当作孤儿清理
  const designs = await cleanupExpiredDesigns();
  const deleted = await cleanupOrphanLogos();
  return NextResponse.json({ deleted, designs });
}
export { handle as GET, handle as POST };
