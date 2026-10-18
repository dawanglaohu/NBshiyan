// #350 PublicAsset 图片上传：判型、大小、像素上限、EXIF 转正 + 去元数据、按长边出两种尺寸、不放大、接口鉴权、about 引用校验、公开路由响应头。
// 依赖全部注入（内存库 + 真实 LocalStorage 临时目录），不连库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import type { Role, User } from '@prisma/client';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import {
  processPublicImage, serialize, readUploadFile, PUBLIC_ASSET_MAX_BYTES, PUBLIC_ASSET_MAX_REQUEST_BYTES, PUBLIC_ASSET_MAX_PIXELS, publicAssetUrl,
  MEDIA_FILE_RE, PUBLIC_ASSET_SIZES,
} from '../src/lib/server/public-assets';
import {
  handleUploadAsset, handleListAssets, handleDeleteAsset, AUDIT_ASSET_UPLOAD, AUDIT_ASSET_DELETE, ASSET_UPLOAD_RATE,
  type PublicAssetDeps, type PublicAssetRow, type PublicAssetRepo,
} from '../src/lib/server/public-assets-admin';
import { handleMedia, parseMediaFile, MEDIA_CACHE_CONTROL } from '../src/lib/server/public-assets-media';
import { LocalStorage } from '../src/lib/server/storage';
import { enforceAdminRateLimit, enforceAdminUserRateLimit } from '../src/lib/server/admin-guard';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';
import { FILE_CSP, fileRoute } from '../src/lib/server/file-response';
import { securityHeaders } from '../security-headers';
import {
  handlePutAboutImages, handlePutAboutLocale, handleGetAbout, type SiteSettingsDeps, type SiteSettingsStore, type CasResult,
} from '../src/lib/server/site-settings-admin';
import { storedVersion } from '../src/lib/server/site-settings-model';
import { createSiteSettingsReader } from '../src/lib/server/site-settings';

const admin = { id: 'u_admin', name: 'Ryan', role: 'ADMIN' } as User;
const sales = { id: 'u_sales', name: 'S', role: 'SALES' } as User;
const editor = { id: 'u_ed', name: 'E', role: 'EDITOR' } as User;
const NOW = new Date('2026-10-17T23:30:00-07:00');

// ---------- 测试图片 ----------
const solid = (width: number, height: number, fmt: 'jpeg' | 'png' | 'webp' = 'jpeg') =>
  sharp({ create: { width, height, channels: 3, background: '#cc3322' } })[fmt]().toBuffer();
/** 左半红、右半蓝，带 EXIF Orientation=6（显示时顺时针转 90°）和 GPS */
async function orientedWithGps(width: number, height: number) {
  const half = Math.floor(width / 2);
  const red = await sharp({ create: { width: half, height, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const blue = await sharp({ create: { width: width - half, height, channels: 3, background: '#0000ff' } }).png().toBuffer();
  return sharp({ create: { width, height, channels: 3, background: '#000' } })
    .composite([{ input: red, left: 0, top: 0 }, { input: blue, left: half, top: 0 }])
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: 'TestCam', Model: 'X' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 46/1 30/1', GPSLongitudeRef: 'W', GPSLongitude: '122/1 25/1 10/1' } })
    .jpeg().toBuffer();
}
const hasGpsIfd = (exif?: Buffer) => !!exif && (exif.includes(Buffer.from([0x25, 0x88])) || exif.includes(Buffer.from([0x88, 0x25])));
/** 手工拼一个只有文件头的 PNG：声明 w×h，几乎没有数据（解压炸弹的文件头） */
function pngHeaderOnly(w: number, h: number) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])), chunk('IEND', Buffer.alloc(0))]);
}
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000"><script>alert(1)</script></svg>');
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64)]);

// ---------- 请求 ----------
function uploadReq(file: Buffer, opts: { name?: string; type?: string; origin?: string } = {}) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)], { type: opts.type ?? 'image/jpeg' }), opts.name ?? 'photo.jpg');
  return new Request('http://localhost/api/admin/site-settings/assets', { method: 'POST', headers: { origin: opts.origin ?? 'http://localhost' }, body: form });
}

// ---------- 内存依赖 ----------
function memRepo() {
  const rows = new Map<string, PublicAssetRow>();
  const repo: PublicAssetRepo = {
    async findLiveBySha(kind, sha) { return [...rows.values()].find((r) => r.kind === kind && r.sha256 === sha && !r.deletedAt) ?? null; },
    async findLive(ids) { return ids.map((i) => rows.get(i)).filter((r): r is PublicAssetRow => !!r && !r.deletedAt); },
    async listLive(kind) { return [...rows.values()].filter((r) => r.kind === kind && !r.deletedAt); },
    async create(row) { const r = { ...row, createdAt: NOW, deletedAt: null, deletedBy: null }; rows.set(row.id, r); return r; },
    async markDeleted(id, by, at) { const r = rows.get(id); if (!r || r.deletedAt) return null; r.deletedAt = at; r.deletedBy = by; return r; },
  };
  return { rows, repo };
}

