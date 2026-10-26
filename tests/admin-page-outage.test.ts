import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';

(globalThis as { React?: unknown }).React = React;
(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;

const secret = process.env.AUTH_SECRET || 'guard-503-test-secret-32bytes!!';
process.env.AUTH_SECRET = secret;

type FailMode = 'down' | 'unknown';
let mode: FailMode = 'down';

function fail(): never {
  if (mode === 'unknown') throw new Error('unexpected session fault');
  const error = new Error('database unreachable');
  error.name = 'PrismaClientKnownRequestError';
  throw Object.assign(error, { code: 'P1001' });
}

(globalThis as { prisma?: unknown }).prisma = {
  user: { findUnique: async () => fail() },
  adminDeviceSession: { findUnique: async () => fail() },
};

const PAGE_FILES = [
  'src/app/admin/inquiries/page.tsx',
  'src/app/admin/inquiries/[id]/page.tsx',
  'src/app/admin/mail/unassigned/page.tsx',
  'src/app/admin/models/new/page.tsx',
  'src/app/admin/settings/page.tsx',
  'src/app/admin/specs/page.tsx',
  'src/app/admin/specs/[category]/page.tsx',
  'src/app/admin/users/page.tsx',
];

function adminPages(): string[] {
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === 'page.tsx') pages.push(path.split('\\').join('/'));
    }
  };
  walk('src/app/admin');
  return pages;
}

test('503 scan: every enforceAdminPage page returns the notice', () => {
  const callers = adminPages().filter((file) => readFileSync(file, 'utf8').includes('enforceAdminPage('));
  assert.deepEqual([...callers].sort(), [...PAGE_FILES].sort());
  const gate = readFileSync('src/lib/server/admin/page-access.ts', 'utf8');
  assert.match(gate, /check\.reason === 'unavailable'/);
  assert.match(gate, /g\.action === 'internal' \? 'internal' : 'unavailable'/);
  assert.doesNotMatch(gate, /return 'unavailable'/);
  assert.doesNotMatch(gate, /return null/);
  for (const file of callers) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /const gate = await enforceAdminPage\(/, file);
    assert.match(src, /if \(!gate\.ok\) return gate\.notice/, file);
    assert.equal(src.includes('return null'), false, file);
  }
});

test('500 scan: an internal fault uses the same notice return', () => {
  const gate = readFileSync('src/lib/server/admin/page-access.ts', 'utf8');
  assert.match(gate, /check\.reason === 'internal'/);
  assert.match(gate, /action: 'internal'/);
  const guard = readFileSync('src/lib/server/admin/guard.ts', 'utf8');
  assert.match(guard, /return \{ ok: false, reason: 'internal', status: 500 \}/);
  const device = readFileSync('src/lib/server/admin/device-session.ts', 'utf8');
  assert.match(device, /isDbUnavailable\(error\)/);
  assert.match(device, /return \{ ok: false, reason: 'internal', status: 500 \}/);
  for (const file of PAGE_FILES) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /if \(!gate\.ok\) return gate\.notice/, file);
  }
});

test('notice href stays on this admin page', async () => {
  const { adminNoticeHref } = await import('../src/lib/server/admin/page-access');
  for (const bad of ['//evil.com', 'https://evil.example/admin', 'http://evil.example', '/\\evil', 'javascript:alert(1)', '/admin/../users', '/admin/%2e%2e/users', '/admin/%2f%2fevil.com', '', '/users', 'https://evil.example']) {
    assert.equal(adminNoticeHref(bad), '/admin', bad);
  }
  assert.equal(adminNoticeHref('/admin/settings?section=org#x'), '/admin/settings');
  assert.equal(adminNoticeHref('/admin/inquiries/abc'), '/admin/inquiries/abc');
  assert.equal(adminNoticeHref('/admin'), '/admin');
});

type PageNode = React.ReactElement;

