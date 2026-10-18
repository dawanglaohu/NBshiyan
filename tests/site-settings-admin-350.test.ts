import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Role, User } from '@prisma/client';
import {
  handleGetAbout, handlePutAboutLocale, handlePutAboutEnabled, AUDIT_ABOUT_UPDATE, AUDIT_ABOUT_VISIBILITY,
  type SiteSettingsDeps, type SiteSettingsStore, type CasResult,
} from '../src/lib/server/site-settings-admin';
import { storedVersion } from '../src/lib/server/site-settings-model';

// #350 后台接口逻辑：依赖全部注入（内存存储 + 假鉴权），不连库
const admin = { id: 'u_admin', name: 'Ryan', role: 'ADMIN' } as User;
const sales = { id: 'u_sales', name: 'S', role: 'SALES' } as User;

/** 内存存储：同一个键的 compareAndSet 串行执行（模拟 SELECT … FOR UPDATE），读和写之间让出事件循环 */
function memStore(init: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(init);
  const locks = new Map<string, Promise<unknown>>();
  const store: SiteSettingsStore = {
    async readMany(keys) { return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])); },
    compareAndSet(key, expected, build) {
      const run = async (): Promise<CasResult> => {
        const cur = key in data ? structuredClone(data[key]) : null;
        await new Promise((r) => setImmediate(r));
        const v = storedVersion(cur);
        if (expected !== null && v !== expected) return { status: 'conflict', currentVersion: v };
        const next = build(cur);
        if (next === null) return { status: 'ok', value: cur, changed: false };
        data[key] = structuredClone(next);
        return { status: 'ok', value: next, changed: true };
      };
      const p = (locks.get(key) ?? Promise.resolve()).then(run, run);
      locks.set(key, p.catch(() => {}));
      return p;
    },
  };
  return { data, store };
}

function deps(over: Partial<SiteSettingsDeps> & { user?: User | null; originOk?: boolean; limited?: boolean } = {}) {
  const calls = { audit: [] as Parameters<SiteSettingsDeps['audit']>[0][], revalidate: 0, order: [] as string[] };
  const mem = memStore();
  const user = over.user === undefined ? admin : over.user;
  const d: SiteSettingsDeps = {
    async requireAdmin(_req, roles: Role[]) {
      calls.order.push('auth');
      if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      if (!roles.includes(user.role)) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
      return { user, ip: '203.0.113.9' };
    },
    assertSameOrigin() { calls.order.push('origin'); return over.originOk === false ? new Response(JSON.stringify({ error: 'forbidden_origin' }), { status: 403 }) : null; },
    async enforceAdminRateLimit() { calls.order.push('rate'); return over.limited ? new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }) : null; },
    async readJson(req) { calls.order.push('read'); try { return JSON.parse(await req.text()); } catch { return null; } },
    store: mem.store,
    async audit(e) { calls.audit.push(e); },
    revalidate() { calls.revalidate++; },
    async userNames(ids) { return Object.fromEntries(ids.filter((i) => i === admin.id).map((i) => [i, admin.name])); },
    now: () => new Date('2026-10-17T22:30:00-07:00'),
    ...over,
  };
  return { d, calls, mem };
}