let idSeq = 0;
async function assetDeps(over: Partial<PublicAssetDeps> & { user?: User | null; originOk?: boolean; limited?: boolean; userLimited?: boolean; settings?: Record<string, unknown> } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-'));
  const local = new LocalStorage(dir);
  const calls = { order: [] as string[], audit: [] as Parameters<PublicAssetDeps['audit']>[0][], puts: [] as { key: string; type?: string; data: Buffer }[], deletes: [] as string[], revalidate: 0 };
  const mem = memRepo();
  const user = over.user === undefined ? admin : over.user;
  const settings: Record<string, unknown> = over.settings ?? {};
  const d: PublicAssetDeps = {
    async requireAdmin(_req, roles: Role[]) {
      calls.order.push('auth');
      if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      if (!roles.includes(user.role)) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
      return { user, ip: '203.0.113.9' };
    },
    assertSameOrigin() { calls.order.push('origin'); return over.originOk === false ? new Response(JSON.stringify({ error: 'forbidden_origin' }), { status: 403 }) : null; },
    async enforceAdminRateLimit() { calls.order.push('rate'); return over.limited ? new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }) : null; },
    async enforceAdminUserRateLimit() { calls.order.push('user_rate'); return over.userLimited ? new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }) : null; },
    storage: {
      async put(key, data, type) { calls.puts.push({ key, type, data }); await local.put(key, data); },
      async delete(key) { calls.deletes.push(key); await local.delete(key); },
    },
    repo: mem.repo,
    settings: { async readMany(keys) { return Object.fromEntries(keys.filter((k) => k in settings).map((k) => [k, structuredClone(settings[k])])); } },
    async audit(e) { calls.audit.push(e); },
    revalidate() { calls.revalidate++; },
    newId: () => `Asset${String(++idSeq).padStart(19, '0')}`,
    now: () => NOW,
    ...over,
  };
  return { d, calls, mem, local, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const body = async (r: Response) => ({ status: r.status, json: await r.json(), cache: r.headers.get('cache-control') });

// ================= 图片处理 =================
test('判型只看 magic bytes：SVG / GIF / HEIC / 随机字节 → unsupported_type；JPEG / PNG / WebP 通过', async () => {
  for (const b of [SVG, GIF, HEIC, Buffer.from('hello world, not an image at all'), Buffer.alloc(0)]) {
    assert.deepEqual(await processPublicImage(b), { ok: false, error: 'unsupported_type' });
  }
  for (const fmt of ['jpeg', 'png', 'webp'] as const) {
    const r = await processPublicImage(await solid(1600, 1200, fmt));
    assert.equal(r.ok, true, fmt);
  }
  // 文件头是 JPEG、内容是坏的 → processing_failed（不回显 sharp 的报错）
  assert.deepEqual(await processPublicImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])), { ok: false, error: 'processing_failed' });
  // 文件头是 PNG、后面却是 JPEG 数据（格式和 magic bytes 不一致）→ 拒绝
  const jpg = await solid(1600, 1200);
  const mixed = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), jpg]);
  assert.equal((await processPublicImage(mixed)).ok, false);
});

test('按长边出两种尺寸：横图 sm 长边 800 / lg 长边 1600；竖图同样按长边（高度）；输出都是 WebP', async () => {
  const land = await processPublicImage(await solid(4000, 2000));
  assert.ok(land.ok);
  assert.deepEqual([land.sm.width, land.sm.height, land.lg.width, land.lg.height], [800, 400, 1600, 800]);
  assert.deepEqual(land.warnings, []);
  const port = await processPublicImage(await solid(1200, 3000));
  assert.ok(port.ok);
  assert.deepEqual([port.lg.width, port.lg.height], [640, 1600]);
  assert.deepEqual([port.sm.width, port.sm.height], [320, 800]);
  for (const r of [land.sm, land.lg, port.sm, port.lg]) assert.equal((await sharp(r.data).metadata()).format, 'webp');
});

test('不放大：长边 800–1599 → lg 原尺寸 + warnings image_small；长边正好 800 → sm、lg 同一份；长边 < 800 → image_too_small', async () => {
  const mid = await processPublicImage(await solid(1200, 900));
  assert.ok(mid.ok);
  assert.deepEqual([mid.lg.width, mid.lg.height, mid.sm.width, mid.sm.height], [1200, 900, 800, 600]);
  assert.deepEqual(mid.warnings, ['image_small']);
  const edge = await processPublicImage(await solid(600, 800, 'png'));
  assert.ok(edge.ok);
  assert.equal(edge.same, true);
  assert.deepEqual([edge.lg.width, edge.lg.height], [600, 800]);
  assert.equal(edge.sm, edge.lg);
  assert.deepEqual(edge.warnings, ['image_small']);
  assert.deepEqual(await processPublicImage(await solid(799, 500)), { ok: false, error: 'image_too_small' });
  assert.deepEqual(await processPublicImage(await solid(300, 799, 'webp')), { ok: false, error: 'image_too_small' });
  const big = await processPublicImage(await solid(1600, 1000));
  assert.ok(big.ok);
  assert.deepEqual(big.warnings, []);
});

test('EXIF 方向先转正（Orientation=6 的 2000×1000 → 竖图 800×1600），输出没有任何元数据（GPS / EXIF / XMP / ICC 都没有）', async () => {
  const input = await orientedWithGps(2000, 1000);
  const inMeta = await sharp(input).metadata();
  assert.equal(inMeta.orientation, 6);
  assert.ok(hasGpsIfd(inMeta.exif), '输入确实带 GPS');
  assert.ok(inMeta.exif!.includes(Buffer.from('TestCam')));
  const r = await processPublicImage(input);
  assert.ok(r.ok);
  assert.deepEqual([r.lg.width, r.lg.height, r.sm.width, r.sm.height], [800, 1600, 400, 800]);
  for (const out of [r.sm, r.lg]) {
    const m = await sharp(out.data).metadata();
    assert.equal(m.exif, undefined); assert.equal(m.xmp, undefined); assert.equal(m.icc, undefined); assert.equal(m.orientation, undefined);
    assert.ok(!out.data.includes(Buffer.from('TestCam')) && !out.data.includes(Buffer.from('Exif')));
  }
  // 像素真的转过来了：原图左半红 → 顺时针 90° 后在上半部
  const { data, info } = await sharp(r.sm.data).raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  const top = px(200, 50); const bottom = px(200, 750);
  assert.ok(top[0] > 200 && top[2] < 60, `top=${top}`);
  assert.ok(bottom[2] > 200 && bottom[0] < 60, `bottom=${bottom}`);
});

test('解压炸弹：像素数超过 60,000,000 → image_too_large_dimensions（只读文件头就拒绝）', async () => {
  assert.equal(PUBLIC_ASSET_MAX_PIXELS, 60_000_000);
  for (const [w, h] of [[50_000, 50_000], [8000, 7501], [60_001, 1000]]) {
    assert.deepEqual(await processPublicImage(pngHeaderOnly(w, h)), { ok: false, error: 'image_too_large_dimensions' }, `${w}x${h}`);
  }
  // 正好 6000 万、以及 5000 万（手机实拍）不算超限：只有文件头没有像素数据，解码失败 → processing_failed，而不是 image_too_large_dimensions
  for (const [w, h] of [[10_000, 6000], [8165, 6124]]) {
    assert.deepEqual(await processPublicImage(pngHeaderOnly(w, h)), { ok: false, error: 'processing_failed' }, `${w}x${h}`);
  }
});

