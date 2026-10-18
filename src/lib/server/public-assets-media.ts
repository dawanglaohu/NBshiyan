import { storedFileResponse } from './file-response';
import { MEDIA_FILE_RE } from './public-assets';
import type { PublicAssetRow } from './public-assets-admin';
import type { PrivateStorage } from './storage';

/**
 * GET /media/<id>-<w>.webp：公开图片。只对未删除的 PublicAsset、且 w 等于它某个尺寸的实际宽度时返回。
 * - 内容按 id 不可变（重新上传是新 id）→ Cache-Control: public, max-age=31536000, immutable
 * - Content-Type 由存储 key（.webp）决定，nosniff + CSP default-src 'none'; sandbox（storedFileResponse）；不设 Cookie
 * - 404：no-store（删除后不被缓存成 404 以外的东西，也不缓存 404 本身）
 */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export type MediaDeps = { findLive(id: string): Promise<PublicAssetRow | null>; storage: Pick<PrivateStorage, 'get'> };
const nf = () => new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });

export async function handleMedia(file: string, d: MediaDeps): Promise<Response> {
  const m = MEDIA_FILE_RE.exec(file);
  if (!m) return nf();
  const [, id, w] = m;
  const a = await d.findLive(id);
  if (!a) return nf();
  const width = Number(w);
  const key = width === a.lgWidth ? a.lgKey : width === a.smWidth ? a.smKey : null;
  const data = key ? await d.storage.get(key) : null;
  if (!key || !data) return nf();
  return storedFileResponse(data, key, `${id}-${width}`, { access: 'public', cacheControl: MEDIA_CACHE_CONTROL });
}
