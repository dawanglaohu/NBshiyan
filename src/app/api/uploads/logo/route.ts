import { NextResponse } from 'next/server';
import sharp, { type OutputInfo } from 'sharp';
import { prisma } from '@/lib/server/db';
import { storage } from '@/lib/server/storage';
import { clientIp, randomId, rateLimit } from '@/lib/server/security';
import { LOGO_BIND_TTL_MS, LOGO_MAX_BYTES, LOGO_MAX_DIM, sniffImage } from '@/lib/server/uploads';

export const runtime = 'nodejs';

const MULTIPART_OVERHEAD = 16 * 1024; // 表单边界和字段头的余量
const err = (error: string, status: number) => NextResponse.json({ error }, { status });

async function readLimited(req: Request, max: number): Promise<Buffer | null> {
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  // 每 IP 每小时 10 次；另有全站每小时 500 次总闸；拿不到 IP 的请求共用一个桶
  const ipOk = rateLimit(ip ? `logo:${ip}` : 'logo:noip:all', ip ? 10 : 50, 60 * 60_000);
  const globalOk = rateLimit('logo:global', 500, 60 * 60_000);
  if (!ipOk || !globalOk) return err('rate_limited', 429);

  const max = LOGO_MAX_BYTES + MULTIPART_OVERHEAD;
  const len = Number(req.headers.get('content-length') ?? 0);
  if (!Number.isFinite(len) || len > max) return err('too_large', 413);
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) return err('invalid', 400);

  const raw = await readLimited(req, max);
  if (raw === null) return err('too_large', 413);
  let file: FormDataEntryValue | null;
  try {
    const form = await new Request('http://local/', { method: 'POST', headers: { 'content-type': req.headers.get('content-type')! }, body: new Uint8Array(raw) }).formData();
    file = form.get('file');
  } catch { return err('invalid', 400); }
  if (!file || typeof file === 'string') return err('missing_file', 400);
  if (file.size > LOGO_MAX_BYTES) return err('too_large', 413);
  const input = Buffer.from(await file.arrayBuffer());
  if (!sniffImage(input)) return err('unsupported_type', 415);

  let out: { data: Buffer; info: OutputInfo };
  try {
    const img = sharp(input, { limitInputPixels: LOGO_MAX_DIM * LOGO_MAX_DIM, failOn: 'error', animated: false });
    const meta = await img.metadata();
    if (!meta.width || !meta.height) return err('invalid_image', 422);
    if (meta.width > LOGO_MAX_DIM || meta.height > LOGO_MAX_DIM) return err('dimensions_too_large', 422);
    // 重新编码为 PNG（保留透明），按 EXIF 方向旋转；sharp 默认不写入任何元数据
    out = await img.rotate().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  } catch (e) {
    const msg = String((e as Error)?.message ?? '');
    return err(/pixel limit/i.test(msg) ? 'dimensions_too_large' : 'invalid_image', 422);
  }

  const id = randomId(24);
  const now = new Date();
  const key = `logos/${now.toISOString().slice(0, 7)}/${id}.png`;
  await storage.put(key, out.data);
  try {
    await prisma.logoUpload.create({
      data: { id, path: key, mime: 'image/png', width: out.info.width, height: out.info.height, bytes: out.data.length, expiresAt: new Date(now.getTime() + LOGO_BIND_TTL_MS) },
    });
  } catch (e) {
    await storage.delete(key).catch(() => {});
    throw e;
  }
  return NextResponse.json({ uploadId: id, width: out.info.width, height: out.info.height, bytes: out.data.length }, { status: 201 });
}