test('不设 sharp.concurrency：只靠队列串行，不改进程级线程池', () => {
  assert.doesNotMatch(readFileSync('src/lib/server/public-assets.ts', 'utf8'), /^\s*sharp\.concurrency\(/m);
});

test('队列：两个任务同时进来，第二个要等第一个处理完才开始；第一个失败也不卡住第二个', async () => {
  for (const fail of [false, true]) {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = serialize(async () => { log.push('1 start'); await gate; log.push('1 end'); if (fail) throw new Error('x'); return 1; });
    const second = serialize(async () => { log.push('2 start'); return 2; });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(log, ['1 start'], '第一个没结束前第二个不能开始');
    release();
    if (fail) await assert.rejects(first); else assert.equal(await first, 1);
    assert.equal(await second, 2);
    assert.deepEqual(log, ['1 start', '1 end', '2 start']);
  }
});

test('同一时间只处理一张：并发调用 processPublicImage 按顺序串行执行', async () => {
  const imgs = await Promise.all([solid(1700, 1000), solid(1800, 1000), solid(1900, 1000)]);
  const done: number[] = [];
  await Promise.all(imgs.map((b, i) => processPublicImage(b).then((r) => { assert.equal(r.ok, true); done.push(i); })));
  assert.deepEqual(done, [0, 1, 2]);
});

test('10 MB：超过上限的字节直接 file_too_large', async () => {
  assert.equal(PUBLIC_ASSET_MAX_BYTES, 10 * 1024 * 1024);
  const big = Buffer.alloc(PUBLIC_ASSET_MAX_BYTES + 1); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  assert.deepEqual(await processPublicImage(big), { ok: false, error: 'file_too_large' });
});

// ================= 读请求体 =================
/** 无限流：每次 pull 给 1 MB，记录被读了多少 */
function endless(chunk = 1024 * 1024) {
  const stat = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { stat.pulled += chunk; c.enqueue(new Uint8Array(chunk)); },
    cancel() { stat.cancelled = true; },
  });
  return { stream, stat };
}
const streamReq = (stream: ReadableStream<Uint8Array>, headers: Record<string, string>) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x', ...headers }, body: stream, duplex: 'half' } as RequestInit);

test('请求体超过上限：Content-Length 超限不读；没有 Content-Length 时读到上限就 cancel，不会整个读进内存', async () => {
  const a = endless();
  const r1 = await readUploadFile(streamReq(a.stream, { 'content-length': String(PUBLIC_ASSET_MAX_REQUEST_BYTES + 1) }));
  assert.deepEqual(r1, { ok: false, error: 'file_too_large', status: 413 });
  assert.ok(a.stat.pulled <= 2 * 1024 * 1024, `pulled ${a.stat.pulled}`);
  const b = endless();
  const r2 = await readUploadFile(streamReq(b.stream, {}));
  assert.deepEqual(r2, { ok: false, error: 'file_too_large', status: 413 });
  assert.ok(b.stat.cancelled);
  assert.ok(b.stat.pulled <= PUBLIC_ASSET_MAX_REQUEST_BYTES + 3 * 1024 * 1024, `pulled ${b.stat.pulled}`);
  // 谎报 Content-Length（比实际小）同样按实际读到的字节计数
  const c = endless();
  assert.deepEqual(await readUploadFile(streamReq(c.stream, { 'content-length': '100' })), { ok: false, error: 'file_too_large', status: 413 });
  assert.ok(c.stat.cancelled);
});

test('文件本身 > 10 MB（请求体在余量内）→ 413；不是 multipart / 没有 file 字段 → 400', async () => {
  const f = Buffer.alloc(PUBLIC_ASSET_MAX_BYTES + 10);
  assert.deepEqual(await readUploadFile(uploadReq(f)), { ok: false, error: 'file_too_large', status: 413 });
  assert.deepEqual(await readUploadFile(new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })), { ok: false, error: 'invalid', status: 400 });
  const form = new FormData(); form.append('other', 'x');
  assert.deepEqual(await readUploadFile(new Request('http://x/', { method: 'POST', body: form })), { ok: false, error: 'missing_file', status: 400 });
});

// ================= 上传接口 =================
test('上传鉴权：未登录 401、SALES / EDITOR 403，鉴权在所有检查之前，不读请求体、不写存储', async () => {
  for (const [user, status] of [[null, 401], [sales, 403], [editor, 403]] as const) {
    const t = await assetDeps({ user });
    const file = await solid(1600, 1200);
    assert.equal((await handleUploadAsset(uploadReq(file), t.d)).status, status);
    assert.equal((await handleListAssets(new Request('http://localhost/x'), t.d)).status, status);
    assert.equal((await handleDeleteAsset(new Request('http://localhost/x', { method: 'DELETE' }), 'A'.repeat(24), t.d)).status, status);
    assert.deepEqual([...new Set(t.calls.order)], ['auth']);
    assert.equal(t.calls.puts.length, 0);
    await t.cleanup();
  }
});

test('上传：同源失败 403、限流 429 → 不处理、不写存储', async () => {
  for (const over of [{ originOk: false }, { limited: true }, { userLimited: true }]) {
    const t = await assetDeps(over);
    const r = await handleUploadAsset(uploadReq(await solid(1600, 1200)), t.d);
    assert.equal(r.status, over.originOk === false ? 403 : 429);
    assert.equal(t.calls.puts.length, 0);
    await t.cleanup();
  }
});

