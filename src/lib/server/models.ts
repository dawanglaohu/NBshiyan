import { NodeIO, GLB_BUFFER } from '@gltf-transform/core';
import sharp from 'sharp';

/**
 * GLB 静态检查。只解析容器和 JSON，不解码 Draco/meshopt、不执行任何内嵌内容、不访问外部地址
 * （buffers/images 的 uri 只允许 data:，其他一律在解析前拒绝；data: URI 只在内存里解码）。所有数字都来自 glTF JSON 的声明或嵌入图片的文件头。
 */

export const MODEL_MAX_BYTES = 1024 * 1024; // PRD：单模型 ≤ 1MB
export const MODEL_ANIM_MAX_BYTES = 1.5 * 1024 * 1024; // 带动画 ≤ 1.5MB
export const LOD_MAX_BYTES = 1024 * 1024; // gltf-progressive 高精度层（*.lod0.glb）
export const POSTER_MAX_BYTES = 512 * 1024;
/**
 * 一次模型上传请求（GLB + lod + 封面 + 表单字段）的总上限：4,000,000 字节（< 4MB）。
 * Vercel 函数请求体上限约 4.5MB，而上传走后端代理（整个读进内存再写 R2），超出会被平台直接 413（#74 §1）。
 * 单文件上限之和 + 表单开销必须小于它，见 tests/model-upload-limit.test.ts。
 */
export const MODEL_UPLOAD_MAX_REQUEST_BYTES = 4_000_000;
/** multipart 边界、字段名和元数据的余量 */
export const MODEL_UPLOAD_FORM_OVERHEAD = 64 * 1024;
/** 按 Content-Length 预检：缺失/非法/超过上限都返回错误码，否则 null */
export function modelUploadSizeError(contentLength: string | null): 'upload_too_large' | 'length_required' | null {
  if (contentLength === null || contentLength.trim() === '') return 'length_required';
  const n = Number(contentLength);
  if (!Number.isSafeInteger(n) || n < 0) return 'length_required';
  return n > MODEL_UPLOAD_MAX_REQUEST_BYTES ? 'upload_too_large' : null;
}
export const MAX_TRIANGLES = 100_000;
export const MAX_TEXTURE_DIM = 2048;
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

export type CheckKey = 'format' | 'compress' | 'lod' | 'size' | 'triangles' | 'textures' | 'animation' | 'bounds';
/** severity=error 未通过时不能上架；warn 只提示 */
export type Check = { key: CheckKey; ok: boolean; detail: string; severity: 'error' | 'warn' };

const ALLOWED_EXT = new Set([
  'KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression', 'KHR_mesh_quantization', 'KHR_texture_basisu',
  'KHR_texture_transform', 'KHR_materials_unlit', 'KHR_materials_emissive_strength', 'KHR_materials_clearcoat', 'KHR_materials_ior',
  'KHR_materials_specular', 'KHR_materials_sheen', 'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_variants',
  'EXT_texture_webp', 'KHR_lights_punctual',
  'NEEDLE_progressive', // 项目用 @needle-tools/gltf-progressive 做渐进加载，扩展只含 LOD 元数据
]);

export const isGlb = (b: Buffer) => b.length >= 20 && b.toString('latin1', 0, 4) === 'glTF' && b.readUInt32LE(4) === 2 && b.readUInt32LE(8) === b.length;

type J = Record<string, unknown> & {
  asset?: { version?: string }; extensionsUsed?: string[]; extensionsRequired?: string[];
  meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number; mode?: number }[] }[];
  accessors?: { count?: number; min?: number[]; max?: number[] }[];
  images?: { mimeType?: string; bufferView?: number; uri?: string; name?: string }[];
  textures?: { source?: number; extensions?: Record<string, { source?: number }> }[];
  animations?: { name?: string }[];
  buffers?: { uri?: string }[];
};

const mb = (n: number) => `${(n / 1048576).toFixed(2)}MB`;

/** 解析失败只给管理员看这句固定文案。解析器原文留在服务端日志里，截断，不带文件名。 */
function glbParseDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  console.error('[model-upload] glb parse failed:', raw.replace(/[\r\n]/g, ' ').slice(0, 120));
  return 'GLB 解析失败';
}

