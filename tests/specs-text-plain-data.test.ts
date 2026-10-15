import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SpecInput, toRow, adminView, publicView } from '../src/lib/server/specs';

// Refs #239：文本字段里的 <script> 作为纯数据原样存、原样以 JSON 返回；服务端不渲染 HTML，转义由前端负责
const XSS = '<script>alert(1)</script>';
const now = new Date('2026-10-14T00:00:00Z');

function roundTrip() {
  const p = SpecInput.safeParse({ material: { en: XSS, ru: XSS }, notes: { en: XSS }, certifications: [{ name: XSS, certNo: XSS }] });
  assert.ok(p.success, JSON.stringify(!p.success && p.error.issues));
  const row = toRow(p.data);
  return { ...row, sampleFeeAmount: null, updatedAt: now } as unknown as Parameters<typeof adminView>[1];
}

test('script text stored verbatim (not stripped or escaped) by validation + toRow', () => {
  const r = roundTrip() as unknown as { material: { en: string }; notes: { en: string }; certifications: { name: string }[] };
  assert.equal(r.material.en, XSS);
  assert.equal(r.notes.en, XSS);
  assert.equal(r.certifications[0].name, XSS);
});

test('admin + public views return it as a plain JSON string with application/json', async () => {
  const row = roundTrip();
  for (const body of [adminView('gift-box', row), publicView('gift-box', row, 'en')]) {
    const res = Response.json(body);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    const text = await res.text();
    assert.ok(text.includes('"<script>alert(1)</script>"'));
    assert.ok(!text.includes('&lt;'));
    const back = JSON.parse(text);
    assert.equal(back.material?.en ?? back.material, XSS);
    assert.equal(back.notes?.en ?? back.notes, XSS);
  }
});

test('spec API routes only respond via NextResponse.json (no server-side HTML rendering)', () => {
  for (const f of ['src/app/api/specs/route.ts', 'src/app/api/specs/[category]/route.ts', 'src/app/api/admin/specs/[category]/route.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /NextResponse\.json\(/, f);
    assert.ok(!/text\/html|dangerouslySetInnerHTML|new Response\(/.test(src), f);
  }
});
