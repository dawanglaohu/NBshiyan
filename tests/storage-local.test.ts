// deploy-readiness：STORAGE_DRIVER=local（自建服务器挂载数据卷）的安全要求。见 PR 正文的安全审查清单第 1 项。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStorage, S3Storage, createStorage, assertKey, detectStoredType, assertContentMatchesKey } from '../src/lib/server/storage';
import { deleteLogoFiles } from '../src/lib/server/privacy';
import { cleanupOrphanLogos } from '../src/lib/server/uploads';
import { sniffImage } from '../src/lib/server/uploads';
import { mockServer } from './helpers';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const GLB = (() => { const b = Buffer.alloc(20); b.write('glTF', 0, 'latin1'); b.writeUInt32LE(2, 4); b.writeUInt32LE(20, 8); return b; })();
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'st-local-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const exists = (p: string) => access(p).then(() => true, () => false);

test('key 只能是服务端生成的形状：拒绝 ..、绝对路径、NUL、反斜杠、svg/html 等扩展名', () => {
  for (const k of ['../x.png', 'a/../../x.png', '/etc/x.png', 'a\0.png', 'a\\b.png', 'x.svg', 'x.html', 'x.htm', 'x.png.svg', 'x.svg.png/../y.png', 'logos/a b.png', '', 'logos/.png/..'])
    assert.throws(() => assertKey(k), /bad storage key/, JSON.stringify(k));
});

test('扩展名由文件头决定：文件头与 key 扩展名不一致（含 SVG / HTML 伪装成 png）一律拒绝写入', async () => {
  assert.equal(detectStoredType(PNG), 'png'); assert.equal(detectStoredType(WEBP), 'webp'); assert.equal(detectStoredType(GLB), 'glb');
  for (const b of [SVG, HTML, Buffer.alloc(0), Buffer.from('GIF89a')]) assert.equal(detectStoredType(b), null);
  // 与上传接口用的 sniffImage 对 png/webp 判断一致
  assert.equal(sniffImage(PNG), 'png'); assert.equal(sniffImage(WEBP), 'webp');
  assert.throws(() => assertContentMatchesKey('logos/a.png', SVG), /does not match/);
  assert.throws(() => assertContentMatchesKey('logos/a.png', WEBP), /does not match/);
  await withDir(async (dir) => {
    const s = new LocalStorage(dir);
    for (const [k, b] of [['logos/x.png', SVG], ['logos/y.png', HTML], ['models/m/poster.webp', PNG], ['models/m/main.glb', PNG]] as const)
      await assert.rejects(s.put(k, b), /does not match/, k);
    assert.deepEqual(await readdir(dir).catch(() => []), [], 'nothing written for rejected content');
    await s.put('logos/ok.png', PNG); await s.put('models/m/poster.webp', WEBP); await s.put('models/m/main.glb', GLB);
  });
});

test('路径穿越不可能：解析后必须在 UPLOAD_DIR 内，get/put/delete 都拒绝', async () => {
  await withDir(async (dir) => {
    const root = path.join(dir, 'root');
    await writeFile(path.join(dir, 'outside.png'), PNG);
    const s = new LocalStorage(root);
    for (const k of ['../outside.png', '..%2foutside.png', '/outside.png'])
      for (const op of [() => s.get(k), () => s.put(k, PNG), () => s.delete(k)]) await assert.rejects(op(), /bad storage key/, k);
    assert.ok(await exists(path.join(dir, 'outside.png')), 'outside file untouched');
  });
});

