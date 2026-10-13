// 检查模型引用（issue #31）：products.ts / models.generated.ts 引用的每个 GLB 都必须存在，
// GLB 内 NEEDLE_progressive 引用的 .lod0.glb 也必须存在；public/models 里没人引用的文件给出警告。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
const products = readFileSync('src/data/products.ts', 'utf8');
const manifest = readFileSync('src/data/models.generated.ts', 'utf8');
const models = Object.fromEntries([...manifest.matchAll(/'([^']+)': '([^']+)'/g)].map(m => [m[1], m[2]]));
let bad = 0; const err = (m) => { bad++; console.error('✗ ' + m); };
const refs = new Set();
for (const m of products.matchAll(/MODELS\['([^']+)'\]/g)) { if (!models[m[1]]) err(`products.ts 引用了不存在的模型名 ${m[1]}`); else refs.add(models[m[1]]); }
for (const m of products.matchAll(/['"](\/models\/[^'"]+)['"]/g)) refs.add(m[1]);
for (const v of Object.values(models)) refs.add(v);
const seen = new Set();
for (const r of refs) {
  const f = join('public', r); seen.add(basename(f));
  if (!existsSync(f)) { err(`缺少模型文件 ${f}`); continue; }
  const b = readFileSync(f); if (b.readUInt32LE(0) !== 0x46546c67) { err(`${f} 不是 GLB`); continue; }
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
  for (const kind of ['meshes', 'textures']) for (const it of json[kind] ?? []) for (const l of it.extensions?.NEEDLE_progressive?.lods ?? []) {
    const lf = join(dirname(f), l.path); seen.add(basename(lf)); if (!existsSync(lf)) err(`${f} 的 LOD 引用缺失: ${lf}`);
  }
}
if (existsSync('public/models')) for (const f of readdirSync('public/models')) if (f.endsWith('.glb') && !seen.has(f)) console.warn(`! 未被引用的模型文件 public/models/${f}`);
console.log(bad ? `模型引用检查失败：${bad} 处` : `模型引用检查通过：${refs.size} 个模型`);
process.exit(bad ? 1 : 0);
