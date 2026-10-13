import { CHECK_ORDER, LIMITS, ModelApiError, readGlbJson, type AdminModel, type ModelApi, type ModelCheck } from './models';

// 示例：在浏览器里模拟服务端静态检查（只读 GLB 头和 JSON），规则同 docs/API.md
type Rec = AdminModel & { _json?: Awaited<ReturnType<typeof readGlbJson>>['json']; _lodBytes?: number };
const db = new Map<string, Rec>();
const kb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)}MB` : `${Math.round(b / 1024)}KB`);
const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));

function runChecks(m: Rec) {
  const ext = m._json?.extensionsUsed ?? [];
  const anims = (m._json?.animations ?? []).map((a) => a.name ?? '');
  const limit = m.animated ? LIMITS.sizeAnimated : LIMITS.sizeNormal;
  const progressive = ext.includes('NEEDLE_progressive');
  const c: ModelCheck[] = [
    { key: 'format', ok: true, detail: 'glTF 2.0 binary', severity: 'error' },
    { key: 'compress', ok: ext.includes('KHR_draco_mesh_compression') || ext.includes('EXT_meshopt_compression'), detail: ext.includes('KHR_draco_mesh_compression') ? 'Draco 几何压缩' + (ext.includes('KHR_texture_basisu') ? ' · KTX2 贴图' : ' · 贴图非 KTX2') : ext.includes('EXT_meshopt_compression') ? 'meshopt 几何压缩' : '几何未压缩（需 Draco 或 meshopt）', severity: 'error' },
    { key: 'size', ok: m.sizeBytes <= limit, detail: `${kb(m.sizeBytes)} / ${m.animated ? '1.50MB' : '1.00MB'}`, severity: 'error' },
    { key: 'triangles', ok: true, detail: `${(m.triangles ?? 0).toLocaleString('en-US')} 个三角面`, severity: 'error' },
    { key: 'textures', ok: ext.includes('KHR_texture_basisu'), detail: ext.includes('KHR_texture_basisu') ? 'KTX2，最大 1024px' : '有非 KTX2 贴图', severity: 'warn' },
    { key: 'animation', ok: !m.animated || anims.includes('Open'), detail: anims.length ? `动画：${anims.join('、')}` : '无动画', severity: m.animated ? 'error' : 'warn' },
    { key: 'bounds', ok: true, detail: '最长边 0.32 m', severity: 'warn' },
    { key: 'lod', ok: m.hasLod || !progressive ? m.hasLod : false, detail: m.hasLod ? `已上传高精度层 ${kb(m._lodBytes ?? 0)}` : progressive ? '主文件声明了 NEEDLE_progressive，需要上传 .lod0.glb' : '没有高精度层', severity: progressive && !m.hasLod ? 'error' : 'warn' }
  ];
  m.checks = CHECK_ORDER.map((k) => c.find((x) => x.key === k)!);
  const failed = m.checks.filter((x) => !x.ok && x.severity === 'error').map((x) => x.key);
  m.status = failed.length ? 'FAILED' : 'READY';
  m.error = failed.length ? failed.join(',') : null;
  m.updatedAt = new Date().toISOString();
}
const out = (m: Rec): AdminModel => { const { _json, _lodBytes, ...rest } = m; void _json; void _lodBytes; return structuredClone(rest); };

export const mockModelApi: ModelApi = {
  async upload({ file, lod, poster, productSlug, category, animated, sortOrder }) {
    await wait(600);
    if (file.size > LIMITS.glb) throw new ModelApiError('too_large', 413);
    const g = await readGlbJson(file);
    if (!g.ok) throw new ModelApiError('unsupported_type', 415);
    const now = new Date().toISOString();
    const m: Rec = { id: `mdl_${Date.now().toString(36)}`, productSlug, category, sortOrder: sortOrder ?? 0, published: false, publishedAt: null, status: 'PROCESSING', sizeBytes: file.size, animated, customizable: null, checks: [], triangles: 18_432, animations: (g.json?.animations ?? []).map((a) => a.name ?? ''), hasLod: !!lod, hasPoster: !!poster, createdAt: now, updatedAt: now, _json: g.json, _lodBytes: lod?.size };
    runChecks(m); db.set(m.id, m);
    return out(m);
  },
  async get(id) { await wait(100); return out(db.get(id)!); },
  async update(id, patch) { const m = db.get(id)!; Object.assign(m, patch); if ('animated' in patch) runChecks(m); await wait(); return out(m); },
  async recheck(id) { const m = db.get(id)!; runChecks(m); await wait(); return out(m); },
  async publish(id, published) {
    const m = db.get(id)!; await wait();
    if (published && m.status !== 'READY') throw new ModelApiError('not_ready', 409);
    m.published = published; m.publishedAt = published ? new Date().toISOString() : null;
    return { model: out(m), replaced: published ? ['mdl_prev_example'] : [] };
  }
};