test('上传按管理员限流（真实限流器 + 内存存储）：同一管理员 1 分钟内第 21 次 → 429 rate_limited + Retry-After: 60；另一个管理员（同一 IP）不受影响；不读请求体', async () => {
  setRateLimitStore(new MemoryStore());
  try {
    let current: User = admin;
    const admin2 = { id: 'u_admin2', name: 'A2', role: 'ADMIN' } as User;
    const t = await assetDeps({ enforceAdminRateLimit, enforceAdminUserRateLimit });
    t.d.requireAdmin = async () => ({ user: current, ip: null });
    // 请求体不是 multipart（400 invalid）：只看限流计数，不跑图片处理
    const req = () => new Request('http://localhost/api/admin/site-settings/assets', {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(ASSET_UPLOAD_RATE, 20);
    for (let i = 1; i <= ASSET_UPLOAD_RATE; i++) assert.equal((await handleUploadAsset(req(), t.d)).status, 400, `#${i}`);
    const q = req();
    const r = await handleUploadAsset(q, t.d);
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { error: 'rate_limited' });
    assert.equal(r.headers.get('retry-after'), '60');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(q.bodyUsed, false, '429 时不读请求体');
    current = admin2;
    for (let i = 1; i <= ASSET_UPLOAD_RATE; i++) assert.equal((await handleUploadAsset(req(), t.d)).status, 400, `admin2 #${i}`);
    assert.equal((await handleUploadAsset(req(), t.d)).status, 429);
    current = admin;
    assert.equal((await handleUploadAsset(req(), t.d)).status, 429);
    // 列表不受上传限流影响
    assert.equal((await handleListAssets(new Request('http://localhost/x'), t.d)).status, 200);
    await t.cleanup();
  } finally { setRateLimitStore(undefined); }
});

test('按管理员限流的 key 只用 user id，和按 IP 的 key 分开；共享 deps 用真实 enforceAdminUserRateLimit；存储故障 → 429', async () => {
  const src = readFileSync('src/lib/server/admin-guard.ts', 'utf8');
  assert.match(src, /hitRateLimit\(`admin:\$\{key\}:user:\$\{userId\}`, limit, 60_000, \{ onStoreError: 'closed' \}\)/);
  assert.match(readFileSync('src/lib/server/public-assets-admin.ts', 'utf8'), /enforceAdminUserRateLimit\(ctx\.user\.id, 'site_assets\.upload', ASSET_UPLOAD_RATE\)/);
  assert.match(readFileSync('src/lib/server/public-assets-deps.ts', 'utf8'), /^  enforceAdminUserRateLimit,$/m);
  setRateLimitStore({ hit: async () => { throw new Error('upstash 503'); } });
  const err = console.error; console.error = () => {};
  try { assert.equal((await enforceAdminUserRateLimit('u_x', 'site_assets.upload', 20))?.status, 429); }
  finally { console.error = err; setRateLimitStore(undefined); }
});

test('上传成功：201，返回 id、两种尺寸宽高和 URL；存储只有 WebP（原图不落盘），key 只含服务端 id；审计 site.asset.upload', async () => {
  const t = await assetDeps();
  const file = await orientedWithGps(3000, 2000);
  const r = await body(await handleUploadAsset(uploadReq(file, { name: '../../etc/passwd<script>.jpg', type: 'image/svg+xml' }), t.d));
  assert.equal(r.status, 201);
  assert.equal(r.cache, 'no-store');
  const a = r.json;
  assert.match(a.id, /^[A-Za-z0-9]{24}$/);
  assert.deepEqual([a.width, a.height], [1067, 1600]);
  assert.deepEqual([a.lg.width, a.lg.height, a.sm.width, a.sm.height], [1067, 1600, 533, 800]);
  assert.equal(a.lg.url, `/media/${a.id}-1600.webp`); assert.equal(a.sm.url, `/media/${a.id}-800.webp`); // URL 里是名义长边，实际宽高看 width / height
  assert.deepEqual(a.warnings, []); assert.equal(a.deduplicated, false);
  assert.equal(t.calls.puts.length, 2);
  for (const p of t.calls.puts) {
    assert.match(p.key, /^public-assets\/2026-10\/[A-Za-z0-9]{24}-(sm|lg)\.webp$/);
    assert.ok(!/passwd|script|etc|jpg/.test(p.key));
    assert.equal(p.type, 'image/webp');
    assert.equal((await sharp(p.data).metadata()).format, 'webp');
    assert.ok(!p.data.equals(file));
  }
  // 磁盘上只有两份 WebP
  const files = (await readdir(path.join(t.dir, 'public-assets', '2026-10'))).sort();
  assert.deepEqual(files, [`${a.id}-lg.webp`, `${a.id}-sm.webp`]);
  const row = t.mem.rows.get(a.id)!;
  assert.equal(row.createdBy, admin.id); assert.equal(row.bytes, file.length); assert.match(row.sha256, /^[0-9a-f]{64}$/);
  assert.equal(t.calls.audit.length, 1);
  assert.equal(t.calls.audit[0].action, AUDIT_ASSET_UPLOAD); assert.equal(t.calls.audit[0].target, a.id);
  assert.ok(!JSON.stringify(t.calls.audit[0].meta).includes('passwd'));
  // 同一张图再传：复用已有记录（200 deduplicated），不再写文件
  const again = await body(await handleUploadAsset(uploadReq(file), t.d));
  assert.equal(again.status, 200); assert.equal(again.json.id, a.id); assert.equal(again.json.deduplicated, true);
  assert.equal(t.calls.puts.length, 2);
  await t.cleanup();
});

test('上传：声明的 Content-Type / 文件名不算数——PNG 内容冒充 .svg 照样按 PNG 处理；SVG 冒充 image/png → 415', async () => {
  const t = await assetDeps();
  const ok = await handleUploadAsset(uploadReq(await solid(1700, 900, 'png'), { name: 'x.svg', type: 'image/svg+xml' }), t.d);
  assert.equal(ok.status, 201);
  for (const [buf, name, type] of [[SVG, 'x.png', 'image/png'], [GIF, 'x.jpg', 'image/jpeg'], [HEIC, 'x.webp', 'image/webp']] as const) {
    const r = await body(await handleUploadAsset(uploadReq(buf, { name, type }), t.d));
    assert.deepEqual([r.status, r.json], [415, { error: 'unsupported_type' }], name);
  }
  await t.cleanup();
});

test('上传错误码：image_too_small 422、image_too_large_dimensions 422、processing_failed 422、file_too_large 413；warnings image_small', async () => {
  const t = await assetDeps();
  const small = await body(await handleUploadAsset(uploadReq(await solid(700, 500)), t.d));
  assert.deepEqual([small.status, small.json], [422, { error: 'image_too_small' }]);
  const bomb = await body(await handleUploadAsset(uploadReq(pngHeaderOnly(20_000, 20_000), { type: 'image/png' }), t.d));
  assert.deepEqual([bomb.status, bomb.json], [422, { error: 'image_too_large_dimensions' }]);
  const huge = Buffer.alloc(PUBLIC_ASSET_MAX_BYTES + 1); huge.set([0xff, 0xd8, 0xff]);
  const big = await body(await handleUploadAsset(uploadReq(huge), t.d));
  assert.deepEqual([big.status, big.json], [413, { error: 'file_too_large' }]);
  const mid = await body(await handleUploadAsset(uploadReq(await solid(1000, 1200)), t.d));
  assert.equal(mid.status, 201); assert.deepEqual(mid.json.warnings, ['image_small']);
  assert.deepEqual([mid.json.lg.width, mid.json.lg.height, mid.json.sm.width, mid.json.sm.height], [1000, 1200, 667, 800]);
  // 长边正好 800：只存一份文件，sm / lg 同一个 URL
  const one = await body(await handleUploadAsset(uploadReq(await solid(800, 600)), t.d));
  assert.equal(one.status, 201); assert.equal(one.json.sm.url, one.json.lg.url); assert.equal(one.json.lg.url, `/media/${one.json.id}-1600.webp`);
  assert.equal(t.calls.puts.filter((p) => p.key.includes(one.json.id)).length, 1);
  await t.cleanup();
});

test('存储或写库失败：已写的文件被删掉，异常继续抛出（路由层返回 500）', async () => {
  const t = await assetDeps();
  t.d.repo.create = async () => { throw new Error('db down'); };
  await assert.rejects(handleUploadAsset(uploadReq(await solid(1600, 1200)), t.d), /db down/);
  assert.equal(t.calls.puts.length, 2);
  assert.deepEqual(t.calls.deletes.sort(), t.calls.puts.map((p) => p.key).sort());
  await t.cleanup();
});

// ================= 列表 / 删除 =================
test('删除：被 about.images 引用 → 409 asset_in_use；未引用 → 软删除 + 删文件 + 审计 + 刷新缓存；再删 / 格式不对 → 404', async () => {
  const t = await assetDeps();
  const a = (await body(await handleUploadAsset(uploadReq(await solid(2000, 1500)), t.d))).json;
  const b = (await body(await handleUploadAsset(uploadReq(await solid(2000, 1400)), t.d))).json;
  const settings = { 'about.images': { version: 1, items: [{ id: a.id, sm: { w: 800, h: 600 }, lg: { w: 1600, h: 1200 } }] } };
  t.d.settings = { async readMany(keys) { return Object.fromEntries(keys.filter((k) => k in settings).map((k) => [k, (settings as Record<string, unknown>)[k]])); } };
  const list = await body(await handleListAssets(new Request('http://localhost/x'), t.d));
  assert.deepEqual(list.json.assets.map((x: { id: string; inUse: boolean }) => [x.id, x.inUse]).sort(), [[a.id, true], [b.id, false]].sort());
  const del = (id: string) => handleDeleteAsset(new Request('http://localhost/x', { method: 'DELETE', headers: { origin: 'http://localhost' } }), id, t.d);
  const inUse = await body(await del(a.id));
  assert.deepEqual([inUse.status, inUse.json.error], [409, 'asset_in_use']);
  assert.equal(t.mem.rows.get(a.id)!.deletedAt, null);
  t.calls.audit.length = 0;
  const ok = await body(await del(b.id));
  assert.deepEqual([ok.status, ok.json], [200, { id: b.id, deleted: true }]);
  assert.ok(t.mem.rows.get(b.id)!.deletedAt);
  assert.equal(t.mem.rows.get(b.id)!.deletedBy, admin.id);
  assert.deepEqual(t.calls.deletes.sort(), [t.mem.rows.get(b.id)!.smKey, t.mem.rows.get(b.id)!.lgKey].sort());
  assert.deepEqual(t.calls.audit.map((e) => [e.action, e.target]), [[AUDIT_ASSET_DELETE, b.id]]);
  assert.equal(t.calls.revalidate, 1);
  assert.equal((await del(b.id)).status, 404);
  assert.equal((await del('../../x')).status, 404);
  await t.cleanup();
});

// ================= about 引用 =================
function memStore(init: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(init);
  const store: SiteSettingsStore = {
    async readMany(keys) { return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])); },
    async compareAndSet(key, expected, build): Promise<CasResult> {
      const cur = key in data ? structuredClone(data[key]) : null;
      const v = storedVersion(cur);
      if (expected !== null && v !== expected) return { status: 'conflict', currentVersion: v };
      const next = build(cur);
      if (next === null) return { status: 'ok', value: cur, changed: false };
      data[key] = structuredClone(next);
      return { status: 'ok', value: next, changed: true };
    },
  };
  return { data, store };
}
const LIVE = 'LiveAsset000000000000001';
const LIVE2 = 'LiveAsset000000000000002';
const DELETED = 'DeletedAsset000000000001';
function siteDeps(user: User | null = admin) {
  const mem = memStore();
  const calls = { audit: [] as unknown[], revalidate: 0 };
  const live = new Map([[LIVE, { id: LIVE, smWidth: 800, smHeight: 600, lgWidth: 1600, lgHeight: 1200 }], [LIVE2, { id: LIVE2, smWidth: 600, smHeight: 800, lgWidth: 1200, lgHeight: 1600 }]]);
  const d: SiteSettingsDeps = {
    async requireAdmin(_req, roles) {
      if (!user) return new Response('{"error":"unauthorized"}', { status: 401 });
      if (!roles.includes(user.role)) return new Response('{"error":"forbidden"}', { status: 403 });
      return { user, ip: null };
    },
    assertSameOrigin: () => null,
    enforceAdminRateLimit: async () => null,
    async readJson(req) { try { return JSON.parse(await req.text()); } catch { return null; } },
    store: mem.store,
    async audit(e) { calls.audit.push(e); },
    revalidate() { calls.revalidate++; },
    async userNames() { return {}; },
    async liveAssets(ids) { return ids.flatMap((i) => (live.has(i) ? [live.get(i)!] : [])); },
    now: () => NOW,
  };
  return { d, mem, calls };
}
const putJson = (url: string, b: unknown) => new Request(`http://localhost${url}`, { method: 'PUT', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(b) });
const BODY = '<h2>About</h2><p>We run our own factory and do quality control in house for every order.</p>';

