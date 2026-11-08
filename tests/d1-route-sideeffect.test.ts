// D1 退役路由「真实调用计数」回归的默认入口。
//
// `pnpm test` 是 `node --import tsx --test tests/*.test.ts`，本身不带模块 mock 所需的 flag，
// 所以这里用子进程拉起真正带 flag 的用例文件；**不 skip、不静默降级**：
// 子进程起不来、flag 不受支持、用例数为 0 或任何用例失败，本文件都直接失败。
//
// 另外守三条与临时目录有关的性质（它们都是本文件自己制造的对照，不依赖预存内容）：
//   1. 子进程只清理自己 mkdtemp 出来的目录，结束之后不留残骸；
//   2. 预存的哨兵目录/文件在正常结束与失败结束之后字节不变（旧实现会无条件递归删除固定路径）；
//   3. 两个子进程并行时各自持有唯一目录、互不删除，且都实际跑满 5 个内层用例。
//
// 注：CI 用 actions/checkout 默认浅克隆，没有历史提交。因此默认入口**不**依赖 Git 历史；
// 需要从固定提交取旧路由的红证据与并行取证在本机全量克隆下单独跑：
//   D1_ROUTE_REV=78966e99 node --experimental-test-module-mocks --import tsx --test tests/fixtures/d1-route-sideeffect.case.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CASE_FILE = path.join('tests', 'fixtures', 'd1-route-sideeffect.case.ts');
const FLAGS = [
  '--experimental-test-module-mocks',
  '--import',
  'tsx',
  '--test',
  '--test-reporter=tap',
  CASE_FILE,
];
const RESULTS_DIR = path.join(ROOT, 'test-results');
const LEGACY_FIXED = path.join(RESULTS_DIR, '.d1-route-sideeffect'); // 旧实现会无条件删除的固定路径
const OWNED_PREFIX = '.d1-route-sideeffect-'; // 本实现 mkdtemp 的前缀，与上面的固定路径不重叠

type ChildResult = { status: number | null; stdout: string; stderr: string; label: string };

function childEnv(extra: Record<string, string> = {}) {
  // 外层测试进程会带 NODE_TEST_CONTEXT；若原样继承，子进程里的 node:test 会判定为递归运行
  // 而「跳过执行文件」却仍以 0 退出——那会变成假绿。这里显式剥掉。
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  if (!('D1_ROUTE_REV' in extra)) delete env.D1_ROUTE_REV;
  return env;
}

function runCase(extra: Record<string, string> = {}): ChildResult {
  const result = spawnSync(process.execPath, FLAGS, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: childEnv(extra),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.error ? `spawn error: ${result.error.message}\n` : ''}${result.stderr ?? ''}`,
    label: Object.keys(extra).length ? JSON.stringify(extra) : '<none>',
  };
}

function runCaseAsync(extra: Record<string, string> = {}): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, FLAGS, { cwd: ROOT, env: childEnv(extra) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) =>
      resolve({ status, stdout, stderr, label: Object.keys(extra).length ? JSON.stringify(extra) : '<none>' }),
    );
  });
}

function detail(result: ChildResult) {
  return [
    `env: ${result.label}`,
    `命令: ${process.execPath} ${FLAGS.join(' ')}`,
    `CWD: ${ROOT}`,
    `node: ${process.version}`,
    `exit: ${result.status}`,
    `STDOUT:\n${result.stdout}`,
    `STDERR:\n${result.stderr}`,
  ].join('\n');
}

function tmpDirs() {
  if (!existsSync(RESULTS_DIR)) return [] as string[];
  return readdirSync(RESULTS_DIR).filter((name) => name.startsWith(OWNED_PREFIX));
}

function parseFirstMatch(stdout: string, marker: string) {
  const line = stdout.split(/\r?\n/).find((row) => row.startsWith(`# [d1-sideeffect] ${marker} `));
  return line ? (JSON.parse(line.slice(`# [d1-sideeffect] ${marker} `.length)) as Record<string, unknown>) : null;
}

function countOf(stdout: string, key: 'pass' | 'fail') {
  return Number(stdout.match(new RegExp(`^# ${key} (\\d+)\\s*$`, 'm'))?.[1] ?? -1);
}

function assertCasePassed(result: ChildResult) {
  assert.equal(result.status, 0, `调用计数回归失败（flag 不受支持或断言不成立都会走到这里）\n${detail(result)}`);
  const pass = countOf(result.stdout, 'pass');
  const fail = countOf(result.stdout, 'fail');
  assert.ok(pass >= 5, `子进程没有实际执行用例（pass=${pass}），不能算通过\n${detail(result)}`);
  assert.equal(fail, 0, `子进程有失败用例（fail=${fail}）\n${detail(result)}`);
  const tmpdir = parseFirstMatch(result.stdout, 'tmpdir');
  const identity = parseFirstMatch(result.stdout, '被测路由');
  assert.ok(tmpdir && tmpdir.owned === true, `子进程未声明临时目录所有权\n${detail(result)}`);
  assert.ok(identity && typeof identity.sha256 === 'string', `子进程未输出被测路由身份\n${detail(result)}`);
  return { tmpdir, identity, pass };
}

