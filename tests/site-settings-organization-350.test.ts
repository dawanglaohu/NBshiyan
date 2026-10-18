import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import type { Role, User } from '@prisma/client';
import {
  handleGetOrganization, handlePutOrganization, AUDIT_ORGANIZATION_UPDATE, OrganizationPutInput,
  type SiteSettingsDeps, type SiteSettingsStore, type CasResult,
} from '../src/lib/server/site-settings-admin';
import { isValidFoundingDate, safeOrgUrl, storedVersion } from '../src/lib/server/site-settings-model';

// #350 组织信息后台接口：内存存储 + 假鉴权，不连库
const admin = { id: 'u_admin', name: 'Ryan', role: 'ADMIN' } as User;

function deps(user: User | null = admin, init: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(init);
  const calls = { audit: [] as Parameters<SiteSettingsDeps['audit']>[0][], revalidate: 0 };
  const store: SiteSettingsStore = {
    async readMany(keys) { return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])); },
    async compareAndSet(key, expected, build): Promise<CasResult> {
      const cur = key in data ? structuredClone(data[key]) : null;
      const v = storedVersion(cur);
      if (expected !== null && v !== expected) return { status: 'conflict', currentVersion: v };
      const next = build(cur);
      if (next === null) return { status: 'ok', value: cur, changed: false };
      data[key] = structuredClone(next);
      return { status: 'ok', value: next, changed: true };
    },
  };
  const d: SiteSettingsDeps = {
    async requireAdmin(_req, roles: Role[]) {
      if (!user) return new Response('{"error":"unauthorized"}', { status: 401 });
      if (!roles.includes(user.role)) return new Response('{"error":"forbidden"}', { status: 403 });
      return { user, ip: null };
    },
    assertSameOrigin: () => null,
    enforceAdminRateLimit: async () => null,
    async readJson(req) { try { return JSON.parse(await req.text()); } catch { return null; } },
    store,
    async audit(e) { calls.audit.push(e); },
    revalidate() { calls.revalidate++; },
    async userNames(ids) { return Object.fromEntries(ids.filter((i) => i === admin.id).map((i) => [i, admin.name])); },
    // #350 图片 PR：默认把请求里的 id 都当作未删除的 PublicAsset（图片相关用例见 tests/public-asset-350.test.ts）
    async liveAssets(ids) { return ids.map((id) => ({ id, smWidth: 800, smHeight: 600, lgWidth: 1600, lgHeight: 1200 })); },
    // about.images 引用锁只在 about/images 和删除图片里用（用例见 tests/public-asset-350.test.ts、tests/asset-delete-race-350.test.ts）
    aboutImagesLock: { async run() { throw new Error('aboutImagesLock not used here'); } },
    now: () => new Date('2026-10-17T22:30:00-07:00'),
  };
  return { d, data, calls };
}
const put = (body: unknown) => new Request('http://localhost/api/admin/site-settings/organization', { method: 'PUT', body: JSON.stringify(body) });
const get = () => new Request('http://localhost/api/admin/site-settings/organization');

test('只有 ADMIN：SALES / EDITOR 403，未登录 401，不写库', async () => {
  for (const [u, s] of [[{ ...admin, role: 'SALES' } as User, 403], [{ ...admin, role: 'EDITOR' } as User, 403], [null, 401]] as const) {
    const { d, data } = deps(u);
    assert.equal((await handlePutOrganization(put({ expectedVersion: 0, name: 'X' }), d)).status, s);
    assert.equal((await handleGetOrganization(get(), d)).status, s);
    assert.deepEqual(data, {});
  }
});

