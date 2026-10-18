import { createHash } from 'crypto';
import sharp from 'sharp';
import { sniffImage } from './uploads';
import { MEDIA_SIZES, mediaUrl } from './site-settings-model';

/**
 * #350 PublicAsset 图片处理（纯逻辑，不连库、不碰存储，测试直接调用）。
 * - 只认 magic bytes：JPEG / PNG / WebP；扩展名、文件名、客户端 Content-Type 一律不看。HEIC、GIF、SVG、AVIF、TIFF 等全部 unsupported_type。
 * - sharp 先读文件头：格式必须和 magic bytes 一致；多帧（动图 WebP / APNG）拒绝；像素数 > 60,000,000（解压炸弹；全栈定的上限，5000 万像素手机实拍可传）在解码前拒绝，
 *   sharp 自身也带 limitInputPixels 兜底。
 * - 先按 EXIF 方向旋转（.rotate()），再重新编码成 WebP；sharp 默认不写任何元数据（EXIF / GPS / XMP / ICC 都不保留，转成 sRGB）。
 * - 两种尺寸按「长边」：sm 长边 800、lg 长边 1600，保持比例、不裁切、不放大。长边 < 800 拒绝（image_too_small）；
 *   800–1599 接受但带 warnings: ['image_small']。长边正好 800 时 sm、lg 是同一个文件。
 * - 只返回输出的 WebP，原图不落盘。
 */
export const PUBLIC_ASSET_MAX_BYTES = 10 * 1024 * 1024;
/** 整个 multipart 请求体的上限：文件 10 MB + 表单边界和字段头的余量 */
export const PUBLIC_ASSET_MAX_REQUEST_BYTES = PUBLIC_ASSET_MAX_BYTES + 64 * 1024;
export const PUBLIC_ASSET_MAX_PIXELS = 60_000_000;
export const PUBLIC_ASSET_MIN_LONG_EDGE = 800;
export const PUBLIC_ASSET_SIZES = MEDIA_SIZES;
export type PublicAssetSize = keyof typeof PUBLIC_ASSET_SIZES;
export const PUBLIC_ASSET_KIND = 'about';
export const PUBLIC_ASSET_ID_RE = /^[A-Za-z0-9]{24}$/;
export const WEBP_QUALITY = 82;

export type PublicAssetError = 'file_too_large' | 'unsupported_type' | 'image_too_small' | 'image_too_large_dimensions' | 'processing_failed';
export type PublicAssetWarning = 'image_small';
export type Rendition = { data: Buffer; width: number; height: number };
export type ProcessResult =
  | { ok: true; sm: Rendition; lg: Rendition; same: boolean; warnings: PublicAssetWarning[]; sha256: string; bytes: number }
  | { ok: false; error: PublicAssetError };

export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** 公开地址：/media/<id>-<w>.webp（w = 尺寸的名义长边，只有 800 / 1600，见 mediaUrl） */
export const publicAssetUrl = mediaUrl;
/** 公开文件名：id 和生成格式（PUBLIC_ASSET_ID_RE）完全一致，w 只能是 PUBLIC_ASSET_SIZES 的值（800 | 1600）；其余一律不匹配 */
export const MEDIA_FILE_RE = /^([A-Za-z0-9]{24})-(800|1600)\.webp$/;

/** 存储 key：只用服务端生成的 id 和年月，不含任何用户输入 */
export const publicAssetKey = (id: string, size: PublicAssetSize | 'one', now: Date) => `public-assets/${now.toISOString().slice(0, 7)}/${id}-${size}.webp`;

const OPTS = { limitInputPixels: PUBLIC_ASSET_MAX_PIXELS, failOn: 'error', animated: false, sequentialRead: true } as const;
const SHARP_FORMAT = { jpeg: 'jpeg', png: 'png', webp: 'webp' } as const;

/**
 * 同一进程里一次只处理一张（大图解码占内存，避免并发上传叠加）：前一张处理完（成功或失败）才开始下一张。
 * 不调 sharp.concurrency()：它只管单张图用几个线程，不管同时几张，且是进程级设置，会拖慢 Logo、海报。
 * 导出仅供测试。
 */
