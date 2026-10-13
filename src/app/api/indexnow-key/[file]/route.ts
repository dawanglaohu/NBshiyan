import { secretMatches } from '@/lib/server/uploads';
import { activeIndexNowKey } from '@/lib/seo/indexnow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 通过 next.config 的 rewrite 从 /{key}.txt 访问。功能关闭或文件名不对时一律 404。 */
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const key = activeIndexNowKey();
  const { file } = await params;
  if (!key || !secretMatches(file, `${key}.txt`)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(key, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Robots-Tag': 'noindex' },
  });
}
