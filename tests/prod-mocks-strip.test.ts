// #323：src 里的 mock（src/lib/**/mock.ts、sanityMock.ts、models-mock.ts 等）不进生产产物。
// 静态检查默认跑；产物检查需要先做一次生产构建（APP_ENV=production），然后：
//   MOCK_BUNDLE_TEST=1 node --import tsx --test tests/prod-mocks-strip.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileId, sameFile } from '../scripts/lint-ru-yo.mjs';

const walk = (dir: string, skip: (p: string) => boolean = () => false): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (skip(p)) return [];
    return statSync(p).isDirectory() ? walk(p, skip) : [fileId(p)];
  });

const MOCK_FILE = /(^|\/)(mock|[A-Za-z]+Mock|[a-z0-9-]+-mock)\.ts$/;

test('#323 所有 src/lib 下的 mock 源文件都被 next.config 的 outputFileTracingExcludes 覆盖；不用 .dockerignore 排除', () => {
  const cfg = readFileSync('next.config.ts', 'utf8');
  assert.match(cfg, /outputFileTracingExcludes: \{ '\/\*\*': MOCK_SOURCE_GLOBS \}/);
  assert.match(cfg, /const MOCK_SOURCE_GLOBS = \['\.\/src\/lib\/\*\*\/mock\.ts', '\.\/src\/lib\/\*\*\/\*Mock\.ts', '\.\/src\/lib\/\*\*\/\*-mock\.ts'\];/);
  const files = walk('src').filter((f) => /mock/i.test(path.basename(f)) && f.endsWith('.ts'));
  assert.ok(files.length >= 5);
  for (const f of ['src/lib/admin/mock.ts', 'src/lib/admin/mail/mock.ts', 'src/lib/admin/models-mock.ts', 'src/lib/server/sanityMock.ts', 'src/lib/server/mail/mock.ts']) {
    assert.ok(files.includes(f), f);
    assert.ok(files.includes(fileId(f.split('/').join('\\'))), f);
    assert.ok(sameFile(f, f.split('/').join('\\')));
  }
  for (const f of files) {
    if (f === 'src/lib/seo/mock.ts') continue; // 只有开关函数（seoMockEnabled / categoryPagesLive），没有 mock 数据；被页面和 next.config 正常 import
    assert.ok(f.startsWith('src/lib/') && MOCK_FILE.test(f), `${f} not covered by MOCK_SOURCE_GLOBS`);
  }
  const di = existsSync('.dockerignore') ? readFileSync('.dockerignore', 'utf8') : '';
  assert.doesNotMatch(di, /mock/i, '.dockerignore must not exclude mocks (they are imported; build would fail)');
});

