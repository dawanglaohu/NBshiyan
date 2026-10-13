import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 静态检查：公开接口只走白名单序列化，不读审计日志；后台接口的角色 / 同源 / 限流 / 缓存头
const pub = ['src/app/api/specs/route.ts', 'src/app/api/specs/[category]/route.ts', 'src/lib/server/specs-public.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
const admin = readFileSync('src/app/api/admin/specs/[category]/route.ts', 'utf8');

test('public spec endpoints never touch audit logs and only use publicView', () => {
  assert.ok(!/auditLog|audit\(|auditView|adminView/.test(pub));
  assert.match(pub, /publicView\(/);
  assert.match(pub, /s-maxage|PUBLIC_CACHE/);
});

test('admin spec route: EDITOR+ADMIN only, same-origin + rate limit on PUT, no-store, audit + revalidate', () => {
  assert.match(admin, /ROLES[^=]*= \['ADMIN', 'EDITOR'\]/);
  assert.ok(!admin.includes("'SALES'"));
  const put = admin.slice(admin.indexOf('export async function PUT'));
  const order = ['requireAdmin(', 'assertSameOrigin(', 'enforceAdminRateLimit(', 'SpecInput.safeParse', "action: 'spec.update'", 'revalidateTag(SPECS_TAG)'].map((s) => put.indexOf(s));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), String(order));
  assert.match(admin, /'Cache-Control': 'no-store'/);
});
