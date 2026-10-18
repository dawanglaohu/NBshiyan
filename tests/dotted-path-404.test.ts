import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

// next.config.ts 的兜底 rewrite：绕过 middleware 的带点路径（不是真实文件）改到 /en/__not-found，返回 404 而不是 500
const cfg = readFileSync('next.config.ts', 'utf8');
const prefix = /const NO_DOT_REWRITE = '([^']+)'/.exec(cfg)?.[1];
const source = `/:path((?!${prefix}).*\\..*)`;
const match = getPathMatch(source, { removeUnnamedParams: true, strict: true });

test('rewrite is registered after the IndexNow key rewrite, destination fixed', () => {
  assert.ok(prefix);
  assert.match(cfg, /source: `\/:path\(\(\?!\$\{NO_DOT_REWRITE\}\)\.\*\\\\\.\.\*\)`, destination: '\/en\/__not-found'/);
  assert.ok(cfg.indexOf('/api/indexnow-key/:file') < cfg.indexOf("destination: '/en/__not-found'"));
});

test('dotted unknown root paths match (-> 404)', () => {
  for (const p of ['/nope.png', '/manifest.webmanifest', '/evil.com', '/%2F%2Fevil.com', '/%5Cevil.com', '/%5C%5Cevil.com', '/en.png', '/models/nope.glb', '/images/nope.png', '/a/b/c.js', '/foo.bar/baz'])
    assert.ok(match(p), p);
});

test('locale, api, admin, _next, s and undotted paths are not touched', () => {
  for (const p of ['/en/nope.png', '/ru/a.b', '/api/models/x/y.glb', '/api/indexnow-key/k.txt', '/admin/x.y', '/_next/static/a.js', '/s/a.b', '/', '/products', '/en', '/s/abc'])
    assert.equal(match(p), false, p);
});
