import { LogoError, type LogoUpload } from './logoUpload';

/** 本地开发用模拟（NEXT_PUBLIC_LOGO_UPLOAD_MOCK=1）：#59 合并前接口不存在 */
export async function mockUpload(file: File): Promise<LogoUpload> {
  await new Promise((r) => setTimeout(r, 400));
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) throw new LogoError('corrupt');
  if (img.width > 4096 || img.height > 4096) throw new LogoError('dimensions');
  return { uploadId: Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join(''), width: img.width, height: img.height, bytes: file.size, uploadedAt: Date.now() };
}

