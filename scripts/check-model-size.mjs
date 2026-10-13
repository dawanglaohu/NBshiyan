// 检查 public/models 下的 GLB 体积；文件名含 .anim. 的视为带动画模型
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const dir = 'public/models';
if (!existsSync(dir)) { console.log('没有模型目录，跳过'); process.exit(0); }
const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
let bad = 0;
for (const f of walk(dir).filter(f => f.endsWith('.glb'))) {
  const limit = f.includes('.anim.') ? 1.5 * 1024 * 1024 : 1024 * 1024;
  const size = statSync(f).size;
  if (size > limit) { bad++; console.error(`超限: ${f} ${(size / 1048576).toFixed(2)}MB`); }
}
process.exit(bad ? 1 : 0);