// --- 预存哨兵：模拟「别人早就放在那里」的目录与文件，测试结束后必须原样还在 ---
function setupSentinels() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const legacyExisted = existsSync(LEGACY_FIXED);
  if (!legacyExisted) mkdirSync(LEGACY_FIXED, { recursive: true });
  const legacyFile = path.join(LEGACY_FIXED, 'sentinel.txt');
  const legacyHadFile = existsSync(legacyFile);
  const legacyBytes = legacyHadFile ? readFileSync(legacyFile) : Buffer.from('d1-sentinel-legacy', 'utf8');
  writeFileSync(legacyFile, legacyBytes);

  const parentFile = path.join(RESULTS_DIR, `d1-sentinel-parent-${process.pid}.txt`);
  const parentBytes = Buffer.from('d1-sentinel-parent', 'utf8');
  writeFileSync(parentFile, parentBytes);

  return { legacyExisted, legacyHadFile, legacyFile, legacyBytes, parentFile, parentBytes };
}

function assertSentinelsUntouched(s: ReturnType<typeof setupSentinels>, label: string) {
  assert.ok(existsSync(s.legacyFile), `${label}：预存固定目录里的哨兵被删了`);
  assert.deepEqual(readFileSync(s.legacyFile), s.legacyBytes, `${label}：预存固定目录里的哨兵字节被改写`);
  assert.ok(existsSync(s.parentFile), `${label}：test-results 下的预存哨兵被删了`);
  assert.deepEqual(readFileSync(s.parentFile), s.parentBytes, `${label}：test-results 下的预存哨兵字节被改写`);
  assert.ok(existsSync(LEGACY_FIXED), `${label}：预存固定目录本身被删了`);
}

function teardownSentinels(s: ReturnType<typeof setupSentinels>) {
  if (!s.legacyHadFile) rmSync(s.legacyFile, { force: true });
  if (!s.legacyExisted) rmSync(LEGACY_FIXED, { recursive: true, force: true });
  rmSync(s.parentFile, { force: true });
}

test('默认入口实跑计数回归：绿测 5/5，且只清理自己的临时目录', () => {
  const before = tmpDirs();
  const { tmpdir } = assertCasePassed(runCase());
  const dir = path.resolve(String(tmpdir.dir));

  assert.equal(path.dirname(dir), RESULTS_DIR, `临时目录必须落在 test-results 下，实际 ${dir}`);
  assert.ok(path.basename(dir).startsWith(OWNED_PREFIX), `临时目录名必须带独占前缀，实际 ${dir}`);
  assert.equal(existsSync(dir), false, `子进程退出后自己的临时目录必须已清理：${dir}`);

  const leaked = tmpDirs().filter((name) => !before.includes(name));
  assert.deepEqual(leaked, [], `子进程留下残骸：${leaked.join(', ')}`);
});

test('预存哨兵：正常结束不删除、不改写非本次创建的目录与文件', () => {
  const sentinels = setupSentinels();
  try {
    assertCasePassed(runCase());
    assertSentinelsUntouched(sentinels, '正常结束');
  } finally {
    teardownSentinels(sentinels);
  }
});

test('预存哨兵：失败结束也不删除、不改写非本次创建的目录与文件', () => {
  const sentinels = setupSentinels();
  const before = tmpDirs();
  try {
    // 故意给一个不存在的提交：夹具在读取源码阶段抛错，进程以非 0 退出（这是失败结束，不是 skip）
    const result = runCase({ D1_ROUTE_REV: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    assert.notEqual(result.status, 0, `失败结束的用例应当非 0 退出\n${detail(result)}`);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /1\.\.0|not ok|# fail [1-9]|before|Error/i,
      `失败原因不是夹具读取源码失败，而是别的错误\n${detail(result)}`,
    );
    assertSentinelsUntouched(sentinels, '失败结束');
    const leaked = tmpDirs().filter((name) => !before.includes(name));
    assert.deepEqual(leaked, [], `失败结束留下了临时目录：${leaked.join(', ')}`);
  } finally {
    teardownSentinels(sentinels);
  }
});

test('并行对照：两个子进程各自唯一目录、互不删除，且都实际跑满 5 个内层用例', async () => {
  const before = tmpDirs();
  const [first, second] = await Promise.all([runCaseAsync(), runCaseAsync()]);

  const a = assertCasePassed(first);
  const b = assertCasePassed(second);

  const dirA = path.resolve(String(a.tmpdir.dir));
  const dirB = path.resolve(String(b.tmpdir.dir));
  assert.notEqual(dirA, dirB, '并行子进程不能共用同一个临时目录');
  assert.equal(existsSync(dirA), false, `并行子进程 A 的临时目录未清理：${dirA}`);
  assert.equal(existsSync(dirB), false, `并行子进程 B 的临时目录未清理：${dirB}`);

  const leaked = tmpDirs().filter((name) => !before.includes(name));
  assert.deepEqual(leaked, [], `并行运行留下残骸：${leaked.join(', ')}`);
});
