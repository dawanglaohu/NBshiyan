// 检查 src/data/products.ts 里引用的每个模型和封面文件，是否都在 public/ 下真实存在
import { readFileSync, existsSync } from 'node:fs';
const src = readFileSync('src/data/products.ts', 'utf8');
const refs = [...src.matchAll(/(?:model|poster)\s*:\s*['"`](\/[^'"`]+)['"`]/g)].map(m => m[1]);
if (!refs.length) { console.error('products.ts 里没找到任何 model/poster 路径，检查脚本可能需要更新'); process.exit(1); }
const missing = refs.filter(p => !existsSync('public' + decodeURI(p.split(/[?#]/)[0])));
missing.forEach(p => console.error(`缺少文件: public${p}`));
console.log(`已检查 ${refs.length} 个引用，缺少 ${missing.length} 个`);
process.exit(missing.length ? 1 : 0);
