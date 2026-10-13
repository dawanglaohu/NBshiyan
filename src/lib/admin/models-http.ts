import { ModelApiError, type AdminModel, type ModelApi } from './models';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const json = typeof init?.body === 'string';
  const res = await fetch(`/api/admin${path}`, { credentials: 'same-origin', ...init, headers: json ? { 'Content-Type': 'application/json' } : undefined });
  if (!res.ok) { const e = await res.json().catch(() => ({})) as { error?: string }; throw new ModelApiError(e.error ?? `http_${res.status}`, res.status); }
  return res.json() as Promise<T>;
}
const enc = encodeURIComponent;
/** 后端 Model3D 里 checks、sizeBytes 可为 null（刚上传或检查未跑完），这里补默认值 */
type RawModel = Omit<AdminModel, 'checks' | 'sizeBytes'> & { checks: AdminModel['checks'] | null; sizeBytes: number | null };
const norm = (m: RawModel): AdminModel => ({ ...m, checks: Array.isArray(m.checks) ? m.checks : [], sizeBytes: m.sizeBytes ?? 0, animations: m.animations ?? [] });

export const httpModelApi: ModelApi = {
  upload({ file, lod, poster, productSlug, category, animated, sortOrder }) {
    const fd = new FormData();
    fd.append('file', file); if (lod) fd.append('lod', lod); if (poster) fd.append('poster', poster);
    fd.append('productSlug', productSlug); fd.append('category', category); fd.append('animated', String(animated));
    if (sortOrder !== undefined) fd.append('sortOrder', String(sortOrder));
    return call<RawModel>('/models', { method: 'POST', body: fd }).then(norm);
  },
  get: (id) => call<RawModel>(`/models/${enc(id)}`).then(norm),
  update: (id, patch) => call<RawModel>(`/models/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }).then(norm),
  recheck: (id) => call<RawModel>(`/models/${enc(id)}/process`, { method: 'POST' }).then(norm),
  // docs/API.md + publish 路由：返回 { ...模型对象, replaced: [旧 id] }；未 READY 为 409 not_ready
  async publish(id, published) {
    const r = await call<RawModel & { replaced?: string[] }>(`/models/${enc(id)}/publish`, { method: 'POST', body: JSON.stringify({ published }) });
    const { replaced = [], ...model } = r;
    return { model: norm(model), replaced };
  }
};
