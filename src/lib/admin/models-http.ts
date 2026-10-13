import { ModelApiError, type AdminModel, type ModelApi } from './models';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const json = typeof init?.body === 'string';
  const res = await fetch(`/api/admin${path}`, { credentials: 'same-origin', ...init, headers: json ? { 'Content-Type': 'application/json' } : undefined });
  if (!res.ok) { const e = await res.json().catch(() => ({})) as { error?: string }; throw new ModelApiError(e.error ?? `http_${res.status}`, res.status); }
  return res.json() as Promise<T>;
}
const enc = encodeURIComponent;

export const httpModelApi: ModelApi = {
  upload({ file, lod, poster, productSlug, category, animated, sortOrder }) {
    const fd = new FormData();
    fd.append('file', file); if (lod) fd.append('lod', lod); if (poster) fd.append('poster', poster);
    fd.append('productSlug', productSlug); fd.append('category', category); fd.append('animated', String(animated));
    if (sortOrder !== undefined) fd.append('sortOrder', String(sortOrder));
    return call<AdminModel>('/models', { method: 'POST', body: fd });
  },
  get: (id) => call(`/models/${enc(id)}`),
  update: (id, patch) => call(`/models/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  recheck: (id) => call(`/models/${enc(id)}/process`, { method: 'POST' }),
  // 假设返回 { ...模型对象, replaced }；文档只写了 replaced 字段
  async publish(id, published) {
    const r = await call<AdminModel & { replaced?: string[] }>(`/models/${enc(id)}/publish`, { method: 'POST', body: JSON.stringify({ published }) });
    const { replaced = [], ...model } = r;
    return { model: model as AdminModel, replaced };
  }
};
