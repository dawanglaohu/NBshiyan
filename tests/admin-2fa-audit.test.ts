import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  ENROLL_WINDOW_MS, ERROR_LINE, USAGE_LINE, countAdmin2faAudit, formatAudit, runAudit, type AuditDb,
} from '../scripts/admin-2fa-audit-lib.mjs';

// #361 部署前门禁脚本 scripts/admin-2fa-audit.mjs。prisma 换成内存里的假 count，不连任何数据库。
const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 18, 6, 0, 0);
type U = { role: 'ADMIN' | 'SALES'; disabled?: boolean; totpEnabled: boolean; createdAt: Date; enrollIssuedAt?: Date | null; email?: string };
const at = (msAgo: number) => new Date(NOW - msAgo);

/** 只实现脚本用到的 where 语法：等值、null、{ lte }、OR */
function match(u: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => match(u, w));
    const actual = u[k] ?? null;
    if (v === null) return actual === null;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const { lte, ...rest } = v as { lte?: Date };
      assert.deepEqual(rest, {}, `unsupported operator on ${k}`);
      return actual instanceof Date && lte instanceof Date && actual.getTime() <= lte.getTime();
    }
    return actual === v;
  });
}
function fakeDb(rows: U[], opts: { missingColumn?: boolean; fail?: unknown } = {}) {
  const calls: unknown[] = [];
  let disconnected = 0;
  const db: AuditDb = {
    user: {
      async count(args) {
        calls.push(args);
        assert.deepEqual(Object.keys(args), ['where'], 'count only, no select/include');
        if (opts.fail) throw opts.fail;
        if (opts.missingColumn && JSON.stringify(args.where).includes('enrollIssuedAt')) {
          throw Object.assign(new Error('The column `User.enrollIssuedAt` does not exist'), { code: 'P2022' });
        }
        const data = rows.map((r) => ({ disabled: false, enrollIssuedAt: null, ...r, ...(opts.missingColumn ? { enrollIssuedAt: undefined } : {}) }));
        return data.filter((r) => match(r, args.where)).length;
      },
    },
    async $disconnect() { disconnected++; },
  };
  return { db, calls, disconnected: () => disconnected };
}
const admin = (o: Partial<U>): U => ({ role: 'ADMIN', totpEnabled: false, createdAt: at(1 * H), ...o });

test('窗口常量和判定与 enroll-guard.ts 完全一致（逐个样本对比 enrollWindowOpen）', async () => {
  const guard = await import('../src/lib/server/admin/enroll-guard');
  assert.equal(ENROLL_WINDOW_MS, guard.ENROLL_WINDOW_MS);
  const samples: U[] = [];
  for (const c of [0, 1, 71 * H, ENROLL_WINDOW_MS - 1, ENROLL_WINDOW_MS, ENROLL_WINDOW_MS + 1, 500 * H])
    for (const e of [undefined, 0, 1, ENROLL_WINDOW_MS - 1, ENROLL_WINDOW_MS, ENROLL_WINDOW_MS + 1])
      samples.push(admin({ createdAt: at(c), enrollIssuedAt: e === undefined ? null : at(e) }));
  for (const u of samples) {
    const { db } = fakeDb([u]);
    const { unboundOver72h } = await countAdmin2faAudit(db, NOW);
    const closed = !guard.enrollWindowOpen({ createdAt: u.createdAt, enrollIssuedAt: u.enrollIssuedAt ?? null, totpPendingUntil: null, totpSecret: null }, NOW);
    assert.equal(unboundOver72h, closed ? 1 : 0, JSON.stringify(u));
  }
});

test('72 小时边界：差 1 毫秒不算，正好 72 小时算（与 now < 起点 + 72h 的窗口一致）', async () => {
  const { db } = fakeDb([admin({ createdAt: at(ENROLL_WINDOW_MS - 1) }), admin({ createdAt: at(ENROLL_WINDOW_MS) }), admin({ createdAt: at(ENROLL_WINDOW_MS + 1) })]);
  assert.deepEqual(await countAdmin2faAudit(db, NOW), { admins: 3, unboundOver72h: 2 });
});

test('起点：有 enrollIssuedAt（重置 2FA）时用它，不看 createdAt', async () => {
  const { db } = fakeDb([
    admin({ createdAt: at(500 * H), enrollIssuedAt: at(10 * H) }), // 老账号刚重置：窗口开着
    admin({ createdAt: at(500 * H), enrollIssuedAt: at(80 * H) }), // 重置也过了 72h：算
    admin({ createdAt: at(10 * H), enrollIssuedAt: null }), // 新账号：不算
    admin({ createdAt: at(80 * H), enrollIssuedAt: null }), // 新建超过 72h：算
  ]);
  assert.deepEqual(await countAdmin2faAudit(db, NOW), { admins: 4, unboundOver72h: 2 });
});

test('已绑定的、非 ADMIN 的、已停用的都不算；admins 只数未停用的 ADMIN', async () => {
  const old = at(200 * H);
  const { db } = fakeDb([
    admin({ createdAt: old, totpEnabled: true }),
    { role: 'SALES', totpEnabled: false, createdAt: old },
    admin({ createdAt: old, disabled: true }),
    admin({ createdAt: old }),
  ]);
  assert.deepEqual(await countAdmin2faAudit(db, NOW), { admins: 2, unboundOver72h: 1 });
});

