import { assertKey } from './storage';

/**
 * 所有输出存储文件的接口共用的响应头（第二道防线，local 和 R2 驱动都一样：应用自己读出字节再返回，没有签名跳转）。
 * - Content-Type 只由存储 key 的扩展名决定：扩展名是写入时按文件头（magic bytes）检测出的类型（logo 重编码为 PNG、poster 为 WebP、GLB 校验 glTF 头；
 *   local 驱动写入前还会再校验一次），并且必须在白名单里。从不使用请求里的类型，也不用数据库里存的 mime 字段。不认识 → application/octet-stream + attachment。
 * - 一律 X-Content-Type-Options: nosniff 和 Content-Security-Policy: default-src 'none'; sandbox（next.config 的全站 CSP 对这些路径排除，避免被覆盖）。
 * - 非图片（含 GLB、未知类型）→ Content-Disposition: attachment，文件名只用服务端生成的 id；图片 inline，文件名同样只用 id。
 * - 私有文件 → Cache-Control: private, no-store；公开文件由调用方给缓存策略。
 */
export const STORED_TYPES = { png: 'image/png', webp: 'image/webp', glb: 'model/gltf-binary' } as const;
export const FILE_CSP = "default-src 'none'; sandbox";
export const PRIVATE_NO_STORE = 'private, no-store';
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export type FileAccess = { access: 'private' } | { access: 'public'; cacheControl: string };

export function storedFileHeaders(key: string, id: string, bytes: number, access: FileAccess): Record<string, string> {
  let ext = '';
  try { ext = assertKey(key).slice(key.lastIndexOf('.') + 1); } catch { ext = ''; }
  const known = Object.prototype.hasOwnProperty.call(STORED_TYPES, ext);
  const type = known ? STORED_TYPES[ext as keyof typeof STORED_TYPES] : 'application/octet-stream';
  const isImage = type.startsWith('image/');
  const name = `${SAFE_ID.test(id) ? id : 'file'}${known ? `.${ext}` : ''}`;
  return {
    'Content-Type': type,
    'Content-Length': String(bytes),
    'Content-Disposition': `${isImage ? 'inline' : 'attachment'}; filename="${name}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': FILE_CSP,
    'Cache-Control': access.access === 'private' ? PRIVATE_NO_STORE : access.cacheControl,
  };
}

/** 统一的文件响应：字节 + storedFileHeaders，额外头（如 X-Robots-Tag）只能追加，不能覆盖上面这些 */
export function storedFileResponse(data: Buffer, key: string, id: string, access: FileAccess, extra: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(data), { headers: { ...extra, ...storedFileHeaders(key, id, data.length, access) } });
}
