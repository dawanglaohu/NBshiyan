import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 模块缓存会掩盖初始化顺序错误；子进程只加载真实测试入口，不预装 Next 或 AsyncLocalStorage。
test('activity HTTP test initializes Next storage before its static dependencies', () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.ADMIN_DEVICE_TEST_DATABASE_URL;
  delete env.M3T3_TEST_DATABASE_URL;
  delete env.M3T3_REQUIRE_DATABASE;
  delete env.DATABASE_URL;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    assert.equal(typeof globalThis.AsyncLocalStorage, 'undefined');
    await import('./tests/admin-session-activity.http.test.ts');
    const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external.js');
    const { workUnitAsyncStorage } = await import('next/dist/server/app-render/work-unit-async-storage.external.js');
    const work = { isStaticGeneration: false };
    const unit = { type: 'request', phase: 'render' };
    workAsyncStorage.run(work, () => workUnitAsyncStorage.run(unit, () => {
      assert.equal(workAsyncStorage.getStore(), work);
      assert.equal(workUnitAsyncStorage.getStore(), unit);
    }));
    console.log('ACTIVITY_NEXT_STORAGE_BOOTSTRAP_OK');
  `], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /^ACTIVITY_NEXT_STORAGE_BOOTSTRAP_OK$/m);
});