test('#361 db push 之前（库里没有 enrollIssuedAt，P2022）退回只看 createdAt，结果与部署后一致', async () => {
  const rows = [admin({ createdAt: at(80 * H) }), admin({ createdAt: at(10 * H) })];
  const pre = fakeDb(rows, { missingColumn: true });
  assert.deepEqual(await countAdmin2faAudit(pre.db, NOW), { admins: 2, unboundOver72h: 1 });
  assert.equal(pre.calls.length, 3);
  assert.deepEqual(await countAdmin2faAudit(fakeDb(rows).db, NOW), { admins: 2, unboundOver72h: 1 });
  // 其它错误不退回
  await assert.rejects(countAdmin2faAudit(fakeDb(rows, { fail: Object.assign(new Error('x'), { code: 'P1001' }) }).db, NOW));
});

test('输出恰好两行，只有两个数字；不含邮箱、id、名字', async () => {
  let out = ''; let err = '';
  const f = fakeDb([admin({ createdAt: at(100 * H), email: 'owner@example.test' }), admin({})]);
  const code = await runAudit({ db: f.db, now: NOW, out: (s) => { out += s; }, err: (s) => { err += s; } });
  assert.equal(code, 0);
  assert.equal(out, 'admins=2\nunbound_over_72h=1\n');
  assert.match(out, /^admins=\d+\nunbound_over_72h=\d+\n$/);
  assert.equal(err, '');
  assert.equal(f.disconnected(), 1);
  assert.equal(formatAudit({ admins: 0, unboundOver72h: 0 }), 'admins=0\nunbound_over_72h=0\n');
});

test('出错只输出固定的 error=audit_failed：不回显异常里的连接串、邮箱、参数；照样断开连接', async () => {
  const leak = 'postgresql://app:hunter2@db.internal:5432/prod owner@example.test where email = $1';
  for (const fail of [new Error(leak), Object.assign(new Error(leak), { code: 'P1001', meta: { target: leak } }), leak]) {
    let out = ''; let err = '';
    const f = fakeDb([admin({})], { fail });
    const code = await runAudit({ db: f.db, now: NOW, out: (s) => { out += s; }, err: (s) => { err += s; } });
    assert.equal(code, 1);
    assert.equal(out, '');
    assert.equal(err, `${ERROR_LINE}\n`);
    assert.doesNotMatch(err, /postgres|hunter2|@|example|\$1/);
    assert.equal(f.disconnected(), 1);
  }
  // 创建客户端本身失败
  let err = '';
  assert.equal(await runAudit({ db: () => { throw new Error(leak); }, now: NOW, out: () => assert.fail('no stdout'), err: (s) => { err += s; } }), 1);
  assert.equal(err, `${ERROR_LINE}\n`);
  // 计数不是非负整数也算失败，不输出半截结果
  let out2 = '';
  const bad: AuditDb = { user: { count: async () => -1 }, $disconnect: async () => {} };
  assert.equal(await runAudit({ db: bad, now: NOW, out: (s) => { out2 += s; }, err: () => {} }), 1);
  assert.equal(out2, '');
});

test('不接受任何参数（不能从命令行传数据库地址），不连库', async () => {
  let err = '';
  const code = await runAudit({ db: () => assert.fail('must not connect'), argv: ['--url', 'postgresql://x'], now: NOW, out: () => assert.fail('no stdout'), err: (s) => { err += s; } });
  assert.equal(code, 2);
  assert.equal(err, `${USAGE_LINE}\n`);
});

test('真实入口：没有 DATABASE_URL 时只输出 error=audit_failed；带参数时拒绝（都不连库）', () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const a = spawnSync(process.execPath, ['scripts/admin-2fa-audit.mjs'], { env, encoding: 'utf8' });
  assert.equal(a.status, 1);
  assert.equal(a.stdout, '');
  assert.equal(a.stderr, 'error=audit_failed\n');
  const b = spawnSync(process.execPath, ['scripts/admin-2fa-audit.mjs', 'postgresql://x'], { env, encoding: 'utf8' });
  assert.equal(b.status, 2);
  assert.equal(b.stdout, '');
  assert.equal(b.stderr, 'error=no_args_accepted\n');
});

test('只读、只用应用自己的 prisma；会进 standalone 产物和镜像；文档写了运行命令', () => {
  const lib = readFileSync('scripts/admin-2fa-audit-lib.mjs', 'utf8');
  const entry = readFileSync('scripts/admin-2fa-audit.mjs', 'utf8');
  for (const src of [lib, entry]) {
    assert.doesNotMatch(src, /\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(|\$executeRaw|\$queryRaw|findMany|findFirst|findUnique|select:/);
    assert.doesNotMatch(src, /datasources|datasourceUrl|console\./);
  }
  assert.match(entry, /import\('@prisma\/client'\)/);
  assert.match(readFileSync('next.config.ts', 'utf8'), /'\.\/scripts\/admin-2fa-audit\.mjs', '\.\/scripts\/admin-2fa-audit-lib\.mjs'/);
  assert.match(readFileSync('Dockerfile', 'utf8'), /test -f scripts\/admin-2fa-audit\.mjs && test -f scripts\/admin-2fa-audit-lib\.mjs/);
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).scripts['admin:2fa-audit'], 'node scripts/admin-2fa-audit.mjs');
  assert.match(readFileSync('deploy/README.md', 'utf8'), /run --rm -T --no-deps app node scripts\/admin-2fa-audit\.mjs/);
  assert.match(readFileSync('docs/launch-infra.md', 'utf8'), /node scripts\/admin-2fa-audit\.mjs/);
});