const BODY = '<h2>About</h2><p>We run our own factory and do quality control in house for every order.</p>';
const valid = (o: Record<string, unknown> = {}) => ({ expectedVersion: 0, title: 'About PackJoyU', summary: 'Packaging maker', bodyHtml: BODY, stats: [{ label: 'Lines', value: '00' }], home: { title: 'Our factory', intro: 'Intro' }, ...o });
const put = (body: unknown) => new Request('http://localhost/api/admin/site-settings/about/en', { method: 'PUT', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const json = async (r: Response) => ({ status: r.status, body: await r.json(), cache: r.headers.get('cache-control') });

test('角色：SALES / EDITOR 403，未登录 401，鉴权在所有其他检查之前', async () => {
  for (const [user, status] of [[sales, 403], [{ ...sales, role: 'EDITOR' } as User, 403], [null, 401]] as const) {
    const { d, calls, mem } = deps({ user });
    assert.equal((await handlePutAboutLocale(put(valid()), 'en', d)).status, status);
    assert.equal((await handlePutAboutEnabled(put({ enabled: true }), d)).status, status);
    assert.equal((await handleGetAbout(new Request('http://localhost/x'), d)).status, status);
    assert.deepEqual([...new Set(calls.order)], ['auth']);
    assert.deepEqual(mem.data, {});
  }
});

test('同源失败 403、限流 429：都不读请求体、不写库；顺序 auth → origin → rate → read', async () => {
  const a = deps({ originOk: false });
  assert.equal((await handlePutAboutLocale(put(valid()), 'en', a.d)).status, 403);
  assert.equal((await handlePutAboutEnabled(put({ enabled: true }), a.d)).status, 403);
  assert.ok(!a.calls.order.includes('read') && !a.calls.order.includes('rate'));
  const b = deps({ limited: true });
  assert.equal((await handlePutAboutLocale(put(valid()), 'en', b.d)).status, 429);
  assert.ok(!b.calls.order.includes('read'));
  const c = deps();
  await handlePutAboutLocale(put(valid()), 'en', c.d);
  assert.deepEqual(c.calls.order, ['auth', 'origin', 'rate', 'read']);
  assert.deepEqual(a.mem.data, {}); assert.deepEqual(b.mem.data, {});
});

test('语言按 routing.locales 校验：不在列表里 400 invalid_locale（在读请求体之前）', async () => {
  for (const l of ['xx', 'EN', 'en-US', 'zh', '', 'enabled', '../en']) {
    const { d, calls } = deps();
    const r = await json(await handlePutAboutLocale(put(valid()), l, d));
    assert.equal(r.status, 400, l); assert.equal(r.body.error, 'invalid_locale');
    assert.ok(!calls.order.includes('read'));
  }
  const { d } = deps();
  assert.equal((await handlePutAboutLocale(put(valid()), 'ru', d)).status, 200);
});

test('zod .strict()：多余字段、类型错误、缺字段、非 JSON 一律 400 invalid', async () => {
  for (const b of [valid({ extra: 1 }), valid({ version: 3 }), valid({ updatedBy: 'x' }), valid({ expectedVersion: -1 }), valid({ expectedVersion: 1.5 }), valid({ expectedVersion: '0' }),
    valid({ home: { title: '', intro: '', x: 1 } }), valid({ stats: [{ label: 'a', value: 'b', k: 1 }] }), valid({ imageMeta: { abc: { alt: 'a', caption: '', src: 'x' } } }),
    { title: 't', bodyHtml: BODY }, null, [], 'x']) {
    const { d, mem } = deps();
    const r = await json(await handlePutAboutLocale(put(b), 'en', d));
    assert.equal(r.status, 400, JSON.stringify(b)); assert.equal(r.body.error, 'invalid'); assert.equal(r.cache, 'no-store');
    assert.deepEqual(mem.data, {});
  }
  const { d } = deps();
  const e = await json(await handlePutAboutEnabled(put({ enabled: 'yes' }), d));
  assert.equal(e.status, 400);
  assert.equal((await handlePutAboutEnabled(put({ enabled: true, x: 1 }), d)).status, 400);
});

test('长度上限（定稿 v1.0）：标题 80、摘要 160、正文 HTML 30KB / 纯文本 6000、数字 4 个（标签 40 / 数值 12）、首页标题 60 / 简介 300、图片说明', async () => {
  const over: Record<string, unknown>[] = [
    { title: 'a'.repeat(81) }, { title: 'a' }, { summary: 's'.repeat(161) }, { bodyHtml: 'x'.repeat(30 * 1024 + 1) }, { bodyHtml: `<p>${'я'.repeat(6001)}</p>` },
    { stats: Array.from({ length: 5 }, () => ({ label: 'l', value: '1' })) }, { stats: [{ label: 'l'.repeat(41), value: '1' }] }, { stats: [{ label: 'l', value: '1'.repeat(13) }] },
    { stats: [{ label: '<b></b>', value: '1' }] }, { stats: [{ label: '', value: '1' }] },
    { home: { title: 'h'.repeat(61), intro: '' } }, { home: { title: '', intro: 'i'.repeat(301) } },
    { imageMeta: { a1: { alt: 'a'.repeat(126), caption: '' } } }, { imageMeta: { a1: { alt: 'a', caption: 'c'.repeat(81) } } },
    { imageMeta: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`img${i}`, { alt: 'a', caption: '' }])) }, { imageMeta: { 'bad id!': { alt: 'a', caption: '' } } },
  ];
  for (const o of over) {
    const { d, mem } = deps();
    assert.equal((await handlePutAboutLocale(put(valid(o)), 'en', d)).status, 400, JSON.stringify(o).slice(0, 80));
    assert.deepEqual(mem.data, {});
  }
  const ok: Record<string, unknown>[] = [{ title: 'a'.repeat(80) }, { title: '' }, { summary: 's'.repeat(160) }, { bodyHtml: `<p>${'я'.repeat(6000)}</p>` },
    { stats: Array.from({ length: 4 }, () => ({ label: 'l'.repeat(40), value: '1'.repeat(12) })) }, { home: { title: 'h'.repeat(60), intro: 'i'.repeat(300) } },
    { imageMeta: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`img${i}`, { alt: 'a'.repeat(125), caption: 'c'.repeat(80) }])) }];
  for (const o of ok) { const { d } = deps(); assert.equal((await handlePutAboutLocale(put(valid(o)), 'en', d)).status, 200, JSON.stringify(o).slice(0, 80)); }
});