test('保存：只存填了的字段，空串 = 不设置；审计只记字段名；GET 不带默认值', async () => {
  const { d, data, calls } = deps();
  const empty = await handleGetOrganization(get(), d);
  assert.deepEqual(await empty.json(), { version: 0, sameAs: [], updatedAt: null, updatedBy: null, updatedByName: null });
  const r = await handlePutOrganization(put({
    expectedVersion: 0, alternateName: ' 保乐优 ', description: '<b>Custom</b> packaging', legalName: '', email: 'sales@example.com',
    telephone: '+86 (755) 0000-0000', address: 'Street 1\nCity', foundingDate: '2015', logo: 'https://cdn.example.com/logo.png',
    sameAs: ['https://www.linkedin.com/company/x', 'https://www.linkedin.com/company/x', ''],
  }), d);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const stored = data['site.organization'] as Record<string, unknown>;
  assert.deepEqual({ ...stored, updatedAt: undefined }, {
    alternateName: '保乐优', description: 'Custom packaging', email: 'sales@example.com', telephone: '+86 (755) 0000-0000', address: 'Street 1 City',
    foundingDate: '2015', logo: 'https://cdn.example.com/logo.png', sameAs: ['https://www.linkedin.com/company/x'], version: 1, updatedAt: undefined, updatedBy: 'u_admin',
  });
  assert.ok(!('legalName' in stored) && !('name' in stored));
  assert.equal(calls.audit.length, 1);
  assert.equal(calls.audit[0].action, AUDIT_ORGANIZATION_UPDATE);
  assert.equal(AUDIT_ORGANIZATION_UPDATE, 'site.organization.update');
  assert.ok(!JSON.stringify(calls.audit).includes('sales@example.com') && !JSON.stringify(calls.audit).includes('Street'));
  assert.equal(calls.revalidate, 1);
  // 没有改动：200 changed false，不加版本、不记审计
  const same = await handlePutOrganization(put({ expectedVersion: 1, alternateName: '保乐优', description: 'Custom packaging', email: 'sales@example.com', telephone: '+86 (755) 0000-0000', address: 'Street 1 City', foundingDate: '2015', logo: 'https://cdn.example.com/logo.png', sameAs: ['https://www.linkedin.com/company/x'] }), d);
  assert.equal((await same.json()).changed, false);
  assert.equal(calls.audit.length, 1);
  // 整份替换：不传的字段被清掉
  await handlePutOrganization(put({ expectedVersion: 1, name: 'PackJoyU' }), d);
  assert.deepEqual(Object.keys(data['site.organization'] as object).sort(), ['name', 'sameAs', 'updatedAt', 'updatedBy', 'version']);
});

test('409：expectedVersion 不一致不覆盖', async () => {
  const { d } = deps(admin, { 'site.organization': { version: 2, name: 'A', sameAs: [] } });
  const r = await handlePutOrganization(put({ expectedVersion: 1, name: 'B' }), d);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'version_conflict', currentVersion: 2 });
});

test('校验：strict、长度、邮箱、电话、日期、URL；没有产能 / 认证类字段', async () => {
  const bad: Record<string, unknown>[] = [
    { capacity: '1000' }, { certifications: ['x'] }, { leadTime: '7' }, { employees: 1 }, { areaSqm: 1 },
    { name: 'x'.repeat(101) }, { description: 'x'.repeat(301) }, { address: 'x'.repeat(201) }, { email: 'no-at' },
    { telephone: 'call me' }, { foundingDate: '15-03-2015' }, { foundingDate: '2015-02-30' }, { foundingDate: '2999' },
    { logo: 'http://x.example/logo.png' }, { logo: 'javascript:alert(1)' }, { logo: '//evil.example/x.png' }, { sameAs: ['https://user:pw@x.example'] },
    { sameAs: Array.from({ length: 11 }, (_, i) => `https://x${i}.example`) },
  ];
  for (const b of bad) {
    const { d, data } = deps();
    const r = await handlePutOrganization(put({ expectedVersion: 0, ...b }), d);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.deepEqual(data, {});
  }
  assert.ok(OrganizationPutInput.safeParse({ expectedVersion: 0, name: '📦'.repeat(100) }).success, '按 code point 计');
  assert.equal(isValidFoundingDate('2015-03-01'), true);
  assert.equal(isValidFoundingDate('1799'), false);
  assert.equal(safeOrgUrl('/brand/logo.png', true), '/brand/logo.png');
  assert.equal(safeOrgUrl('/brand/logo.png'), null);
  assert.equal(safeOrgUrl('/\\evil', true), null);
});

test('路由文件存在且只接线', () => {
  const p = 'src/app/api/admin/site-settings/organization/route.ts';
  assert.ok(existsSync(p));
  const src = readFileSync(p, 'utf8');
  assert.match(src, /handleGetOrganization\(req, deps\)/);
  assert.match(src, /handlePutOrganization\(req, deps\)/);
  assert.match(src, /=> requireAdmin\(req, roles\)/);
});

test('#367 review P3：logo 站内路径拒绝点段；写入和读出用同一个邮箱规则', async () => {
  const { safeOrgUrl, ORG_EMAIL_RE } = await import('../src/lib/server/site-settings-model');
  for (const s of ['/a/../logo.png', '/./logo.png', '/%2e%2e/logo.png', '/a/%2E/logo.png']) assert.equal(safeOrgUrl(s, true), null, s);
  assert.equal(safeOrgUrl('/images/logo.v2.png', true), '/images/logo.v2.png');
  assert.ok(ORG_EMAIL_RE.test('sales@example.com'));
  assert.ok(!ORG_EMAIL_RE.test('a"b@example.com'));
});
