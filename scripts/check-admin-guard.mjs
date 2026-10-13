// CI 门禁：src/app/api/admin/** 下每个 route.ts 都必须调用鉴权函数。
// 允许：requireAdmin(（正式后台会话）、isAdminPlaceholder(（接入登录前的占位）、secretMatches(（定时任务 CRON_SECRET）。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src/app/api/admin';
const GUARDS = ['requireAdmin(', 'isAdminPlaceholder(', 'secretMatches('];

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /^route\.(ts|tsx|js|mjs)$/.test(n) ? [p] : [];
  });
}

if (!existsSync(ROOT)) { console.log('没有后台接口，跳过'); process.exit(0); }
const files = walk(ROOT);
const offenders = files.filter((f) => {
  const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const exportsHandler = /export\s+(async\s+)?(function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(src);
  return exportsHandler && !GUARDS.some((g) => src.includes(g));
});
if (offenders.length) {
  console.error(`以下后台接口没有调用鉴权（${GUARDS.join(' / ')}）：`);
  for (const f of offenders) console.error('  - ' + f);
  process.exit(1);
}
console.log(`后台接口鉴权检查通过，共 ${files.length} 个 route 文件`);
