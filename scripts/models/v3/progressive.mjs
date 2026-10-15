// 把源 GLB（未压缩、PNG 贴图）打包成 gltf-progressive（NEEDLE_progressive 扩展）格式：
//   <name>.<hash>.glb       轻量预览（贴图 64px、网格简化），首屏先加载
//   <name>.<hash>.lod0.glb  完整精度，gltf-progressive 按屏幕占比后台替换
// 两个文件都是 Draco + KTX2(ETC1S)。用法：node progressive.mjs <src.glb> <outDir> <name>
// 依赖：@gltf-transform/core|functions|cli@4、meshoptimizer、sharp、KTX-Software(toktx)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplify, weld, textureCompress } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [src, outDir, name] = process.argv.slice(2);
const PREVIEW_TEX = +(process.env.PREVIEW_TEX ?? 64), SIMPLIFY_MIN_TRIS = 100, SIMPLIFY_RATIO = 0.15;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prog-'));
const gt = (...a) => execFileSync('npx', ['gltf-transform', ...a], { stdio: 'pipe' });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// 1) 完整精度
gt('etc1s', src, `${tmp}/full.k.glb`, '--quality', '160');
gt('draco', `${tmp}/full.k.glb`, `${tmp}/full.glb`);
// 2) 预览：小贴图 + 简化网格（保留动画/节点结构）
await MeshoptSimplifier.ready;
const doc = await io.read(src);
await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'png', resize: [PREVIEW_TEX, PREVIEW_TEX] }));
// 预览里把指定材质（如瓦楞芯纸 Fluting）的波纹压平到最薄轴的中面，简化后只剩几个三角形；完整版 lod0 保留真实波纹
const FLAT = (process.env.PREVIEW_FLATTEN ?? '').split(',').filter(Boolean);
for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
  if (!FLAT.includes(p.getMaterial()?.getName())) continue;
  const pos = p.getAttribute('POSITION'); const mn = pos.getMin([]), mx = pos.getMax([]);
  const ax = [0, 1, 2].reduce((a, k) => (mx[k] - mn[k] < mx[a] - mn[a] ? k : a), 0); const mid = (mn[ax] + mx[ax]) / 2;
  const el = []; for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, el); el[ax] = mid; pos.setElement(i, el); }
  const nrm = p.getAttribute('NORMAL'); if (nrm) for (let i = 0; i < nrm.getCount(); i++) { const n = [0, 0, 0]; n[ax] = 1; nrm.setElement(i, n); }
}
const big = doc.getRoot().listMeshes().some(m => m.listPrimitives().some(p => (p.getIndices()?.getCount() ?? 0) / 3 >= SIMPLIFY_MIN_TRIS));
if (big) await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: SIMPLIFY_RATIO, error: 0.01 }));
await io.write(`${tmp}/prev.png.glb`, doc);
gt('etc1s', `${tmp}/prev.png.glb`, `${tmp}/prev.k.glb`, '--quality', '128');
gt('draco', `${tmp}/prev.k.glb`, `${tmp}/prev.glb`);

// 3) 写入 NEEDLE_progressive 扩展
function readGlb(f) { const b = fs.readFileSync(f); const jl = b.readUInt32LE(12); return { json: JSON.parse(b.subarray(20, 20 + jl).toString()), bin: b.subarray(20 + jl) }; }
function writeGlb(f, { json, bin }) {
  let j = Buffer.from(JSON.stringify(json, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(6) : v))); j = Buffer.concat([j, Buffer.alloc((4 - j.length % 4) % 4, 0x20)]);
  const h = Buffer.alloc(20); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(20 + j.length + bin.length, 8); h.writeUInt32LE(j.length, 12); h.writeUInt32LE(0x4e4f534a, 16);
  fs.writeFileSync(f, Buffer.concat([h, j, bin]));
}
const full = readGlb(`${tmp}/full.glb`), prev = readGlb(`${tmp}/prev.glb`);
const hash = createHash('sha1').update(fs.readFileSync(`${tmp}/full.glb`)).update(fs.readFileSync(`${tmp}/prev.glb`)).digest('hex').slice(0, 8);
const mainFile = `${name}.${hash}.glb`, lodFile = `${name}.${hash}.lod0.glb`;
const meshInfo = (g, m) => { const prims = m.primitives.map(p => ({ i: g.accessors[p.indices].count, v: g.accessors[p.attributes.POSITION].count }));
  return { indexCount: prims.reduce((a, p) => a + p.i, 0), vertexCount: prims.reduce((a, p) => a + p.v, 0), densities: prims.map(p => Math.max(1, p.i / 3)) }; };