test('about/images：未知或已删除的 id → 400 unknown_asset（列出 ids），不写库；重复 / 超过 6 张 / 格式不对 → 400 invalid；非 ADMIN 403', async () => {
  const { d, mem } = siteDeps();
  for (const ids of [[DELETED], [LIVE, 'Unknown00000000000000000']]) {
    const r = await body(await handlePutAboutImages(putJson('/api/admin/site-settings/about/images', { expectedVersion: 0, ids }), d));
    assert.equal(r.status, 400); assert.equal(r.json.error, 'unknown_asset'); assert.deepEqual(r.json.ids, ids.filter((i) => i !== LIVE));
  }
  for (const ids of [[LIVE, LIVE], Array.from({ length: 7 }, (_, i) => `LiveAsset00000000000000${i}`.slice(0, 24).padEnd(24, '0')), ['../x']]) {
    const r = await body(await handlePutAboutImages(putJson('/x', { expectedVersion: 0, ids }), d));
    assert.deepEqual([r.status, r.json.error], [400, 'invalid']);
  }
  assert.deepEqual(mem.data, {});
  for (const u of [sales, editor]) assert.equal((await handlePutAboutImages(putJson('/x', { expectedVersion: 0, ids: [LIVE] }), siteDeps(u).d)).status, 403);
});

