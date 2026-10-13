// 客户 Logo 上传：对应 docs/API.md `POST /api/uploads/logo`（PR #59）。
// 公开接口，不需要 Turnstile；返回的 uploadId 1 小时内有效，提交询盘时作为 logoUploadId 绑定。
import { logoUploadMockEnabled } from '../mockFlags';
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

/** 本地开发用模拟（NEXT_PUBLIC_LOGO_UPLOAD_MOCK=1）：#59 合并前接口不存在 */
async function mockUpload(file: File): Promise<LogoUpload> {
  await new Promise((r) => setTimeout(r, 400));
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) throw new LogoError('corrupt');
  if (img.width > 4096 || img.height > 4096) throw new LogoError('dimensions');
  return { uploadId: Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join(''), width: img.width, height: img.height, bytes: file.size, uploadedAt: Date.now() };
}

export class LogoError extends Error { constructor(public code: LogoErrorCode) { super(code); } }
export const uploadLogo = logoUploadMockEnabled() ? mockUpload : realUpload;
