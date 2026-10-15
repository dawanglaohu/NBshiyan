// 客户 Logo 上传：对应 docs/API.md `POST /api/uploads/logo`（PR #59）。
// 公开接口，不需要 Turnstile；返回的 uploadId 1 小时内有效，提交询盘时作为 logoUploadId 绑定。
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
/** 服务端 1 小时过期；前端留 5 分钟余量，快到期就提示重新上传 */
export const LOGO_TTL_MS = 55 * 60_000;

export type LogoErrorCode = 'type' | 'size' | 'dimensions' | 'corrupt' | 'rate' | 'network' | 'server';
export type LogoUpload = { uploadId: string; width: number; height: number; bytes: number; uploadedAt: number };

/** 选文件时的预检，只为及时提示；以服务端按文件头的校验为准 */
export function precheckLogo(file: File): LogoErrorCode | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return 'type';
  if (file.size > LOGO_MAX_BYTES) return 'size';
  return null;
}

const ERROR_MAP: Record<string, LogoErrorCode> = {
  unsupported_type: 'type', too_large: 'size', dimensions_too_large: 'dimensions', invalid_image: 'corrupt', rate_limited: 'rate'
};

async function realUpload(file: File): Promise<LogoUpload> {
  const fd = new FormData();
  fd.append('file', file);
  let res: Response;
  try { res = await fetch('/api/uploads/logo', { method: 'POST', body: fd }); } catch { throw new LogoError('network'); }
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (res.status === 201 && typeof data.uploadId === 'string') {
    return { uploadId: data.uploadId, width: Number(data.width), height: Number(data.height), bytes: Number(data.bytes), uploadedAt: Date.now() };
  }
  const byCode = ERROR_MAP[String(data.error ?? '')];
  if (byCode) throw new LogoError(byCode);
  throw new LogoError(res.status === 413 ? 'size' : res.status === 415 ? 'type' : res.status === 429 ? 'rate' : res.status === 422 ? 'corrupt' : 'server');
}

export class LogoError extends Error { constructor(public code: LogoErrorCode) { super(code); } }
// 生产构建：条件内联为 false，mock 的动态 import 被删除，不进生产包
export const uploadLogo: (file: File) => Promise<LogoUpload> = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_LOGO_UPLOAD_MOCK === '1'
  ? (file) => import('./logoUpload.mock').then((m) => m.mockUpload(file))
  : realUpload;