test('保存：入库前净化正文和纯文本字段，记录 version / updatedAt / updatedBy；响应 no-store', async () => {
  const { d, mem } = deps();
  const r = await json(await handlePutAboutLocale(put(valid({ title: '<b>About</b>\u0000 us', bodyHtml: BODY + '<p onclick="x"><a href="javascript:alert(1)">bad</a><script>x</script></p>' })), 'en', d));
  assert.equal(r.status, 200); assert.equal(r.cache, 'no-store');
  const s = mem.data['about.en'] as Record<string, unknown>;
  assert.equal(s.title, 'About us');
  assert.equal(s.bodyHtml, BODY + '<p>bad</p>');
  assert.equal(s.version, 1); assert.equal(s.updatedBy, admin.id); assert.equal(s.updatedAt, '2026-10-18T05:30:00.000Z');
  assert.equal(r.body.content.version, 1); assert.equal(r.body.content.updatedByName, 'Ryan'); assert.equal(r.body.changed, true);
});

test('版本：expectedVersion 不一致 409 version_conflict + currentVersion，不覆盖；一致则 +1', async () => {
  const { d, mem, calls } = deps();
  assert.equal((await handlePutAboutLocale(put(valid()), 'en', d)).status, 200);
  const stale = await json(await handlePutAboutLocale(put(valid({ title: 'Other title' })), 'en', d));
  assert.equal(stale.status, 409); assert.deepEqual(stale.body, { error: 'version_conflict', currentVersion: 1 }); assert.equal(stale.cache, 'no-store');
  assert.equal((mem.data['about.en'] as { title: string }).title, 'About PackJoyU');
  const ok = await json(await handlePutAboutLocale(put(valid({ expectedVersion: 1, title: 'Other title' })), 'en', d));
  assert.equal(ok.status, 200); assert.equal(ok.body.content.version, 2);
  assert.equal((await handlePutAboutLocale(put(valid({ expectedVersion: 5 })), 'en', d)).status, 409);
  assert.equal(calls.audit.length, 2); assert.equal(calls.revalidate, 2);
});

