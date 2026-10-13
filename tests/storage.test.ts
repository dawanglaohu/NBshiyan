import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStorage, S3Storage, createStorage, assertKey } from '../src/lib/server/storage';
import { mockServer } from './helpers';

test('keys: only server-shaped keys with allowed extensions', () => {
  for (const k of ['logos/2026-10/abc.png', 'models/x1/main.glb', 'models/x1/poster.webp']) assert.equal(assertKey(k), k);
  for (const k of ['../etc/passwd.png', '/abs.png', 'a//b.png', 'a/../b.png', 'x.svg', 'x.png.exe', 'sp ace.png', 'x.PNG%00.png', ''])
    assert.throws(() => assertKey(k), /bad storage key/, k);
});

test('local: put/get/delete, private mode, no overwrite', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'st-'));
  try {
    const s = new LocalStorage(dir);
    await s.put('logos/a.png', Buffer.from('hi'));
    assert.equal((await s.get('logos/a.png'))?.toString(), 'hi');
    assert.equal((await stat(path.join(dir, 'logos/a.png'))).mode & 0o777, 0o600);
    await assert.rejects(s.put('logos/a.png', Buffer.from('x')), /EEXIST/);
    await s.delete('logos/a.png');
    assert.equal(await s.get('logos/a.png'), null);
    await s.delete('logos/a.png'); // 幂等
    await assert.rejects(s.put('../escape.png', Buffer.from('x')), /bad storage key/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('s3/r2: SigV4-signed path-style requests, conditional put, 404 -> null', async () => {
  const objects = new Map<string, Buffer>();
  const srv = await mockServer((r, res) => {
    const key = decodeURIComponent(r.url);
    if (r.method === 'PUT') {
      if (r.headers['if-none-match'] === '*' && objects.has(key)) { res.statusCode = 412; return void res.end(); }
      objects.set(key, r.body); return void res.end();
    }
    if (r.method === 'GET') { const b = objects.get(key); if (!b) { res.statusCode = 404; return void res.end(); } return void res.end(b); }
    if (r.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return void res.end(); }
  });
  try {
    const s = new S3Storage({ endpoint: srv.url, bucket: 'packjoyu-private', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' });
    await s.put('models/m1/main.glb', Buffer.from('glTF'), 'model/gltf-binary');
    const put = srv.reqs[0];
    assert.equal(put.method, 'PUT');
    assert.equal(put.url, '/packjoyu-private/models/m1/main.glb');
    assert.match(String(put.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/);
    assert.ok(put.headers['x-amz-date'] && put.headers['x-amz-content-sha256']);
    assert.equal(put.headers['content-type'], 'model/gltf-binary');
    assert.equal(put.headers['if-none-match'], '*');
    assert.equal(put.body.toString(), 'glTF');
    assert.equal((await s.get('models/m1/main.glb'))?.toString(), 'glTF');
    await assert.rejects(s.put('models/m1/main.glb', Buffer.from('x')), /412/);
    assert.equal(await s.get('models/none.glb'), null);
    await s.delete('models/m1/main.glb');
    assert.equal(await s.get('models/m1/main.glb'), null);
    assert.equal(srv.reqs.some((r) => JSON.stringify(r.headers).includes('secret')), false, 'secret never sent');
    await assert.rejects(s.get('../x.png'), /bad storage key/);
  } finally { await srv.close(); }
});

test('s3/r2: server errors surface', async () => {
  const srv = await mockServer((_r, res) => { res.statusCode = 500; res.end(); });
  try {
    const s = new S3Storage({ endpoint: srv.url, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' });
    await assert.rejects(s.get('a.png'), /500/);
    await assert.rejects(s.put('a.png', Buffer.from('x')), /500/);
    await assert.rejects(s.delete('a.png'), /500/);
  } finally { await srv.close(); }
});

test('factory: env selection and validation', () => {
  assert.ok(createStorage({}) instanceof LocalStorage);
  assert.ok(createStorage({ STORAGE_DRIVER: 'r2', R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b' }) instanceof S3Storage);
  assert.throws(() => createStorage({ STORAGE_DRIVER: 'r2' }), /R2_BUCKET/);
  assert.throws(() => createStorage({ STORAGE_DRIVER: 'r2', R2_ENDPOINT: 'http://x', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', NODE_ENV: 'production' }), /https/);
  assert.throws(() => createStorage({ STORAGE_DRIVER: 's3x' }), /未知/);
});