async function textureDims(img: Uint8Array, mime: string | undefined): Promise<[number, number] | null> {
  const b = Buffer.from(img);
  // KTX2：12 字节标识后 vkFormat(4) typeSize(4) pixelWidth(4) pixelHeight(4)
  if (mime === 'image/ktx2' || b.subarray(0, 12).equals(Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return b.length >= 28 ? [b.readUInt32LE(20), b.readUInt32LE(24)] : null;
  }
  try {
    const m = await sharp(b, { limitInputPixels: 8192 * 8192 }).metadata(); // 只读文件头
    return m.width && m.height ? [m.width, m.height] : null;
  } catch { return null; }
}

export type Inspect = { checks: Check[]; triangles: number; ok: boolean; animations: string[] };

export async function inspectGlb(glb: Buffer, opts: { animated: boolean; lod?: Buffer | null; nested?: boolean }): Promise<Inspect> {
  const checks: Check[] = [];
  const push = (key: CheckKey, ok: boolean, detail: string, severity: 'error' | 'warn' = 'error') => checks.push({ key, ok, detail, severity });
  const fail = () => ({ checks, triangles: 0, ok: false, animations: [] });

  // 1. 格式
  if (!isGlb(glb)) { push('format', false, '不是 glTF 2.0 二进制（GLB）文件'); return fail(); }
  const jsonLen = glb.readUInt32LE(12);
  if (jsonLen > MAX_JSON_BYTES) { push('format', false, 'JSON 块过大'); return fail(); }
  // 先自己读 JSON 块，显式拒绝任何非 data: 的 buffers[].uri / images[].uri（不依赖 binaryToJSON 的默认行为）
  try {
    if (glb.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLen > glb.length) throw new Error('JSON 块无效');
    const raw = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen)) as J;
    const uris = [...(raw.buffers ?? []).map((b) => b?.uri), ...(raw.images ?? []).map((i) => i?.uri)].filter((u) => u !== undefined);
    const badUri = uris.find((u) => typeof u !== 'string' || !u.startsWith('data:'));
    if (badUri !== undefined) { push('format', false, '包含外部资源地址（buffers/images 的 uri 只允许 data:），已拒绝'); return fail(); }
  } catch (e) { push('format', false, glbParseDetail(e)); return fail(); }
  let json: J; let resources: Record<string, Uint8Array>;
  try {
    const doc = await new NodeIO().binaryToJSON(new Uint8Array(glb.buffer, glb.byteOffset, glb.byteLength));
    json = doc.json as unknown as J; resources = doc.resources;
  } catch (e) { push('format', false, glbParseDetail(e)); return fail(); }
  if (json.asset?.version !== '2.0') { push('format', false, `glTF 版本 ${json.asset?.version ?? '未知'}，需要 2.0`); return fail(); }
  const unknownExt = [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])].filter((e) => !ALLOWED_EXT.has(e));
  if (unknownExt.length) { push('format', false, `不支持的扩展：${[...new Set(unknownExt)].join(', ').slice(0, 200)}`); return fail(); }
  push('format', true, `glTF 2.0 binary，${json.meshes?.length ?? 0} 个网格`);

  // 2. 压缩
  const used = new Set(json.extensionsUsed ?? []);
  const geo = used.has('KHR_draco_mesh_compression') ? 'Draco' : used.has('EXT_meshopt_compression') || used.has('KHR_meshopt_compression') ? 'meshopt' : null;
  const tex = used.has('KHR_texture_basisu') ? 'KTX2' : used.has('EXT_texture_webp') ? 'WebP' : null;
  push('compress', !!geo, `几何：${geo ?? '未压缩（需要 Draco 或 meshopt）'}；贴图：${tex ?? '未压缩（建议 KTX2）'}`);

  // 3. 体积
  const limit = opts.animated ? MODEL_ANIM_MAX_BYTES : MODEL_MAX_BYTES;
  push('size', glb.length <= limit, `${mb(glb.length)} / ${mb(limit)}${opts.animated ? '（带动画）' : ''}`);

  // 4. 三角面数（按 accessor 声明的 count；Draco 解压前也有）
  let triangles = 0;
  for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) {
    const mode = p.mode ?? 4;
    const n = p.indices !== undefined ? json.accessors?.[p.indices]?.count : json.accessors?.[p.attributes?.POSITION ?? -1]?.count;
    if (typeof n !== 'number') continue;
    triangles += mode === 4 ? Math.floor(n / 3) : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0;
  }
  push('triangles', triangles > 0 && triangles <= MAX_TRIANGLES, `${triangles.toLocaleString('en')} / ${MAX_TRIANGLES.toLocaleString('en')}`);

  // 5. 贴图
  const imgs = json.images ?? [];
  let worst = 0; const bad: string[] = []; let nonKtx = 0;
  for (let i = 0; i < imgs.length; i++) {
    const im = imgs[i];
    const bv = im.bufferView;
    const data = typeof bv === 'number' ? sliceBufferView(json, resources, bv) : im.uri && resources[im.uri] ? resources[im.uri] : null;
    const dims = data ? await textureDims(data, im.mimeType) : null;
    if (im.mimeType !== 'image/ktx2') nonKtx++;
    if (!dims) { bad.push(`#${i} 无法读取尺寸`); continue; }
    worst = Math.max(worst, dims[0], dims[1]);
    if (dims[0] > MAX_TEXTURE_DIM || dims[1] > MAX_TEXTURE_DIM) bad.push(`#${i} ${dims[0]}×${dims[1]}`);
  }
  push('textures', bad.length === 0, imgs.length ? `${imgs.length} 张，最大边 ${worst}px（上限 ${MAX_TEXTURE_DIM}）${nonKtx ? `，${nonKtx} 张非 KTX2` : ''}${bad.length ? `；问题：${bad.join('，').slice(0, 150)}` : ''}` : '无贴图', bad.length ? 'error' : nonKtx ? 'warn' : 'error');
  if (bad.length === 0 && nonKtx) checks[checks.length - 1].ok = true;

  // 6. 动画
  const animations = (json.animations ?? []).map((a, i) => (a.name ?? `#${i}`).slice(0, 60));
  if (opts.animated) push('animation', animations.includes('Open'), animations.length ? `动画：${animations.join(', ')}${animations.includes('Open') ? '' : '（缺少 Open）'}` : '标记为带动画，但文件里没有动画');
  else push('animation', true, animations.length ? `动画：${animations.join(', ')}（未标记带动画，按 1MB 上限）` : '无动画', 'warn');

  // 7. 包围盒（POSITION accessor 的 min/max，未计入节点变换，按米）
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) {
    const a = json.accessors?.[p.attributes?.POSITION ?? -1];
    if (!a?.min || !a?.max) continue;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a.min[k]); hi[k] = Math.max(hi[k], a.max[k]); }
  }
  const size = hi.map((h, k) => h - lo[k]);
  const finite = size.every((s) => Number.isFinite(s) && s >= 0);
  const maxDim = finite ? Math.max(...size) : NaN;
  push('bounds', finite && maxDim >= 0.01 && maxDim <= 5,
    finite ? `${size.map((s) => s.toFixed(3)).join(' × ')} m（未计节点缩放）${maxDim > 5 || maxDim < 0.01 ? '，尺寸异常，请确认单位为米' : ''}` : '缺少 POSITION min/max', 'warn');
  if (!finite) checks[checks.length - 1].severity = 'error';

  // 8. 轻量版（可选）
  if (opts.nested) return { checks, triangles, ok: true, animations };
  // 项目用 gltf-progressive：主 GLB 是轻量首屏版本，lod 文件（*.lod0.glb）是渐进加载的高精度层
  if (opts.lod) {
    const sub = isGlb(opts.lod) ? await inspectGlb(opts.lod, { animated: true, lod: null, nested: true }) : null;
    const bad = sub ? sub.checks.filter((c) => (c.key === 'format' || c.key === 'textures') && !c.ok).map((c) => c.detail) : ['不是 GLB'];
    const sizeOk = opts.lod.length <= LOD_MAX_BYTES;
    const tex = sub?.checks.find((c) => c.key === 'textures')?.detail;
    push('lod', sizeOk && bad.length === 0, `${mb(opts.lod.length)} / ${mb(LOD_MAX_BYTES)}${tex ? `；贴图 ${tex}` : ''}${bad.length ? `；问题：${bad.join('；').slice(0, 150)}` : ''}`);
  } else {
    const progressive = used.has('NEEDLE_progressive');
    push('lod', !progressive, progressive ? '文件声明了 NEEDLE_progressive，但没有上传对应的 lod0 文件' : '未提供（可选）', progressive ? 'error' : 'warn');
  }

  const ok = checks.every((c) => c.ok || c.severity === 'warn');
  return { checks, triangles, ok, animations };
}

function sliceBufferView(json: J, resources: Record<string, Uint8Array>, bvIndex: number): Uint8Array | null {
  const bv = (json as { bufferViews?: { buffer: number; byteOffset?: number; byteLength: number }[] }).bufferViews?.[bvIndex];
  if (!bv) return null;
  const buf = (json.buffers ?? [])[bv.buffer] as { uri?: string } | undefined;
  const data = resources[buf?.uri ?? GLB_BUFFER];
  if (!data) return null;
  const off = bv.byteOffset ?? 0;
  if (off + bv.byteLength > data.byteLength) return null;
  return data.subarray(off, off + bv.byteLength);
}

/** 封面：PNG/JPEG/WebP，重新编码为 WebP，最长边 1024 */
export async function encodePoster(b: Buffer) {
  return sharp(b, { limitInputPixels: 4096 * 4096, failOn: 'error' }).rotate().resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
}
