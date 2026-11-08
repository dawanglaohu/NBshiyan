// D1 退役路由「真实调用计数」回归的默认入口。
//
// `pnpm test` 是 `node --import tsx --test tests/*.test.ts`，本身不带模块 mock 所需的 flag，
// 所以这里用子进程拉起真正带 flag 的用例文件；**不 skip、不静默降级**：
// 子进程起不来、flag 不受支持、用例数为 0 或任何用例失败，本测试都直接失败。
//
// 红证据（旧实现）用同一子进程，加 D1_ROUTE_REV=<rev> 即可：
//   D1_ROUTE_REV=78966e99 node --experimental-test-module-mocks --import tsx --test tests/fixtures/d1-route-sideeffect.case.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const CASE_FILE = path.join('tests', 'fixtures', 'd1-route-sideeffect.case.ts');
const FLAGS = ['--experimental-test-module-mocks', '--import', 'tsx', '--test', '--test-reporter=tap', CASE_FILE];

test('D1 退役路由：默认测试入口实跑真实调用计数回归（缺 flag / 不支持即失败）', () => {
  // 外层测试进程会带 NODE_TEST_CONTEXT；若原样继承，子进程里的 node:test 会判定为递归运行
  // 而「跳过执行文件」却仍以 0 退出——那会变成假绿。这里显式剥掉。
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;

  const result = spawnSync(process.execPath, FLAGS, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 180_000,
    env: childEnv,
  });

  const detail = [
    `命令: ${process.execPath} ${FLAGS.join(' ')}`,
    `CWD: ${process.cwd()}`,
    `node: ${process.version}`,
    `D1_ROUTE_REV: ${process.env.D1_ROUTE_REV ?? '<none>'}`,
    `exit: ${result.status} signal: ${result.signal ?? '<none>'}`,
    `STDOUT:\n${result.stdout ?? ''}`,
    `STDERR:\n${result.stderr ?? ''}`,
  ].join('\n');

  assert.equal(result.error, undefined, `子进程未能启动（不是 skip，是失败）\n${detail}`);
  assert.equal(result.status, 0, `D1 调用计数回归失败（flag 不受支持或断言不成立都会走到这里）\n${detail}`);

  // 防止「0 个用例也算成功」的假绿：必须真的跑了 ≥5 个用例且全部通过
  const pass = Number(result.stdout.match(/^# pass (\d+)\s*$/m)?.[1] ?? 0);
  const fail = Number(result.stdout.match(/^# fail (\d+)\s*$/m)?.[1] ?? 1);
  assert.ok(pass >= 5, `子进程没有实际执行用例（pass=${pass}），不能算通过\n${detail}`);
  assert.equal(fail, 0, `子进程有失败用例（fail=${fail}）\n${detail}`);
  assert.match(result.stdout, /\[d1-sideeffect\] 被测路由/, `子进程未输出被测路由身份\n${detail}`);
});