test('about/images：合法 id 按顺序保存宽高快照和 URL，带 version；旧 version → 409；about/[locale] 的 imageMeta 含未知 / 已删除 id → 400 unknown_asset', async () => {
  const { d, mem, calls } = siteDeps();
  const r = await body(await handlePutAboutImages(putJson('/x', { expectedVersion: 0, ids: [LIVE2, LIVE] }), d));
  assert.equal(r.status, 200); assert.equal(r.json.changed, true);
  assert.deepEqual(r.json.images.items.map((i: { id: string }) => i.id), [LIVE2, LIVE]);
  assert.deepEqual(r.json.images.items[0], { id: LIVE2, sm: { w: 600, h: 800 }, lg: { w: 1200, h: 1600 }, src: { sm: `/media/${LIVE2}-800.webp`, lg: `/media/${LIVE2}-1600.webp` } });
  assert.equal((mem.data['about.images'] as { version: number }).version, 1);
  assert.equal(calls.revalidate, 1);
  assert.equal((await handlePutAboutImages(putJson('/x', { expectedVersion: 0, ids: [LIVE] }), d)).status, 409);
  const loc = (imageMeta: Record<string, unknown>) => handlePutAboutLocale(putJson('/api/admin/site-settings/about/en', { expectedVersion: 0, title: 'About PackJoyU', bodyHtml: BODY, imageMeta }), 'en', d);
  const bad = await body(await loc({ [LIVE]: { alt: 'Line', caption: '' }, [DELETED]: { alt: 'x', caption: '' } }));
  assert.deepEqual([bad.status, bad.json], [400, { error: 'unknown_asset', ids: [DELETED] }]);
  assert.equal(mem.data['about.en'], undefined);
  assert.equal((await loc({ [LIVE]: { alt: 'Printing line', caption: 'Shop floor' } })).status, 200);
  // 后台 GET 带 images
  const g = await body(await handleGetAbout(new Request('http://localhost/x'), d));
  assert.deepEqual(g.json.images.items.map((i: { id: string }) => i.id), [LIVE2, LIVE]);
});

test('前台读取：images = about.images 顺序 + 该语言 alt / 说明；有图缺 alt → 该语言不发布', async () => {
  const about = (imageMeta: Record<string, unknown>) => ({ version: 1, title: 'About us', summary: '', bodyHtml: BODY, stats: [], home: { title: '', intro: '' }, imageMeta, updatedAt: 't', updatedBy: null });
  const images = { version: 1, items: [{ id: LIVE2, sm: { w: 600, h: 800 }, lg: { w: 1200, h: 1600 } }, { id: LIVE, sm: { w: 800, h: 600 }, lg: { w: 1600, h: 1200 } }] };
  const reader = createSiteSettingsReader(async () => ({
    'about.enabled': true, 'about.images': images,
    'about.en': about({ [LIVE]: { alt: 'Line', caption: 'Cap' }, [LIVE2]: { alt: 'Press', caption: '' } }),
    'about.ru': about({ [LIVE]: { alt: 'Линия', caption: '' } }), // LIVE2 缺 alt
  }));
  const en = await reader.getAboutContent('en');
  assert.deepEqual(en!.images, [
    { id: LIVE2, w: 1200, h: 1600, alt: 'Press', caption: '', sm: { w: 600, h: 800 }, lg: { w: 1200, h: 1600 }, src: { sm: `/media/${LIVE2}-800.webp`, lg: `/media/${LIVE2}-1600.webp` } },
    { id: LIVE, w: 1600, h: 1200, alt: 'Line', caption: 'Cap', sm: { w: 800, h: 600 }, lg: { w: 1600, h: 1200 }, src: { sm: publicAssetUrl(LIVE, 'sm'), lg: publicAssetUrl(LIVE, 'lg') } },
  ]);
  assert.equal(await reader.getAboutContent('ru'), null);
  assert.deepEqual(await reader.getPublishedAboutLocales(), ['en']);
});

