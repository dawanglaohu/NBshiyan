import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  checkImageContext,
  contextViolations,
  isDockerignored,
  moduleSpecifiers,
  parseDockerignore,
  resolveSpecifier,
} from '../scripts/check-image-context';

const root = path.resolve(import.meta.dirname, '..');
const rules = parseDockerignore(readFileSync(path.join(root, '.dockerignore'), 'utf8'));

test('.dockerignore 排除 docs 和 tests，保留 public、src 和 .env.example', () => {
  assert.equal(isDockerignored('docs/brand-media/static/held/packjoyu-industrial-city-v3-loop-poster.png', rules), true);
  assert.equal(isDockerignored('tests/image-context.test.ts', rules), true);
  assert.equal(isDockerignored('e2e/home-media.spec.ts', rules), true);
  assert.equal(isDockerignored('design/og-src/render-og.mjs', rules), true);
  assert.equal(isDockerignored('deploy/build-offbox.sh', rules), true);
  assert.equal(isDockerignored('nested/app.log', rules), true);
  assert.equal(isDockerignored('certs/server.pem', rules), true);
  assert.equal(isDockerignored('.env.local', rules), true);
  assert.equal(isDockerignored('.env.example', rules), false);
  assert.equal(isDockerignored('src/app/[locale]/page.tsx', rules), false);
  assert.equal(isDockerignored('public/brand/packjoyu-industrial-city-v3-loop-poster.png', rules), false);
  assert.equal(isDockerignored('scripts/check-image-context.ts', rules), false);
});

test('import、require、new URL 指向 docs 时失败，注释里的 docs 路径不算', () => {
  const from = 'src/app/[locale]/page.tsx';
  const imported = contextViolations(from, "import cityStill from '../../../docs/brand-media/static/held/poster.png';\n", rules);
  assert.deepEqual(imported.map((hit) => hit.resolved), ['docs/brand-media/static/held/poster.png']);
  const required = contextViolations(from, "const poster = require('../../../docs/brand-media/static/held/poster.png');\n", rules);
  assert.equal(required.length, 1);
  const url = contextViolations('src/lib/home/brandMedia.ts', "const file = new URL('../../docs/brand-media/static/held/poster.png', import.meta.url);\n", rules);
  assert.equal(url.length, 1);
  const dynamic = contextViolations(from, "const poster = await import('../../../docs/brand-media/static/held/poster.png');\n", rules);
  assert.equal(dynamic.length, 1);
  const comments = `
    // 说明见 docs/API.md，也见 docs/brand-media/static/held/poster.png
    /* import x from '../../../docs/brand-media/static/held/poster.png' */
    import { BRAND_MEDIA } from '@/lib/home/brandMedia';
  `;
  assert.deepEqual(contextViolations(from, comments, rules), []);
  assert.deepEqual(moduleSpecifiers(comments), ['@/lib/home/brandMedia']);
  assert.equal(resolveSpecifier(from, '@/lib/home/brandMedia'), 'src/lib/home/brandMedia');
});

test('同名目录规则不排除带扩展名的源码模块', () => {
  assert.equal(isDockerignored('src/lib/server/uploads.ts', rules), false);
  assert.equal(isDockerignored('src/lib/server/storage.ts', rules), false);
  assert.equal(isDockerignored('uploads/blob.bin', rules), true);
  assert.equal(isDockerignored('storage/blob.bin', rules), true);
  const source = "import { saveUpload } from '@/lib/server/uploads';\nimport { putObject } from '@/lib/server/storage';\n";
  assert.deepEqual(
    contextViolations('src/app/api/admin/cron/cleanup-uploads/route.ts', source, rules, root),
    [],
  );
});

test('检出里真实存在的 docs 资源被 import 时仍然算排除', () => {
  const source = "import cityStill from '../../../docs/brand-media/static/held/packjoyu-industrial-city-v3-loop-poster.png';\n";
  const hits = contextViolations('src/app/[locale]/page.tsx', source, rules, root);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].resolved.startsWith('docs/brand-media/'), true);
});

test('当前构建上下文源码没有引用被 .dockerignore 排除的文件', () => {
  const { files, violations } = checkImageContext(root);
  assert.ok(files > 10);
  assert.deepEqual(violations, []);
});
