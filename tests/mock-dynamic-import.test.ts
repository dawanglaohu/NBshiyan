import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lazyApi } from '../src/lib/admin/lazyApi';

// #291：后台数据层只能用 import() 按需加载 mock，生产构建里 mock 分支是死代码，不打包 mock 数据
const entries: [string, RegExp][] = [
  ['src/lib/admin/api.ts', /process\.env\.NEXT_PUBLIC_ADMIN_API === 'http'\s*\?\s*httpAdminApi/],
  ['src/lib/admin/mail/api.ts', /process\.env\.NEXT_PUBLIC_ADMIN_MAIL !== 'mock'\s*\?\s*httpMailApi/],
  ['src/lib/admin/models-api.ts', /process\.env\.NEXT_PUBLIC_ADMIN_API === 'http'\s*\?\s*httpModelApi/]
];
for (const [file, cond] of entries) {
  test(`${file} 不静态 import mock，切换条件直接用 process.env`, () => {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /^import[^;]*from\s+'\.\/(mock|models-mock)'/m);
    assert.match(src, /import\('\.\/(mock|models-mock)'\)/);
    assert.match(src, cond);
  });
}

test('next.config 把未设置的 ADMIN 开关也内联成常量', () => {
  const src = readFileSync('next.config.ts', 'utf8');
  assert.match(src, /NEXT_PUBLIC_ADMIN_API: process\.env\.NEXT_PUBLIC_ADMIN_API \?\? ''/);
  assert.match(src, /NEXT_PUBLIC_ADMIN_MAIL: process\.env\.NEXT_PUBLIC_ADMIN_MAIL \?\? ''/);
});

test('lazyApi：第一次调用才加载，只加载一次，this 指向实现', async () => {
  let loads = 0;
  const impl = { n: 2, async twice(x: number) { return x * this.n; } };
  const api = lazyApi(async () => { loads++; return impl; });
  assert.equal(loads, 0);
  assert.equal(await api.twice(3), 6);
  assert.equal(await api.twice(4), 8);
  assert.equal(loads, 1);
  assert.equal((api as unknown as { then?: unknown }).then, undefined);
});

test('lazyApi：实现抛出的错误原样传给调用方', async () => {
  const api = lazyApi(async () => ({ async boom(): Promise<never> { throw new Error('x'); } }));
  await assert.rejects(api.boom(), /x/);
});
