// #350（#374 安全审查 P3）删除图片 / 保存 about.images 的竞态：两条路径都在同一个事务里先拿 about.images 引用锁再检查、写入。
// 用真实的 prisma 适配器（prismaAboutImagesLock / prismaSiteSettingsStore / prismaPublicAssetRepo）跑在一个内存「数据库」上：
// pg_advisory_xact_lock 和 SELECT … FOR UPDATE 都按 Postgres 语义建模（事务结束才释放；FOR UPDATE 只锁存在的行，行不存在锁不到任何东西）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, User } from '@prisma/client';
import { handleDeleteAsset, prismaPublicAssetRepo, type PublicAssetDeps, type PublicAssetRow } from '../src/lib/server/public-assets-admin';
import { handlePutAboutImages, prismaSiteSettingsStore, type SiteSettingsDeps } from '../src/lib/server/site-settings-admin';
import { prismaAboutImagesLock, ABOUT_IMAGES_LOCK } from '../src/lib/server/about-images-lock';

const admin = { id: 'u_admin', name: 'Ryan', role: 'ADMIN' } as User;
const NOW = new Date('2026-10-18T02:00:00-07:00');
const X = 'RaceAsset000000000000001';
const Y = 'RaceAsset000000000000002';
const tick = () => new Promise<void>((r) => setImmediate(r));
const ticks = async (n: number) => { for (let i = 0; i < n; i++) await tick(); };

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    return release;
  }
}

type Hook = (() => Promise<void>) | null;
function fakeDb(init: { settings?: Record<string, unknown>; assets?: string[] } = {}) {
  const settings = new Map<string, unknown>(Object.entries(structuredClone(init.settings ?? {})));
  const assets = new Map<string, PublicAssetRow>((init.assets ?? []).map((id) => [id, {
    id, kind: 'about', smKey: `k/${id}-sm.webp`, smWidth: 800, smHeight: 600, smBytes: 1, lgKey: `k/${id}-lg.webp`, lgWidth: 1600, lgHeight: 1200, lgBytes: 1,
    bytes: 1, sha256: 'x', createdBy: null, createdAt: NOW, deletedAt: null, deletedBy: null,
  }]));
  const advisory = new Map<string, Mutex>();
  const rowLocks = new Map<string, Mutex>();
  const mutex = (m: Map<string, Mutex>, k: string) => { if (!m.has(k)) m.set(k, new Mutex()); return m.get(k)!; };
  const log: string[] = [];
  /** 第一次读 about.images（任何方式）/ 第一次按 id 查未删除图片时调用一次，用来在检查和写入之间插入另一个请求 */
  const hooks: { settingsRead: Hook; assetRead: Hook } = { settingsRead: null, assetRead: null };
  const fire = async (k: keyof typeof hooks) => { const h = hooks[k]; if (h) { hooks[k] = null; await h(); } };
  let txSeq = 0;

  const tables = (tag: string) => ({
    siteSetting: {
      async findMany({ where }: { where: { key: { in: string[] } } }) {
        log.push(`${tag}:siteSetting.findMany`);
        await tick();
        const out = where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: structuredClone(settings.get(k)) }));
        if (where.key.in.includes('about.images')) await fire('settingsRead');
        return out;
      },
      async findUnique({ where }: { where: { key: string } }) { return settings.has(where.key) ? { key: where.key, value: structuredClone(settings.get(where.key)) } : null; },
      async update({ where, data }: { where: { key: string }; data: { value: unknown } }) { log.push(`${tag}:siteSetting.update`); await tick(); settings.set(where.key, structuredClone(data.value)); return {}; },
      async create({ data }: { data: { key: string; value: unknown } }) { log.push(`${tag}:siteSetting.create`); await tick(); settings.set(data.key, structuredClone(data.value)); return {}; },
    },
    publicAsset: {
      async findMany({ where }: { where: { id: { in: string[] }; deletedAt: null } }) {
        log.push(`${tag}:publicAsset.findMany`);
        await tick();
        const out = where.id.in.map((i) => assets.get(i)).filter((r): r is PublicAssetRow => !!r && !r.deletedAt).map((r) => ({ ...r }));
        await fire('assetRead');
        return out;
      },
      async findFirst() { return null; },
      async create() { throw new Error('not used'); },
      async updateMany({ where, data }: { where: { id: string; deletedAt: null }; data: { deletedAt: Date; deletedBy: string } }) {
        log.push(`${tag}:publicAsset.updateMany`);
        await tick();
        const r = assets.get(where.id);
        if (!r || r.deletedAt) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
      async findUnique({ where }: { where: { id: string } }) { const r = assets.get(where.id); return r ? { ...r } : null; },
    },
  });

  const db = {
    ...tables('db'),
    async $transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const tag = `tx${++txSeq}`;
      const held: (() => void)[] = [];
      log.push(`${tag}:begin`);
      const tx = {
        ...tables(tag),
        async $executeRaw(s: TemplateStringsArray, ...v: unknown[]) {
          const sql = s.join('?');
          const m = /^SELECT pg_advisory_xact_lock\(hashtext\(\?\)\)$/.test(sql);
          assert.ok(m, `unexpected $executeRaw: ${sql}`);
          log.push(`${tag}:advisory(${String(v[0])})`);
          held.push(await mutex(advisory, String(v[0])).acquire());
          return 1;
        },
        async $queryRaw(s: TemplateStringsArray, ...v: unknown[]) {
          const sql = s.join('?');
          assert.match(sql, /^SELECT "value"::text AS "value" FROM "SiteSetting" WHERE "key" = \? FOR UPDATE$/);
          const key = String(v[0]);
          log.push(`${tag}:forUpdate(${key})`);
          if (settings.has(key)) held.push(await mutex(rowLocks, key).acquire()); // 行不存在：FOR UPDATE 什么也锁不住
          await tick();
          const out = settings.has(key) ? [{ value: JSON.stringify(settings.get(key)) }] : [];
          if (key === 'about.images') await fire('settingsRead');
          return out;
        },
      };
      try { return await fn(tx as never); } finally { log.push(`${tag}:commit`); held.reverse().forEach((r) => r()); }
    },
  };
  return { db, settings, assets, log, hooks };
}