test('并发：两个管理员同时以 expectedVersion 0 保存同一语言，只有一个成功，另一个 409', async () => {
  const { d, mem, calls } = deps();
  const [a, b] = await Promise.all([handlePutAboutLocale(put(valid({ title: 'Title A' })), 'en', d), handlePutAboutLocale(put(valid({ title: 'Title B' })), 'en', d)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.deepEqual(await loser.json(), { error: 'version_conflict', currentVersion: 1 });
  assert.equal((mem.data['about.en'] as { version: number }).version, 1);
  assert.equal(calls.audit.length, 1);
  // 不同语言互不影响
  const [e, r] = await Promise.all([handlePutAboutLocale(put(valid({ expectedVersion: 1, title: 'EN 2' })), 'en', d), handlePutAboutLocale(put(valid()), 'ru', d)]);
  assert.deepEqual([e.status, r.status], [200, 200]);
});

test('审计：只记 {locale, fields, version}，不含任何内容；没改动不写库、不审计、不刷新', async () => {
  const { d, calls } = deps();
  await handlePutAboutLocale(put(valid({ summary: 'SECRET-SUMMARY' })), 'en', d);
  await handlePutAboutLocale(put(valid({ expectedVersion: 1, summary: 'SECRET-SUMMARY', title: 'New title SECRET' })), 'en', d);
  assert.equal(calls.audit.length, 2);
  assert.deepEqual(calls.audit[0], { actorId: admin.id, action: AUDIT_ABOUT_UPDATE, target: 'about.en', meta: { locale: 'en', fields: ['title', 'summary', 'bodyHtml', 'stats', 'home'], version: 1 }, ip: '203.0.113.9' });
  assert.deepEqual(calls.audit[1].meta, { locale: 'en', fields: ['title'], version: 2 });
  const dump = JSON.stringify(calls.audit);
  for (const s of ['SECRET', 'About PackJoyU', 'quality control', 'Lines', 'Our factory']) assert.ok(!dump.includes(s), s);
  const same = await json(await handlePutAboutLocale(put(valid({ expectedVersion: 2, summary: 'SECRET-SUMMARY', title: 'New title SECRET' })), 'en', d));
  assert.equal(same.status, 200); assert.equal(same.body.changed, false); assert.equal(same.body.content.version, 2);
  assert.equal(calls.audit.length, 2); assert.equal(calls.revalidate, 2);
});

test('开关：单独保存，审计 site.about.visibility，带 expectedVersion 时比对；每次改动都刷新缓存', async () => {
  const { d, mem, calls } = deps();
  const on = await json(await handlePutAboutEnabled(put({ enabled: true }), d));
  assert.equal(on.status, 200); assert.deepEqual({ enabled: on.body.enabled, version: on.body.version, changed: on.body.changed }, { enabled: true, version: 1, changed: true });
  assert.deepEqual(mem.data['about.enabled'], { enabled: true, version: 1, updatedAt: '2026-10-18T05:30:00.000Z', updatedBy: admin.id });
  assert.equal((await handlePutAboutEnabled(put({ enabled: false, expectedVersion: 0 }), d)).status, 409);
  assert.equal((await json(await handlePutAboutEnabled(put({ enabled: true }), d))).body.changed, false);
  assert.equal((await handlePutAboutEnabled(put({ enabled: false, expectedVersion: 1 }), d)).status, 200);
  assert.deepEqual(calls.audit.map((a) => [a.action, a.meta]), [[AUDIT_ABOUT_VISIBILITY, { fields: ['enabled'], enabled: true, version: 1 }], [AUDIT_ABOUT_VISIBILITY, { fields: ['enabled'], enabled: false, version: 2 }]]);
  assert.equal(calls.revalidate, 2);
});

test('GET：返回开关和所有站点语言（没有内容为 null），读出时再净化；修改人已删除时 updatedByName 为 null', async () => {
  const { d, mem } = deps();
  Object.assign(mem.data, {
    'about.enabled': true,
    'about.ru': { version: 3, title: 'О компании', summary: '', bodyHtml: '<p onclick="x">т<script>1</script><a href="//evil.com">e</a></p>', stats: [], home: { title: '', intro: '' }, imageMeta: {}, updatedAt: 't', updatedBy: 'gone' },
  });
  const r = await json(await handleGetAbout(new Request('http://localhost/api/admin/site-settings/about'), d));
  assert.equal(r.status, 200); assert.equal(r.cache, 'no-store');
  assert.equal(r.body.enabled, true);
  assert.deepEqual(Object.keys(r.body.locales), ['en', 'ru']);
  assert.equal(r.body.locales.en, null);
  assert.equal(r.body.locales.ru.bodyHtml, '<p>тe</p>');
  assert.equal(r.body.locales.ru.version, 3); assert.equal(r.body.locales.ru.updatedByName, null);
});

test('Prisma 存储：事务内 SELECT … FOR UPDATE 锁行；并发新建的主键冲突 P2002 → 409', () => {
  const src = readFileSync('src/lib/server/site-settings-admin.ts', 'utf8');
  assert.match(src, /\$transaction\(async \(tx\) =>/);
  assert.match(src, /SELECT "value"::text AS "value" FROM "SiteSetting" WHERE "key" = \$\{key\} FOR UPDATE/);
  assert.match(src, /e\.code === 'P2002'[\s\S]{0,200}status: 'conflict'/);
  for (const f of ['src/app/api/admin/site-settings/about/route.ts', 'src/app/api/admin/site-settings/about/[locale]/route.ts', 'src/app/api/admin/site-settings/about/enabled/route.ts'])
    assert.match(readFileSync(f, 'utf8'), /siteSettingsDeps\)/, f);
  assert.match(readFileSync('src/lib/server/site-settings-admin-deps.ts', 'utf8'), /revalidateTag\(SITE_SETTINGS_TAG\);\s*revalidatePath\('\/sitemap\.xml'\);/);
});

test('Prisma 存储（假 tx）：版本不一致不写；一致时 create / update；P2002 → conflict', async () => {
  const { prismaSiteSettingsStore } = await import('../src/lib/server/site-settings-admin');
  const { Prisma } = await import('@prisma/client');
  const writes: string[] = [];
  let row: { value: unknown } | null = null;
  let failCreate = false;
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => { assert.match(strings.join('?'), /FOR UPDATE/); return row ? [{ value: JSON.stringify(row.value) }] : []; },
    siteSetting: {
      create: async (a: { data: { value: unknown } }) => { if (failCreate) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }); writes.push('create'); row = { value: a.data.value }; },
      update: async (a: { data: { value: unknown } }) => { writes.push('update'); row = { value: a.data.value }; },
    },
  };
  const db = {
    siteSetting: { findMany: async () => [], findUnique: async () => ({ key: 'k', value: { version: 7 } }) },
    $transaction: async <T,>(fn: (t: never) => Promise<T>) => fn(tx as never),
  };
  const s = prismaSiteSettingsStore(db);
  assert.deepEqual(await s.compareAndSet('k', 1, () => ({ version: 1 })), { status: 'conflict', currentVersion: 0 });
  assert.equal((await s.compareAndSet('k', 0, () => ({ version: 1 }))).status, 'ok');
  assert.equal((await s.compareAndSet('k', 1, () => ({ version: 2 }))).status, 'ok');
  assert.deepEqual(await s.compareAndSet('k', 1, () => ({ version: 2 })), { status: 'conflict', currentVersion: 2 });
  assert.deepEqual(writes, ['create', 'update']);
  row = null; failCreate = true;
  assert.deepEqual(await s.compareAndSet('k', 0, () => ({ version: 1 })), { status: 'conflict', currentVersion: 7 });
});
