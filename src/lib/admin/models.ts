// 后台模型上传数据层，按 PR #89 的 docs/API.md「后台模型管理」：
// POST /api/admin/models（multipart 上传，同步静态检查，不压缩）、GET/PATCH /api/admin/models/:id、
// POST /api/admin/models/:id/process（重新检查）、POST /api/admin/models/:id/publish、GET /api/admin/models/:id/file?variant=
export type ModelStatus = 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED';
export type CheckKey = 'format' | 'compress' | 'size' | 'triangles' | 'textures' | 'animation' | 'bounds' | 'lod';
export const CHECK_ORDER: CheckKey[] = ['format', 'compress', 'size', 'triangles', 'textures', 'animation', 'bounds', 'lod'];
export const CHECK_LABEL: Record<CheckKey, string> = {
  format: '格式', compress: '压缩', size: '体积', triangles: '面数', textures: '贴图', animation: '动画', bounds: '尺寸', lod: '高精度层'
};
/** 上传限制（服务端以同样规则拒绝：413 / 415） */
export const LIMITS = { glb: 1.5 * 1024 * 1024, lod: 1024 * 1024, poster: 512 * 1024, sizeNormal: 1024 * 1024, sizeAnimated: 1.5 * 1024 * 1024, total: 4_000_000 };
/** 留给 multipart 表单开销的余量（和服务端一致） */
const FORM_OVERHEAD = 64 * 1024;
/** 本次上传的文件总大小是否超过单次请求上限（< 4MB，见服务端 MODEL_UPLOAD_MAX_REQUEST_BYTES）。超过返回提示文字，否则 null */
export function uploadTotalError(files: { size: number }[]): string | null {
  const total = files.reduce((a, f) => a + f.size, 0);
  if (total + FORM_OVERHEAD <= LIMITS.total) return null;
  return `本次上传的文件合计 ${(total / 1_000_000).toFixed(2)}MB，超过单次上传上限 ${((LIMITS.total - FORM_OVERHEAD) / 1_000_000).toFixed(2)}MB（服务器单个请求不能超过 4MB）。请先压缩 GLB 或封面后再上传`;
}

export type ModelCheck = { key: CheckKey; ok: boolean; detail: string; severity: 'error' | 'warn' };
export type AdminModel = {
  id: string; productSlug: string; category: string; sortOrder: number; published: boolean; publishedAt?: string | null;
  status: ModelStatus; sizeBytes: number; animated: boolean; customizable?: Record<string, unknown> | null;
  checks: ModelCheck[]; triangles?: number | null; animations?: string[]; error?: string | null; uploadedBy?: string | null;
  hasLod: boolean; hasPoster: boolean; createdAt: string; updatedAt: string;
};
export type ModelUploadInput = { file: File; lod?: File; poster?: File; productSlug: string; category: string; animated: boolean; sortOrder?: number };
export type ModelPatch = Partial<Pick<AdminModel, 'productSlug' | 'category' | 'sortOrder' | 'animated' | 'customizable'>>;

export interface ModelApi {
  upload(input: ModelUploadInput): Promise<AdminModel>;
  get(id: string): Promise<AdminModel>;
  update(id: string, patch: ModelPatch): Promise<AdminModel>;
  recheck(id: string): Promise<AdminModel>;
  /** 只有 READY 能上架，否则 409 not_ready；同产品旧版本自动下架，返回其 id */
  publish(id: string, published: boolean): Promise<{ model: AdminModel; replaced: string[] }>;
}

export class ModelApiError extends Error { constructor(public code: string, public status?: number) { super(code); } }

/** error 级未通过项：有则不能进入下一步 / 上架；warn 只提示 */
export const blockingChecks = (m: AdminModel) => m.checks.filter((c) => !c.ok && c.severity === 'error');
export const sizeFailed = (m: AdminModel) => m.checks.some((c) => c.key === 'size' && !c.ok);

/** 读 GLB 头和 JSON 块（前端预检用，不解码几何） */
export async function readGlbJson(file: File): Promise<{ ok: boolean; json?: { extensionsUsed?: string[]; animations?: { name?: string }[]; images?: unknown[] } }> {
  const buf = await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer();
  const v = new DataView(buf);
  if (buf.byteLength < 20 || v.getUint32(0, true) !== 0x46546c67 || v.getUint32(4, true) !== 2) return { ok: false };
  const len = v.getUint32(12, true);
  try { return { ok: true, json: JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len))) }; } catch { return { ok: false }; }
}
