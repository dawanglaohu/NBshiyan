import { NextResponse } from 'next/server';

/** 读 multipart 表单：先按 Content-Length 拒绝，读取时再计数。返回 FormData 或错误响应。 */
export async function readMultipart(req: Request, maxBytes: number): Promise<FormData | NextResponse> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (!Number.isFinite(len) || len > maxBytes) return NextResponse.json({ error: 'too_large' }, { status: 413 });
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('multipart/form-data')) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); return NextResponse.json({ error: 'too_large' }, { status: 413 }); }
    chunks.push(value);
  }
  try {
    return await new Request('http://local/', { method: 'POST', headers: { 'content-type': ct }, body: new Uint8Array(Buffer.concat(chunks)) }).formData();
  } catch { return NextResponse.json({ error: 'invalid' }, { status: 400 }); }
}

export async function fileField(form: FormData, name: string): Promise<Buffer | null> {
  const f = form.get(name);
  if (!f || typeof f === 'string') return null;
  return Buffer.from(await f.arrayBuffer());
}