let queue: Promise<unknown> = Promise.resolve();
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function encode(input: Buffer, longEdge: number): Promise<Rendition> {
  const { data, info } = await sharp(input, OPTS)
    .rotate() // 按 EXIF 方向转正；之后输出不带任何元数据
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export function processPublicImage(input: Buffer): Promise<ProcessResult> {
  if (input.length > PUBLIC_ASSET_MAX_BYTES) return Promise.resolve({ ok: false, error: 'file_too_large' });
  const type = sniffImage(input);
  if (!type) return Promise.resolve({ ok: false, error: 'unsupported_type' });
  return serialize(async (): Promise<ProcessResult> => {
    try {
      // metadata() 只读文件头，不解码像素；这里关掉 limitInputPixels，才能自己判断并返回 image_too_large_dimensions。真正解码（encode）仍带 OPTS 的上限
      const meta = await sharp(input, { ...OPTS, limitInputPixels: false }).metadata();
      if (meta.format !== SHARP_FORMAT[type]) return { ok: false, error: 'unsupported_type' };
      if ((meta.pages ?? 1) > 1) return { ok: false, error: 'unsupported_type' };
      if (!meta.width || !meta.height) return { ok: false, error: 'processing_failed' };
      if (meta.width * meta.height > PUBLIC_ASSET_MAX_PIXELS) return { ok: false, error: 'image_too_large_dimensions' };
      const longEdge = Math.max(meta.width, meta.height); // 旋转不改变长边
      if (longEdge < PUBLIC_ASSET_MIN_LONG_EDGE) return { ok: false, error: 'image_too_small' };
      const lg = await encode(input, PUBLIC_ASSET_SIZES.lg);
      const same = longEdge <= PUBLIC_ASSET_SIZES.sm;
      const sm = same ? lg : await encode(input, PUBLIC_ASSET_SIZES.sm);
      const warnings: PublicAssetWarning[] = longEdge < PUBLIC_ASSET_SIZES.lg ? ['image_small'] : [];
      return { ok: true, sm, lg, same, warnings, sha256: sha256Hex(input), bytes: input.length };
    } catch {
      // 含 sharp 的像素上限报错、损坏文件：不把异常信息返回给客户端
      return { ok: false, error: 'processing_failed' };
    }
  });
}

/**
 * 读 multipart 请求体，边读边计数：Content-Length 超限直接拒绝（不读）；没有或谎报 Content-Length 时，累计超过上限立即 cancel，
 * 不会把超大请求整个读进内存。返回文件字节或错误码。
 */
export async function readUploadFile(req: Request, field = 'file', maxRequest = PUBLIC_ASSET_MAX_REQUEST_BYTES, maxFile = PUBLIC_ASSET_MAX_BYTES):
  Promise<{ ok: true; data: Buffer } | { ok: false; error: 'file_too_large' | 'invalid' | 'missing_file'; status: number }> {
  const lenHeader = req.headers.get('content-length');
  if (lenHeader !== null) {
    const len = Number(lenHeader);
    if (!Number.isFinite(len) || len < 0) return { ok: false, error: 'invalid', status: 400 };
    if (len > maxRequest) { await req.body?.cancel().catch(() => {}); return { ok: false, error: 'file_too_large', status: 413 }; }
  }
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('multipart/form-data')) return { ok: false, error: 'invalid', status: 400 };
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxRequest) { await reader.cancel().catch(() => {}); return { ok: false, error: 'file_too_large', status: 413 }; }
    chunks.push(value);
  }
  let file: FormDataEntryValue | null;
  try {
    const form = await new Request('http://local/', { method: 'POST', headers: { 'content-type': ct }, body: new Uint8Array(Buffer.concat(chunks)) }).formData();
    file = form.get(field);
  } catch { return { ok: false, error: 'invalid', status: 400 }; }
  if (!file || typeof file === 'string') return { ok: false, error: 'missing_file', status: 400 };
  if (file.size > maxFile) return { ok: false, error: 'file_too_large', status: 413 };
  return { ok: true, data: Buffer.from(await file.arrayBuffer()) };
}