test('前台读取：长边 ≤ 800（sm、lg 同一个文件、宽高相同）→ src.sm 和 src.lg 都是 -1600 地址，sm / lg 宽高照实给', async () => {
  const reader = createSiteSettingsReader(async () => ({
    'about.enabled': true, 'about.images': { version: 1, items: [{ id: LIVE, sm: { w: 800, h: 600 }, lg: { w: 800, h: 600 } }] },
    'about.en': { version: 1, title: 'About us', summary: '', bodyHtml: BODY, stats: [], home: { title: '', intro: '' }, imageMeta: { [LIVE]: { alt: 'Line', caption: '' } }, updatedAt: 't', updatedBy: null },
  }));
  const [img] = (await reader.getAboutContent('en'))!.images;
  assert.deepEqual(img, { id: LIVE, w: 800, h: 600, alt: 'Line', caption: '', sm: { w: 800, h: 600 }, lg: { w: 800, h: 600 }, src: { sm: `/media/${LIVE}-1600.webp`, lg: `/media/${LIVE}-1600.webp` } });
});

// ================= 公开路由 =================
test('/media/<id>-<w>.webp：WebP + immutable 长缓存 + nosniff + CSP，没有 Set-Cookie；宽度不对 / 已删除 / 文件名不合法 → 404 no-store', async () => {
  const t = await assetDeps();
  const a = (await body(await handleUploadAsset(uploadReq(await solid(2400, 1800)), t.d))).json;
  const md = { findLive: async (id: string) => { const r = t.mem.rows.get(id); return r && !r.deletedAt ? r : null; }, storage: t.local };
  for (const w of [1600, 800]) {
    const r = await handleMedia(`${a.id}-${w}.webp`, md);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/webp');
    assert.equal(r.headers.get('cache-control'), MEDIA_CACHE_CONTROL);
    assert.equal(MEDIA_CACHE_CONTROL, 'public, max-age=31536000, immutable');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('content-security-policy'), FILE_CSP);
    assert.equal(r.headers.get('set-cookie'), null);
    assert.match(r.headers.get('content-disposition')!, new RegExp(`^inline; filename="${a.id}-${w}\\.webp"$`));
    const m = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
    assert.equal(m.width, w);
  }
  for (const f of [`${a.id}-1200.webp`, `${a.id}-1600.png`, `${a.id}.webp`, '../../etc/passwd', `${a.id}-01600.webp`, 'x'.repeat(24) + '-800.webp']) {
    const r = await handleMedia(f, md);
    assert.equal(r.status, 404, f); assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  t.mem.rows.get(a.id)!.deletedAt = NOW;
  assert.equal((await handleMedia(`${a.id}-1600.webp`, md)).status, 404);
  await t.cleanup();
});

test('/media 文件名白名单：w 只能是 800 / 1600（名义长边，竖图也一样），id 必须是生成格式；路径穿越、编码、多余后缀一律 404 且不查库、不读存储', async () => {
  assert.equal(String(MEDIA_FILE_RE), String(/^([A-Za-z0-9]{24})-(800|1600)\.webp$/));
  assert.deepEqual(Object.values(PUBLIC_ASSET_SIZES), [800, 1600]);
  const t = await assetDeps();
  // 竖图：lg 实际 1200×1600、sm 600×800，URL 仍是 -1600 / -800
  const a = (await body(await handleUploadAsset(uploadReq(await solid(1500, 2000)), t.d))).json;
  assert.deepEqual([a.lg.url, a.lg.width, a.lg.height, a.sm.url, a.sm.width, a.sm.height], [`/media/${a.id}-1600.webp`, 1200, 1600, `/media/${a.id}-800.webp`, 600, 800]);
  const seen = { find: [] as string[], get: [] as string[] };
  const md = {
    findLive: async (id: string) => { seen.find.push(id); const r = t.mem.rows.get(id); return r && !r.deletedAt ? r : null; },
    storage: { get: async (k: string) => { seen.get.push(k); return t.local.get(k); } },
  };
  for (const [w, size] of [[1600, [1200, 1600]], [800, [600, 800]]] as const) {
    const r = await handleMedia(`${a.id}-${w}.webp`, md);
    assert.equal(r.status, 200);
    const m = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
    assert.deepEqual([m.width, m.height], size);
  }
  assert.deepEqual(seen.get, [t.mem.rows.get(a.id)!.lgKey, t.mem.rows.get(a.id)!.smKey]);
  seen.find.length = 0; seen.get.length = 0;
  const id = a.id as string;
  const bad = [
    `../${id}-1600.webp`, `..%2F${id}-1600.webp`, `%2e%2e/${id}-1600.webp`, `%2e%2e%2f${id}-1600.webp`, `..\\${id}-1600.webp`,
    `${id}-1600.webp/../x`, `${id}%2F..%2F-1600.webp`, `${id}/-1600.webp`, `public-assets/2026-10/${id}-lg.webp`, `${id}-lg.webp`, `${id}-sm.webp`,
    `${id}-801.webp`, `${id}-0800.webp`, `${id}-08000.webp`, `${id}-1600.0.webp`, `${id}-1200.webp`, `${id}-600.webp`, `${id}-0.webp`, `${id}--800.webp`, `${id}-+800.webp`,
    `${id}-1600.webp.png`, `${id}-1600.webpx`, `${id}-1600.webp?x=1`, `${id}-1600.webp%00`, `${id}-1600.webp\n`, `${id}-1600.WEBP`, ` ${id}-1600.webp`, `${id}-1600.webp `,
    `${id}x-1600.webp`, `${id.slice(1)}-1600.webp`, `${id.slice(0, 23)}_-1600.webp`, `${id.slice(0, 23)}.-1600.webp`, '', '.', '..', `${'A'.repeat(24)}-1600.webp`.repeat(3),
  ];
  for (const f of bad) {
    const r = await handleMedia(f, md);
    assert.equal(r.status, 404, JSON.stringify(f)); assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(parseMediaFile(f), null, JSON.stringify(f));
  }
  // 格式正确但不存在的 id 会查库（返回 404），格式不对的一个都没查过库、读过存储
  assert.deepEqual(seen.find, [], 'invalid names must not reach findLive');
  assert.deepEqual(seen.get, []);
  assert.deepEqual(parseMediaFile(`${id}-800.webp`), { id, size: 'sm' });
  assert.deepEqual(parseMediaFile(`${id}-1600.webp`), { id, size: 'lg' });
  assert.equal(parseMediaFile(123), null);
  await t.cleanup();
});