test('不跟随符号链接：目录或文件是符号链接（指向根目录外）时 get/put/delete 都拒绝，外部文件不受影响', async () => {
  await withDir(async (dir) => {
    const root = path.join(dir, 'root'); const outside = path.join(dir, 'outside');
    await mkdir(root); await mkdir(path.join(outside, 'sub'), { recursive: true });
    await writeFile(path.join(outside, 'sub', 'secret.png'), PNG);
    await writeFile(path.join(outside, 'target.png'), PNG);
    await symlink(outside, path.join(root, 'logos'));                         // 目录链接
    await mkdir(path.join(root, 'models'));
    await symlink(path.join(outside, 'target.png'), path.join(root, 'models', 'a.png')); // 文件链接
    const s = new LocalStorage(root);
    await assert.rejects(s.get('logos/sub/secret.png'), /bad storage key/);
    await assert.rejects(s.put('logos/sub/new.png', PNG), /bad storage key/);
    await assert.rejects(s.delete('logos/sub/secret.png'), /bad storage key/);
    await assert.rejects(s.get('models/a.png'), /bad storage key/);
    await assert.rejects(s.put('models/a.png', PNG), /EEXIST|bad storage key/);
    assert.ok(await exists(path.join(outside, 'sub', 'secret.png')));
    assert.ok(!(await exists(path.join(outside, 'sub', 'new.png'))), 'no write through symlinked dir');
    assert.deepEqual(await readFile(path.join(outside, 'target.png')), PNG);
    // 删除文件链接只删链接本身，不删链接指向的外部文件
    await s.delete('models/a.png');
    assert.ok(await exists(path.join(outside, 'target.png')));
  });
});

test('根目录本身是符号链接（挂载点）时正常工作：按 realpath 判断', async () => {
  await withDir(async (dir) => {
    const real = path.join(dir, 'vol'); await mkdir(real);
    await symlink(real, path.join(dir, 'link'));
    const s = new LocalStorage(path.join(dir, 'link'));
    await s.put('logos/2026-10/abcdefghijklmnop.png', PNG);
    assert.deepEqual(await s.get('logos/2026-10/abcdefghijklmnop.png'), PNG);
    assert.ok(await exists(path.join(real, 'logos/2026-10/abcdefghijklmnop.png')));
  });
});

test('目录不能当文件读；不存在的 key / 根目录不存在 → null；没有任何列目录的方法', async () => {
  await withDir(async (dir) => {
    const s = new LocalStorage(path.join(dir, 'nope'));
    assert.equal(await s.get('logos/a.png'), null);
    await s.delete('logos/a.png'); // 幂等，不报错
    const s2 = new LocalStorage(dir);
    await mkdir(path.join(dir, 'logos', 'd.png'), { recursive: true });
    await assert.rejects(s2.get('logos/d.png'), /bad storage key|EISDIR/);
    assert.deepEqual(Object.getOwnPropertyNames(LocalStorage.prototype).sort(), ['constructor', 'delete', 'get', 'put', 'target'].sort());
  });
});

test('createStorage：生产（APP_ENV=production）local 驱动必须给绝对路径 UPLOAD_DIR，不回落到 cwd；开发默认不变；R2 不变', () => {
  assert.throws(() => createStorage({ APP_ENV: 'production', STORAGE_DRIVER: 'local' }), /UPLOAD_DIR/);
  assert.throws(() => createStorage({ APP_ENV: 'production', STORAGE_DRIVER: 'local', UPLOAD_DIR: 'rel/dir' }), /UPLOAD_DIR/);
  assert.throws(() => createStorage({ APP_ENV: 'production', STORAGE_DRIVER: 'local', UPLOAD_DIR: '  ' }), /UPLOAD_DIR/);
  assert.ok(createStorage({ APP_ENV: 'production', STORAGE_DRIVER: 'local', UPLOAD_DIR: '/data/uploads' }) instanceof LocalStorage);
  assert.ok(createStorage({ STORAGE_DRIVER: 'local', UPLOAD_DIR: '' }) instanceof LocalStorage);
  assert.ok(createStorage({ APP_ENV: 'production', STORAGE_DRIVER: 'r2', R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET: 'd' }) instanceof S3Storage);
});

// ---- 删除 / 匿名化 / 保留期清理与 R2 一致，并且真的删掉磁盘文件 ----
const LOGO = 'logos/2026-10/abcdefghijklmnop.png';

