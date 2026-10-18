import { storedFileResponse } from './file-response';
import { MEDIA_FILE_RE, PUBLIC_ASSET_ID_RE, PUBLIC_ASSET_SIZES, type PublicAssetSize } from './public-assets';
import type { PublicAssetRow } from './public-assets-admin';
import type { PrivateStorage } from './storage';

/**
 * GET /media/<id>-<w>.webp：公开图片。只对未删除的 PublicAsset 返回；w 是尺寸的名义长边：800 → sm、1600 → lg。
 * - 查库、读存储之前先校验文件名：id 必须完全匹配 PUBLIC_ASSET_ID_RE，w 必须在 PUBLIC_ASSET_SIZES 白名单里，否则直接 404。
 *   存储 key 只取库里那一行的 smKey / lgKey（服务端生成），从不用请求里的字符串拼路径。
 * - 内容按 id 不可变（重新上传是新 id）→ Cache-Control: public, max-age=31536000, immutable
 * - Content-Type 由存储 key（.webp）决定，nosniff + CSP default-src 'none'; sandbox（storedFileResponse）；不设 Cookie
 * - 404：no-store（删除后不被缓存成 404 以外的东西，也不缓存 404 本身）
 */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export type MediaDeps = { findLive(id: string): Promise<PublicAssetRow | null>; storage: Pick<PrivateStorage, 'get'> };
const nf = () => new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });

const SIZE_BY_W = new Map<string, PublicAssetSize>(Object.entries(PUBLIC_ASSET_SIZES).map(([s, w]) => [String(w), s as PublicAssetSize]));

/** 文件名 → { id, size }；不合法返回 null（不做任何解码，Next 传进来的 params 已解码，含 / . % 的都不匹配） */
export function parseMediaFile(file: unknown): { id: string; size: PublicAssetSize } | null {
  if (typeof file !== 'string' || file.length > 64) return null;
  const m = MEDIA_FILE_RE.exec(file);
  if (!m) return null;
  const [, id, w] = m;
  const size = SIZE_BY_W.get(w);
  return size && PUBLIC_ASSET_ID_RE.test(id) ? { id, size } : null;
}

export async function handleMedia(file: string, d: MediaDeps): Promise<Response> {
  const f = parseMediaFile(file);
  if (!f) return nf();
  const a = await d.findLive(f.id);
  if (!a) return nf();
  const key = f.size === 'lg' ? a.lgKey : a.smKey;
  const data = key ? await d.storage.get(key) : null;
  if (!key || !data) return nf();
  return storedFileResponse(data, key, `${f.id}-${PUBLIC_ASSET_SIZES[f.size]}`, { access: 'public', cacheControl: MEDIA_CACHE_CONTROL });
}
