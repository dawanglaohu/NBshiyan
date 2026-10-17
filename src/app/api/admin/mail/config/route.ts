import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/server/auth';
import { noStore } from '@/lib/server/admin/guard';
import { mailSwitchGate } from '@/lib/server/mail/http';
import { sendingEnabled } from '@/lib/server/mail/config';

export const runtime = 'nodejs';

/** §15 补充：GET /api/admin/mail/config → { sendingEnabled }。只说能不能发，不透露缺哪一项配置 */
export async function GET(req: Request) {
  const off = mailSwitchGate();
  if (off) return off;
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  return NextResponse.json({ sendingEnabled: sendingEnabled() }, { headers: noStore });
}