test('#323 每个 mock 的 import 都在构建期常量后面（生产构建里是死代码）', () => {
  const gates: [string, RegExp][] = [
    ['src/lib/admin/api.ts', /process\.env\.NEXT_PUBLIC_ADMIN_API === 'http' \? httpAdminApi\s*: lazyApi<AdminApi>\(\(\) => import\('\.\/mock'\)/],
    ['src/lib/admin/models-api.ts', /process\.env\.NEXT_PUBLIC_ADMIN_API === 'http' \? httpModelApi\s*: lazyApi<ModelApi>\(\(\) => import\('\.\/models-mock'\)/],
    ['src/lib/admin/mail/api.ts', /process\.env\.NEXT_PUBLIC_ADMIN_MAIL !== 'mock' \? httpMailApi\s*: lazyApi<MailApi>\(\(\) => import\('\.\/mock'\)/],
    ['src/lib/server/mail/http.ts', /if \(process\.env\.MAIL_MOCK_ADAPTER_BUILD !== '' && mockAdapterAllowed\(\)\) return \(await import\('\.\/mock'\)\)/],
  ];
  for (const [f, re] of gates) assert.match(readFileSync(f, 'utf8'), re, f);
  for (const f of ['src/lib/server/sanity.ts', 'src/app/sitemap.ts']) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/import\('[^']*sanityMock'\)/g)) assert.match(src.slice(Math.max(0, m.index! - 200), m.index), /process\.env\.SEO_AUDIT_MOCK_BUILD === '1' && seoMockEnabled\(\)/, f);
  }
  // 没有静态 import mock（静态 import 去不掉）；admin/mail/mock.ts 引用 ../mock 只在 mock 文件之间
  for (const f of walk('src').filter((x) => /\.(ts|tsx)$/.test(x) && !MOCK_FILE.test(x)))
    assert.doesNotMatch(readFileSync(f, 'utf8').replace(/^import [^;]*from '@\/lib\/seo\/mock';$/gm, ''), /^import [^;]*from '[^']*(\/mock|Mock|-mock)';/m, f); // seo/mock 只是开关（见上）
  const cfg = readFileSync('next.config.ts', 'utf8');
  assert.match(cfg, /MAIL_MOCK_ADAPTER_BUILD: isProd \? '' : '1'/);
  assert.match(cfg, /SEO_AUDIT_MOCK_BUILD: seoMockEnabled\(\) \? '1' : ''/);
  assert.match(cfg, /NEXT_PUBLIC_ADMIN_API: process\.env\.NEXT_PUBLIC_ADMIN_API \?\? '', NEXT_PUBLIC_ADMIN_MAIL: process\.env\.NEXT_PUBLIC_ADMIN_MAIL \?\? ''/);
});

// 各 mock 文件里独有的字符串（mock 数据或 mock 实现的名字）
const MARKERS = ['sales-a@packjoyu.example', 'ivan@romashka.ru', 'mock-article-packaging-guide', 'mock-statya-o-upakovke', 'Тестовая статья: проверка макета', 'mockAdminApi', 'mockMailApi', 'mockModelApi', 'createMockAdapter'];
const bundleEnabled = process.env.MOCK_BUNDLE_TEST === '1' && existsSync('.next/standalone/server.js');

test('#323 生产构建产物（.next/standalone、.next/server、.next/static）里没有 mock 源文件，也没有 mock 数据', { skip: !bundleEnabled }, () => {
  assert.match(readFileSync('.next/standalone/server.js', 'utf8'), /"APP_ENV_AT_BUILD":"production"/, 'must be a production build');
  const files = [
    ...walk('.next/standalone', (p) => p.includes(`${path.sep}node_modules${path.sep}`) || p.endsWith(`${path.sep}node_modules`)),
    ...walk('.next/server'), ...walk('.next/static'),
  ];
  assert.ok(files.length > 100);
  const leakedFiles = files.filter((f) => /\/src\/lib\//.test(f) && MOCK_FILE.test(f));
  assert.deepEqual(leakedFiles, []);
  const hits: string[] = [];
  for (const f of files.filter((x) => /\.(js|json|ts|html|rsc|mjs|map)$/.test(x))) {
    const s = readFileSync(f, 'utf8');
    for (const m of MARKERS) if (s.includes(m)) hits.push(`${m} in ${f}`);
  }
  assert.deepEqual(hits, []);
});

test('#323 slash and backslash name one mock file; a real uncovered mock stays a failure', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mock-id-'));
  try {
    const covered = path.join(root, 'src', 'lib', 'admin', 'mock.ts');
    const uncovered = path.join(root, 'src', 'components', 'widget-mock.ts');
    const importer = path.join(root, 'src', 'components', 'widget.ts');
    mkdirSync(path.dirname(covered), { recursive: true });
    mkdirSync(path.dirname(uncovered), { recursive: true });
    writeFileSync(covered, 'export const mockAdminApi = {};\n');
    writeFileSync(uncovered, 'export const widgetMock = true;\n');
    writeFileSync(importer, "import { mockAdminApi } from '../lib/admin/mock';\n");

    const slash = 'src/lib/admin/mock.ts';
    const back = 'src\\lib\\admin\\mock.ts';
    assert.equal(fileId(back), slash);
    assert.ok(sameFile(slash, back));
    assert.equal(sameFile(slash, 'src/lib/admin/other.ts'), false);
    assert.equal(readFileSync(covered, 'utf8'), readFileSync(fileId(covered), 'utf8'));
    assert.ok(MOCK_FILE.test(fileId(back)));
    assert.ok(MOCK_FILE.test(fileId(path.join('src', 'components', 'widget-mock.ts'))));
    assert.equal(MOCK_FILE.test(fileId(path.join('src', 'components', 'widget.ts'))), false);

    assert.deepEqual(walk(path.join(root, 'missing')), []);
    const discovered = walk(path.join(root, 'src')).map((abs) => fileId(path.relative(root, abs)));
    assert.deepEqual(discovered.slice().sort(), [
      'src/components/widget-mock.ts',
      'src/components/widget.ts',
      'src/lib/admin/mock.ts',
    ]);
    assert.ok(discovered.includes(fileId(back)));
    assert.equal(discovered.filter((f) => sameFile(f, slash)).length, 1);

    const uncoveredMocks = discovered.filter((f) => /mock/i.test(path.basename(f)) && f.endsWith('.ts') && f !== 'src/lib/seo/mock.ts' && !(f.startsWith('src/lib/') && MOCK_FILE.test(f)));
    assert.deepEqual(uncoveredMocks, ['src/components/widget-mock.ts']);

    const nonMocks = discovered.filter((f) => /\.(ts|tsx)$/.test(f) && !MOCK_FILE.test(f));
    assert.deepEqual(nonMocks, ['src/components/widget.ts']);
    const staticHits = nonMocks.filter((f) => /^import [^;]*from '[^']*(\/mock|Mock|-mock)';/m.test(readFileSync(path.join(root, f), 'utf8')));
    assert.deepEqual(staticHits, ['src/components/widget.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
