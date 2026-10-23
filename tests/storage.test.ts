import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStorage, S3Storage, createStorage, assertKey } from '../src/lib/server/storage';
import { mockServer } from './helpers';

// 本地驱动写入前校验文件头与扩展名一致，测试数据用真实的文件头
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);

// 缺权限位时必须 skip。先断言模式再 return 会让覆盖拒绝跑不到；跳过整段则不能把 0600 记成通过。
function privateModeCapability(): { ready: true } | { ready: false; reason: string } {
  const base = mkdtempSync(path.join(tmpdir(), 'cap-mode-'));
  try {
    const file = path.join(base, 'f');
    writeFileSync(file, 'x', { mode: 0o600 });
    const mode = statSync(file).mode & 0o777;
    if (mode === 0o600) return { ready: true };
    return { ready: false, reason: `新建文件权限是 ${mode.toString(8).padStart(4, '0')} 而不是 0600，私有模式分支未执行` };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const privateModeCap = privateModeCapability();

test('前置能力：新建文件能否保留 0600 有明确结论', (t) => {
  const again = privateModeCapability();
  assert.equal(again.ready, privateModeCap.ready);
  t.diagnostic(privateModeCap.ready ? 'mode 0600 ready' : privateModeCap.reason);
  if (!privateModeCap.ready) assert.match(privateModeCap.reason, /未执行/);
});

test('适用平台：本地读写删除、拒绝覆盖与逃逸 key', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'st-neutral-'));
  try {
    const s = new LocalStorage(dir);
    await s.put('logos/a.png', PNG);
    assert.deepEqual(await s.get('logos/a.png'), PNG);
    await t.test('拒绝覆盖已有对象', async () => {
      await assert.rejects(s.put('logos/a.png', PNG), /EEXIST/);
    });
    await s.delete('logos/a.png');
    assert.equal(await s.get('logos/a.png'), null);
    await s.delete('logos/a.png');
    await assert.rejects(s.put('../escape.png', PNG), /bad storage key/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('keys: only server-shaped keys with allowed extensions', () => {
  for (const k of ['logos/2026-10/abc.png', 'models/x1/main.glb', 'models/x1/poster.webp']) assert.equal(assertKey(k), k);
  for (const k of ['../etc/passwd.png', '/abs.png', 'a//b.png', 'a/../b.png', 'x.svg', 'x.png.exe', 'sp ace.png', 'x.PNG%00.png', ''])
    assert.throws(() => assertKey(k), /bad storage key/, k);
});

test('local: put/get/delete, private mode, no overwrite', { skip: privateModeCap.ready ? false : privateModeCap.reason }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'st-'));
  try {
    const s = new LocalStorage(dir);
    await s.put('logos/a.png', PNG);
    assert.deepEqual(await s.get('logos/a.png'), PNG);
    assert.equal((await stat(path.join(dir, 'logos/a.png'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(dir, 'logos'))).mode & 0o777, 0o700);
    await t.test('拒绝覆盖已有对象', async () => {
      await assert.rejects(s.put('logos/a.png', PNG), /EEXIST/);
    });
    await s.delete('logos/a.png');
    assert.equal(await s.get('logos/a.png'), null);
    await s.delete('logos/a.png'); // 幂等
    await assert.rejects(s.put('../escape.png', PNG), /bad storage key/);
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