test('隐私删除（deleteLogoFiles，deleteCustomer 和到期匿名化共用）：本地驱动删掉磁盘文件，与 R2 驱动结果一致', async () => {
  await withDir(async (dir) => {
    const local = new LocalStorage(dir);
    await local.put(LOGO, PNG);
    await deleteLogoFiles([{ path: LOGO }, { path: '../../etc/passwd.png' }], local);
    assert.ok(!(await exists(path.join(dir, LOGO))), 'disk file removed');
    assert.equal(await local.get(LOGO), null);
  });
  const objects = new Map<string, Buffer>();
  const srv = await mockServer((r, res) => {
    if (r.method === 'PUT') { objects.set(r.url, r.body); return void res.end(); }
    if (r.method === 'DELETE') { objects.delete(r.url); res.statusCode = 204; return void res.end(); }
    if (r.method === 'GET') { const b = objects.get(r.url); res.statusCode = b ? 200 : 404; return void res.end(b); }
  });
  try {
    const r2 = new S3Storage({ endpoint: srv.url, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' });
    await r2.put(LOGO, PNG, 'image/png');
    await deleteLogoFiles([{ path: LOGO }, { path: '../../etc/passwd.png' }], r2);
    assert.equal(await r2.get(LOGO), null);
    assert.equal(srv.reqs.filter((r) => r.method === 'DELETE').length, 1, 'non-logo key skipped on both drivers');
  } finally { await srv.close(); }
});

test('孤儿 logo 清理（cleanupOrphanLogos，保留期 cron）：本地驱动删掉记录对应的磁盘文件', async () => {
  await withDir(async (dir) => {
    const local = new LocalStorage(dir);
    await local.put(LOGO, PNG);
    const rows = [{ id: 'u1', path: LOGO }];
    const db = { logoUpload: { findMany: async () => rows.splice(0), deleteMany: async () => ({ count: 1 }) } };
    assert.equal(await cleanupOrphanLogos(new Date(), Number.POSITIVE_INFINITY, { db: db as never, storage: local }), 1);
    assert.ok(!(await exists(path.join(dir, LOGO))));
  });
});

test('上传大小 / 类型白名单与 R2 一致：限额和嗅探在路由里，存储驱动无关（同一个 storage 抽象）', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/app/api/uploads/logo/route.ts', 'src/app/api/admin/models/route.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /from '@\/lib\/server\/storage'/);
    assert.doesNotMatch(src, /LocalStorage|S3Storage|STORAGE_DRIVER/, `${f} must not branch on driver`);
  }
});

test('文件只经现有接口提供：每个读存储的接口都设置 Content-Type 和 X-Content-Type-Options: nosniff；没有 inline 的 svg/html', async () => {
  const { readFileSync } = await import('node:fs');
  const routes = ['src/app/api/admin/uploads/[id]/route.ts', 'src/app/api/designs/[id]/logo/route.ts', 'src/app/api/models/[id]/[variant]/route.ts', 'src/app/api/admin/models/[id]/file/route.ts'];
  for (const f of routes) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /storage\.get\(/, f);
    assert.match(src, /'Content-Type':/, f);
    assert.match(src, /'X-Content-Type-Options': 'nosniff'/, f);
    assert.doesNotMatch(src, /image\/svg|text\/html/, f);
  }
  // 私有文件（询盘 logo）先鉴权后读取
  const adminUpload = readFileSync(routes[0], 'utf8');
  assert.ok(adminUpload.indexOf('requireAdmin(') < adminUpload.indexOf('storage.get('));
  const adminModel = readFileSync(routes[3], 'utf8');
  assert.ok(adminModel.indexOf('requireAdmin(') < adminModel.indexOf('storage.get('));
  // 上传目录不在 public/ 下，也没有静态路由或 rewrite 指向它
  const cfg = readFileSync('next.config.ts', 'utf8');
  assert.doesNotMatch(cfg, /UPLOAD_DIR|storage\/uploads/);
  await assert.rejects(stat('public/storage'));
});
