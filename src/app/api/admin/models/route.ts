import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { storage } from '@/lib/server/storage';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { noStore, jsonErr } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { readMultipart, fileField } from '@/lib/server/multipart';
import { isGlb, encodePoster, MODEL_ANIM_MAX_BYTES, LOD_MAX_BYTES, POSTER_MAX_BYTES } from '@/lib/server/models';
import { sniffImage } from '@/lib/server/uploads';
import { adminView, processModel } from '@/lib/server/model-service';

export const runtime = 'nodejs';
const ROLES = ['ADMIN', 'EDITOR'] as const;

export async function GET(req: Request) {
  const ctx = await requireAdmin(req, [...ROLES]);
  if (ctx instanceof Response) return ctx;
  const limited = await enforceAdminRateLimit(req, 'model.list');
  if (limited) return limited;
  const sp = new URL(req.url).searchParams;
  const status = z.enum(['UPLOADED', 'PROCESSING', 'READY', 'FAILED']).optional().safeParse(sp.get('status') ?? undefined);
  const product = sp.get('product');
  if (!status.success || (product && !/^[a-z0-9-]{1,80}$/.test(product))) return jsonErr('invalid', 400);
  const rows = await prisma.model3D.findMany({
    where: { ...(status.data ? { status: status.data } : {}), ...(product ? { productSlug: product } : {}), ...(sp.get('published') ? { published: sp.get('published') === 'true' } : {}) },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }], take: 200,
  });
  return NextResponse.json({ items: rows.map(adminView) }, { headers: noStore });
}

const Meta = z.object({
  productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/),
  category: z.string().trim().min(1).max(60),
  animated: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  sortOrder: z.coerce.number().int().min(0).max(10_000).default(0),
});

/** 第 1 步：上传（GLB 必填，lod、poster 可选），随后同步跑检查（第 2 步）。返回模型和 checks。 */
export async function POST(req: Request) {
  const ctx = await requireAdmin(req, [...ROLES]);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'model.upload', 20));
  if (blocked) return blocked;
  const form = await readMultipart(req, MODEL_ANIM_MAX_BYTES + LOD_MAX_BYTES + POSTER_MAX_BYTES + 64 * 1024);
  if (form instanceof Response) return form;
  const meta = Meta.safeParse(Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string')));
  if (!meta.success) return NextResponse.json({ error: 'invalid', issues: meta.error.flatten() }, { status: 400, headers: noStore });
  const glb = await fileField(form, 'file');
  if (!glb) return jsonErr('missing_file', 400);
  if (glb.length > MODEL_ANIM_MAX_BYTES) return jsonErr('too_large', 413);
  if (!isGlb(glb)) return jsonErr('unsupported_type', 415);
  const lod = await fileField(form, 'lod');
  if (lod && (lod.length > LOD_MAX_BYTES)) return jsonErr('too_large', 413);
  if (lod && !isGlb(lod)) return jsonErr('unsupported_type', 415);
  const posterIn = await fileField(form, 'poster');
  let poster: Buffer | null = null;
  if (posterIn) {
    if (posterIn.length > POSTER_MAX_BYTES) return jsonErr('too_large', 413);
    if (!sniffImage(posterIn)) return jsonErr('unsupported_type', 415);
    try { poster = await encodePoster(posterIn); } catch { return jsonErr('invalid_image', 422); }
  }

  const m = await prisma.model3D.create({ data: { ...meta.data, sourceKey: 'pending', status: 'UPLOADED', uploadedBy: ctx.user.id } });
  const base = `models/${m.id}`;
  const keys = { sourceKey: `${base}/main.glb`, lodKey: lod ? `${base}/lod.glb` : null, posterKey: poster ? `${base}/poster.webp` : null };
  await storage.put(keys.sourceKey, glb, 'model/gltf-binary');
  if (lod) await storage.put(keys.lodKey!, lod, 'model/gltf-binary');
  if (poster) await storage.put(keys.posterKey!, poster, 'image/webp');
  await prisma.model3D.update({ where: { id: m.id }, data: keys });
  const done = await processModel(m.id);
  await audit({ actorId: ctx.user.id, action: 'model.upload', target: m.id, meta: { productSlug: m.productSlug, bytes: glb.length, status: done.status }, ip: ctx.ip });
  return NextResponse.json(adminView(done), { status: 201, headers: noStore });
}