async function inRequest<T>(run: () => Promise<T>): Promise<T> {
  const { workAsyncStorage } = await import('next/dist/server/app-render/work-async-storage.external.js');
  const { workUnitAsyncStorage } = await import('next/dist/server/app-render/work-unit-async-storage.external.js');
  const { HeadersAdapter } = await import('next/dist/server/web/spec-extension/adapters/headers.js');
  const { encode } = await import('next-auth/jwt');
  const token = await encode({
    secret, salt: 'authjs.session-token', maxAge: 3600,
    token: { sub: 'user-1', uid: 'user-1', sv: 3, sid: 'device-1' },
  });
  const headers = HeadersAdapter.seal(new Headers({
    cookie: `authjs.session-token=${token}`,
    'accept-language': 'zh-CN,zh;q=0.9',
    host: 'evil.example',
    referer: 'https://evil.example/phish',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-proto': 'https',
    'x-admin-path': '//evil.com',
  }));
  const work = { isStaticGeneration: false, page: '/admin', route: '/admin', forceStatic: false };
  const unit = { type: 'request' as const, phase: 'render' as const, headers, implicitTags: { tags: [] } };
  return workAsyncStorage.run(work as never, () => workUnitAsyncStorage.run(unit as never, run));
}

let pagesReady = false;
const loaded: { href: string; render: () => Promise<PageNode> }[] = [];

before(async () => {
  const require = createRequire(import.meta.url);
  const extensions = (require('node:module') as { _extensions: Record<string, (module: NodeModule & { _compile: (code: string, filename: string) => void }, filename: string) => void> })._extensions;
  extensions['.css'] = (module, filename) => { module._compile('module.exports = {};', filename); };
  const inquiries = (await import('../src/app/admin/inquiries/page')).default;
  const inquiryId = (await import('../src/app/admin/inquiries/[id]/page')).default;
  const mail = (await import('../src/app/admin/mail/unassigned/page')).default;
  const models = (await import('../src/app/admin/models/new/page')).default;
  const settings = (await import('../src/app/admin/settings/page')).default;
  const specs = (await import('../src/app/admin/specs/page')).default;
  const specCategory = (await import('../src/app/admin/specs/[category]/page')).default;
  const users = (await import('../src/app/admin/users/page')).default;
  loaded.push(
    { href: '/admin/inquiries', render: () => inquiries() },
    { href: '/admin/inquiries/abc', render: () => inquiryId({ params: Promise.resolve({ id: 'abc' }) }) },
    { href: '/admin/mail/unassigned', render: () => mail() },
    { href: '/admin/models/new', render: () => models() },
    { href: '/admin/settings', render: () => settings({ searchParams: Promise.resolve({}) }) },
    { href: '/admin/specs', render: () => specs() },
    { href: '/admin/specs/corrugated-boxes', render: () => specCategory({ params: Promise.resolve({ category: 'corrugated-boxes' }) }) },
    { href: '/admin/users', render: () => users() },
  );
  pagesReady = true;
});

async function assertCards(body: RegExp, other: RegExp) {
  assert.equal(pagesReady, true);
  const { renderToStaticMarkup } = await import('react-dom/server');
  for (const page of loaded) {
    const node = await inRequest(page.render);
    assert.ok(node, page.href);
    const html = renderToStaticMarkup(node);
    assert.match(html, /role="alert"/, page.href);
    assert.match(html, /lang="zh-CN"/, page.href);
    assert.match(html, body, page.href);
    assert.doesNotMatch(html, other, page.href);
    assert.match(html, new RegExp(`href="${page.href}"`), page.href);
    assert.equal(html.includes('evil'), false, page.href);
    assert.equal(html.includes('signin'), false, page.href);
  }
}

test('503 render: all eight admin pages show the database card', async () => {
  mode = 'down';
  await assertCards(/数据库连接出现问题，这不会让你退出登录，请稍后重试。/, /服务暂时出错/);
});

test('500 render: all eight admin pages show the internal card', async () => {
  mode = 'unknown';
  await assertCards(/服务暂时出错，这不会让你退出登录，请稍后重试。/, /数据库连接出现问题/);
});