function deps(f: ReturnType<typeof fakeDb>) {
  const requireAdmin = async (_r: Request, roles: Role[]) => (roles.includes(admin.role) ? { user: admin, ip: null } : new Response('{}', { status: 403 }));
  const storageDeletes: string[] = [];
  const common = { requireAdmin, assertSameOrigin: () => null, enforceAdminRateLimit: async () => null, audit: async () => {}, revalidate: () => {}, now: () => NOW };
  const lock = prismaAboutImagesLock(f.db as never);
  const asset: PublicAssetDeps = {
    ...common,
    enforceAdminUserRateLimit: async () => null,
    storage: { async put() {}, async delete(k) { f.log.push(`storage.delete(${k})`); storageDeletes.push(k); } },
    repo: prismaPublicAssetRepo(f.db as never),
    settings: prismaSiteSettingsStore(f.db as never),
    aboutImagesLock: lock,
    newId: () => 'x',
  };
  const site: SiteSettingsDeps = {
    ...common,
    async readJson(req) { return JSON.parse(await req.text()); },
    store: prismaSiteSettingsStore(f.db as never),
    userNames: async () => ({}),
    liveAssets: (ids) => (ids.length ? f.db.publicAsset.findMany({ where: { id: { in: ids }, deletedAt: null } }) : Promise.resolve([])),
    aboutImagesLock: lock,
  };
  return { asset, site, storageDeletes };
}
const del = (d: PublicAssetDeps, id: string) => handleDeleteAsset(new Request('http://localhost/x', { method: 'DELETE' }), id, d);
const save = (d: SiteSettingsDeps, ids: string[], expectedVersion: number) => handlePutAboutImages(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify({ expectedVersion, ids }) }), d);
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const imagesWith = (ids: string[]) => ({ version: 1, items: ids.map((id) => ({ id, sm: { w: 800, h: 600 }, lg: { w: 1600, h: 1200 } })), updatedAt: 't', updatedBy: null });
const storedIds = (f: ReturnType<typeof fakeDb>) => ((f.settings.get('about.images') as { items?: { id: string }[] } | undefined)?.items ?? []).map((i) => i.id);
/** 一个 tx 的日志（去掉 tag 前缀） */
const txLog = (log: string[], tag: string) => log.filter((l) => l.startsWith(`${tag}:`)).map((l) => l.slice(tag.length + 1));

// ================= 都在事务里、都先拿锁 =================
test('删除：引用检查和软删除在同一个事务里，先 advisory lock 再 FOR UPDATE about.images；提交后才删文件', async () => {
  for (const settings of [{ 'about.images': imagesWith([Y]) }, {}]) {
    const f = fakeDb({ settings, assets: [X, Y] });
    const { asset } = deps(f);
    assert.deepEqual(await json(await del(asset, X)), { status: 200, body: { id: X, deleted: true } });
    assert.deepEqual(txLog(f.log, 'tx1'), [
      'begin', `advisory(${ABOUT_IMAGES_LOCK})`, 'forUpdate(about.images)', 'publicAsset.updateMany', 'commit',
    ]);
    // 文件在事务提交之后才删；锁外不再读 about.images、不再在事务外软删除
    assert.ok(f.log.indexOf('tx1:commit') < f.log.indexOf(`storage.delete(k/${X}-sm.webp)`));
    assert.ok(!f.log.includes('db:siteSetting.findMany'));
    assert.ok(!f.log.includes('db:publicAsset.updateMany'));
    assert.ok(f.assets.get(X)!.deletedAt);
  }
  // 被引用：同样在锁内判断，409 asset_in_use，不软删除、不删文件
  const f = fakeDb({ settings: { 'about.images': imagesWith([X]) }, assets: [X] });
  const { asset, storageDeletes } = deps(f);
  assert.deepEqual(await json(await del(asset, X)), { status: 409, body: { error: 'asset_in_use', usedBy: ['about.images'] } });
  assert.deepEqual(txLog(f.log, 'tx1'), ['begin', `advisory(${ABOUT_IMAGES_LOCK})`, 'forUpdate(about.images)', 'commit']);
  assert.equal(f.assets.get(X)!.deletedAt, null); assert.deepEqual(storageDeletes, []);
});

