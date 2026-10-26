import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_ANIM_MAX_BYTES, LOD_MAX_BYTES, POSTER_MAX_BYTES, MODEL_UPLOAD_MAX_REQUEST_BYTES, MODEL_UPLOAD_FORM_OVERHEAD, modelUploadSizeError } from '../src/lib/server/models';
import { LIMITS, uploadTotalError } from '../src/lib/admin/models';
import { readFileSync } from 'node:fs';

const MB4 = 4 * 1024 * 1024;

test('request cap is under 4MB (Vercel body limit ~4.5MB) and fits all per-file limits + overhead', () => {
  assert.ok(MODEL_UPLOAD_MAX_REQUEST_BYTES < MB4);
  assert.ok(MODEL_UPLOAD_MAX_REQUEST_BYTES <= 4_000_000);
  assert.ok(MODEL_ANIM_MAX_BYTES + LOD_MAX_BYTES + POSTER_MAX_BYTES + MODEL_UPLOAD_FORM_OVERHEAD <= MODEL_UPLOAD_MAX_REQUEST_BYTES);
});

test('client limits match server limits', () => {
  assert.equal(LIMITS.total, MODEL_UPLOAD_MAX_REQUEST_BYTES);
  assert.equal(LIMITS.glb, MODEL_ANIM_MAX_BYTES);
  assert.equal(LIMITS.lod, LOD_MAX_BYTES);
  assert.equal(LIMITS.poster, POSTER_MAX_BYTES);
});

test('server pre-check by Content-Length', () => {
  assert.equal(modelUploadSizeError('1000'), null);
  assert.equal(modelUploadSizeError(String(MODEL_UPLOAD_MAX_REQUEST_BYTES)), null);
  assert.equal(modelUploadSizeError(String(MODEL_UPLOAD_MAX_REQUEST_BYTES + 1)), 'upload_too_large');
  assert.equal(modelUploadSizeError(String(5 * 1024 * 1024)), 'upload_too_large');
  assert.equal(modelUploadSizeError(null), 'length_required');
  assert.equal(modelUploadSizeError(''), 'length_required');
  assert.equal(modelUploadSizeError('abc'), 'length_required');
  assert.equal(modelUploadSizeError('-1'), 'length_required');
});

test('route rejects before reading body and caps readMultipart at the request limit', () => {
  const src = readFileSync('src/app/api/admin/models/route.ts', 'utf8');
  const post = src.slice(src.indexOf('export async function POST'));
  const pre = post.indexOf('modelUploadSizeError(');
  assert.ok(pre > 0 && pre < post.indexOf('readMultipart('));
  assert.match(post, /readMultipart\(req, MODEL_UPLOAD_MAX_REQUEST_BYTES\)/);
  assert.match(post, /status: sizeErr === 'upload_too_large' \? 413 : 411/);
});

test('client-side total check with clear message', () => {
  assert.equal(uploadTotalError([{ size: LIMITS.glb }, { size: LIMITS.lod }, { size: LIMITS.poster }]), null);
  const msg = uploadTotalError([{ size: 2_000_000 }, { size: 2_000_000 }]);
  assert.ok(msg && /4\.00MB/.test(msg) && /4MB/.test(msg));
  const ui = readFileSync('src/components/admin/models/ModelUpload.tsx', 'utf8');
  assert.match(ui, /uploadTotalError\(/);
  assert.match(ui, /modelUploadErrorText\(/);
  assert.match(readFileSync('src/components/admin/models/ModelUploadAlert.tsx', 'utf8'), /upload_too_large:/);
});