test('/media 可被收录：200 不带 X-Robots-Tag（经 fileRoute 包装后也没有）；404 仍是 no-store；正式环境 robots.txt 不 Disallow /media/', async () => {
  const t = await assetDeps();
  const a = (await body(await handleUploadAsset(uploadReq(await solid(2400, 1800)), t.d))).json;
  const md = { findLive: async (id: string) => { const r = t.mem.rows.get(id); return r && !r.deletedAt ? r : null; }, storage: t.local };
  const GET = fileRoute(async (_req: Request, f: string) => handleMedia(f, md));
  for (const w of [800, 1600]) {
    const r = await GET(new Request(`http://localhost/media/${a.id}-${w}.webp`), `${a.id}-${w}.webp`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-robots-tag'), null);
    assert.equal(r.headers.get('cache-control'), MEDIA_CACHE_CONTROL);
  }
  const nfr = await GET(new Request('http://localhost/media/x'), `${a.id}-801.webp`);
  assert.deepEqual([nfr.status, nfr.headers.get('cache-control')], [404, 'no-store']);
  await t.cleanup();
  // 全站安全头里没有 X-Robots-Tag；next.config 里带 X-Robots-Tag 的只有：非正式环境全站、后台路径、/s/
  assert.ok(!securityHeaders.some((h) => h.key.toLowerCase() === 'x-robots-tag'));
  const cfg = readFileSync('next.config.ts', 'utf8');
  assert.match(cfg, /\.\.\.\(isProd \? \[\] : \[\{ source: '\/:path\*', headers: \[\{ key: 'X-Robots-Tag', value: 'noindex, nofollow' \}\] \}\]\),/);
  const robotsSources = [...cfg.matchAll(/\{ source: '([^']+)', headers: \[\{ key: 'X-Robots-Tag'/g)].map((m) => m[1]);
  assert.deepEqual(robotsSources, ['/:path*', '/s/:path*']);
  const adminSources = /\.\.\.\[([^\]]+)\]\.map\(\(source\) => \(\{ source, headers: adminHeaders \}\)\)/.exec(cfg)![1];
  assert.doesNotMatch(adminSources, /media/);
  // 正式环境 robots.txt：没有任何 Disallow 规则能匹配 /media/<id>-<w>.webp
  const prev = { APP_ENV: process.env.APP_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
  process.env.APP_ENV = 'production';
  try {
    const { default: robots } = await import('../src/app/robots');
    const rules = robots().rules as { disallow?: string | string[] };
    const dis = ([] as string[]).concat(rules.disallow ?? []);
    assert.ok(dis.length > 0);
    const blocks = (p: string) => dis.some((d) => new RegExp('^' + d.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')).test(p));
    assert.equal(blocks(`/media/${'A'.repeat(24)}-1600.webp`), false);
    assert.equal(blocks('/api/x'), true); assert.equal(blocks('/admin'), true);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('/media 路由接线：fileRoute 包住 GET；不经过 i18n 中间件（不会下发 NEXT_LOCALE）；不被带点路径兜底 rewrite；不套全站 CSP', () => {
  const src = readFileSync('src/app/media/[file]/route.ts', 'utf8');
  assert.match(src, /^export const GET = fileRoute\(async \(/m);
  assert.match(src, /deletedAt: null/);
  const mw = readFileSync('src/middleware.ts', 'utf8');
  const matcher = /matcher: \['([^']+)'/.exec(mw)![1];
  const mwMatch = getPathMatch(matcher.replace(/\\\\/g, '\\'), { removeUnnamedParams: true, strict: true });
  assert.equal(mwMatch('/media/AAAAAAAAAAAAAAAAAAAAAAAA-1600.webp'), false);
  const cfg = readFileSync('next.config.ts', 'utf8');
  const prefix = /const NO_DOT_REWRITE = '([^']+)'/.exec(cfg)![1];
  const dotted = getPathMatch(`/:path((?!${prefix}).*\\..*)`, { removeUnnamedParams: true, strict: true });
  assert.equal(dotted('/media/AAAAAAAAAAAAAAAAAAAAAAAA-1600.webp'), false);
  assert.ok(dotted('/mediax/a.webp'));
  assert.ok(cfg.includes("'/media/:file'"));
  const ex = new RegExp(`^/((?!${/FILE_ROUTE_EXCLUDE = '([^']+)'/.exec(cfg)![1]}).*)$`);
  assert.ok(!ex.test('/media/AAAAAAAAAAAAAAAAAAAAAAAA-1600.webp'));
  assert.ok(ex.test('/en/media'));
});

test('后台 route 文件：直接写 requireAdmin(（check-admin-guard）、经 deps 传入；共享 deps 不含 requireAdmin', () => {
  for (const f of ['src/app/api/admin/site-settings/assets/route.ts', 'src/app/api/admin/site-settings/assets/[id]/route.ts', 'src/app/api/admin/site-settings/about/images/route.ts']) {
    const s = readFileSync(f, 'utf8');
    assert.match(s, /requireAdmin: \(req: Request, roles: Parameters<typeof requireAdmin>\[1\]\) => requireAdmin\(req, roles\)/, f);
  }
  const deps = readFileSync('src/lib/server/public-assets-deps.ts', 'utf8');
  assert.match(deps, /Omit<PublicAssetDeps, 'requireAdmin'>/);
  assert.doesNotMatch(deps.replace(/\/\*[\s\S]*?\*\//g, ''), /requireAdmin:/);
});