test('保存 about.images：查 id、比对 version、写入在同一个事务里，先 advisory lock 再 FOR UPDATE；行不存在时新建', async () => {
  const f = fakeDb({ assets: [X, Y] });
  const { site } = deps(f);
  const r = await json(await save(site, [X, Y], 0));
  assert.equal(r.status, 200); assert.equal(r.body.changed, true);
  assert.deepEqual(txLog(f.log, 'tx1'), ['begin', `advisory(${ABOUT_IMAGES_LOCK})`, 'forUpdate(about.images)', 'publicAsset.findMany', 'siteSetting.create', 'commit']);
  assert.ok(!f.log.includes('db:publicAsset.findMany'), '不在事务外查 id');
  assert.deepEqual(storedIds(f), [X, Y]);
  // 行已存在：update；version 不对 → 409，不写
  const r2 = await json(await save(site, [Y], 1));
  assert.equal(r2.status, 200);
  assert.deepEqual(txLog(f.log, 'tx2'), ['begin', `advisory(${ABOUT_IMAGES_LOCK})`, 'forUpdate(about.images)', 'publicAsset.findMany', 'siteSetting.update', 'commit']);
  assert.deepEqual((await json(await save(site, [X], 1))), { status: 409, body: { error: 'version_conflict', currentVersion: 2 } });
  assert.ok(!txLog(f.log, 'tx3').some((l) => l.startsWith('siteSetting.')));
  // 已删除 / 不存在的 id：锁内拒绝，400 unknown_asset，不写
  f.assets.get(X)!.deletedAt = NOW;
  assert.deepEqual(await json(await save(site, [Y, X, 'Unknown00000000000000000'], 2)), { status: 400, body: { error: 'unknown_asset', ids: [X, 'Unknown00000000000000000'] } });
  assert.deepEqual(storedIds(f), [Y]);
});

// ================= 交错模拟 =================
// A：删除在「查完引用」和「软删除」之间，插进来一次引用这张图的保存 → 保存必须等删除提交，然后按已删除拒绝
for (const [name, settings] of [['about.images 行已存在', { 'about.images': imagesWith([Y]) }], ['about.images 行还不存在', {}]] as const) {
  test(`交错 A（${name}）：删除查完引用后插进一次含该图的保存 → 删除 200，保存 400 unknown_asset，about.images 不引用已删除的图`, async () => {
    const f = fakeDb({ settings, assets: [X, Y] });
    const { asset, site } = deps(f);
    const ver = 'about.images' in settings ? 1 : 0;
    let saving!: Promise<Response>;
    f.hooks.settingsRead = async () => {
      saving = save(site, [Y, X], ver);
      await Promise.race([saving, ticks(50)]); // 有锁时保存被挡住，等满 50 个 tick 再继续删除
    };
    const d = await json(await del(asset, X));
    const s = await json(await saving);
    assert.deepEqual(d, { status: 200, body: { id: X, deleted: true } });
    assert.deepEqual(s, { status: 400, body: { error: 'unknown_asset', ids: [X] } });
    assert.ok(f.assets.get(X)!.deletedAt);
    assert.ok(!storedIds(f).includes(X), `about.images 引用了已删除的图：${storedIds(f).join(',')}`);
  });

  // B：保存在「查完 id」和「写入」之间，插进来一次删除同一张图 → 删除必须等保存提交，然后按被引用 409
  test(`交错 B（${name}）：保存查完 id 后插进一次删除该图 → 保存 200，删除 409 asset_in_use，图片未被删除`, async () => {
    const f = fakeDb({ settings, assets: [X, Y] });
    const { asset, site } = deps(f);
    const ver = 'about.images' in settings ? 1 : 0;
    let deleting!: Promise<Response>;
    f.hooks.assetRead = async () => {
      deleting = del(asset, X);
      await Promise.race([deleting, ticks(50)]);
    };
    const s = await json(await save(site, [X], ver));
    const d = await json(await deleting);
    assert.equal(s.status, 200); assert.deepEqual(storedIds(f), [X]);
    assert.deepEqual(d, { status: 409, body: { error: 'asset_in_use', usedBy: ['about.images'] } });
    assert.equal(f.assets.get(X)!.deletedAt, null);
  });
}