const ktxSize = (g, t) => { const ext = t.extensions?.KHR_texture_basisu; const img = g.images[ext?.source ?? t.source]; const bv = g.bufferViews[img.bufferView];
  const b = (g === full.json ? full : prev).bin.subarray(8 + (bv.byteOffset ?? 0)); return { width: b.readUInt32LE(20), height: b.readUInt32LE(24) }; };
for (const kind of ['meshes', 'textures']) {
  (prev.json[kind] ?? []).forEach((item, i) => {
    const key = item.name ?? `${kind}${i}`;
    const fi = full.json[kind].findIndex((x, k) => (x.name ?? `${kind}${k}`) === key);
    if (fi < 0) throw new Error(`no full-res match for ${kind} ${key}`);
    const guid = createHash('sha1').update(`${name}/${kind}/${key}/${hash}`).digest('hex').slice(0, 16);
    const fullItem = full.json[kind][fi];
    const lods = kind === 'meshes'
      ? [{ path: lodFile, ...meshInfo(full.json, fullItem) }, { path: mainFile, ...meshInfo(prev.json, item) }]
      : [{ path: lodFile, ...ktxSize(full.json, fullItem) }, { path: mainFile, ...ktxSize(prev.json, item) }];
    item.extensions = { ...item.extensions, NEEDLE_progressive: { guid, lods } };
    fullItem.extensions = { ...fullItem.extensions, NEEDLE_progressive: { guid, lods } };
  });
}
for (const g of [full.json, prev.json]) g.extensionsUsed = [...new Set([...(g.extensionsUsed ?? []), 'NEEDLE_progressive'])];
fs.mkdirSync(outDir, { recursive: true });
writeGlb(path.join(outDir, mainFile), prev); writeGlb(path.join(outDir, lodFile), full);
fs.rmSync(tmp, { recursive: true });
console.log(JSON.stringify({ main: mainFile, lod0: lodFile, mainBytes: fs.statSync(path.join(outDir, mainFile)).size, lod0Bytes: fs.statSync(path.join(outDir, lodFile)).size }));

// 4) 更新 src/data/models.generated.ts（products.ts 从这里取路径，避免手抄哈希文件名导致 404，issue #31）
//    同名旧版本文件一并删除，保证 public/models 里每个模型只有一份。
const isPublic = path.resolve(outDir) === path.resolve(new URL('../../public/models', import.meta.url).pathname);
const manifestPath = new URL('../../src/data/models.generated.ts', import.meta.url);
let models = {};
try { const src = fs.readFileSync(manifestPath, 'utf8'); for (const m of src.matchAll(/'([^']+)': '([^']+)'/g)) models[m[1]] = m[2]; } catch {}
const old = models[name];
if (isPublic && old && old !== `/models/${mainFile}`) {
  for (const f of [old, old.replace(/\.glb$/, '.lod0.glb')]) fs.rmSync(path.join(outDir, path.basename(f)), { force: true });
}
if (isPublic) {
models[name] = `/models/${mainFile}`;
const body = Object.keys(models).sort().map(k => `  '${k}': '${models[k]}',`).join('\n');
fs.writeFileSync(manifestPath, `// 自动生成：scripts/models/progressive.mjs 打包模型时写入，请勿手改。\n// key = 模型名（文件名去掉内容哈希），value = public/ 下的实际路径。\nexport const MODELS = {\n${body}\n} as const;\nexport type ModelKey = keyof typeof MODELS;\n`);
}
