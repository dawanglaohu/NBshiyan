import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handlePrivacyExport, handlePrivacyDelete, type PrivacyDeps } from '../src/lib/server/privacy-routes';
import { deleteCustomer } from '../src/lib/server/privacy';
import { S3Storage } from '../src/lib/server/storage';
import { setRateLimitStore, MemoryStore } from '../src/lib/server/ratelimit';
import { mockServer } from './helpers';

// HTTP 级集成测试：真实 Request、真实同源校验和限流（内存存储）。会话鉴权按真实 requireAdmin 的规则模拟：
// 没有会话 401，角色不在允许列表 403。数据库和审计用记录调用的假实现，用来断言“没有副作用”。
const ORIGIN = 'https://admin.packjoyu.test';
type Role = 'ADMIN' | 'SALES' | 'EDITOR';
let ipSeq = 0;
function req(path: string, body: unknown, opt: { role?: Role | null; origin?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': opt.ip ?? `203.0.113.${++ipSeq % 250}` };
  if (opt.origin !== null) headers.origin = opt.origin ?? ORIGIN;
  if (opt.role !== undefined && opt.role !== null) headers['x-test-role'] = opt.role;
  else if (opt.role === undefined) headers['x-test-role'] = 'ADMIN';
  return new Request(`${ORIGIN}/api/admin/privacy/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function deps() {
  const calls: string[] = [];
  const audits: unknown[] = [];
  const op = (name: string, ret: unknown = { count: 0 }) => async (..._a: unknown[]) => { calls.push(name); return ret; };
  const db = {
    contact: { findMany: async (a: { where?: { normalizedEmail?: string; id?: unknown } }) => { calls.push('contact.findMany'); return a.where?.normalizedEmail ? [{ id: 'c1' }] : []; }, updateMany: op('contact.updateMany') },
    inquiry: { findMany: async () => { calls.push('inquiry.findMany'); return [{ id: 'i1' }]; }, updateMany: op('inquiry.updateMany'), update: op('inquiry.update') },
    inquiryItem: { updateMany: op('inquiryItem.updateMany'), findMany: async () => [], update: op('inquiryItem.update') },
    inquiryNote: { updateMany: op('inquiryNote.updateMany') },
    inquiryMessage: { updateMany: op('inquiryMessage.updateMany') },
    mailMessage: { updateMany: op('mailMessage.updateMany'), update: op('mailMessage.update'), findMany: async () => [], deleteMany: op('mailMessage.deleteMany') },
    sampleRequest: { updateMany: op('sampleRequest.updateMany') },
    logoUpload: { findMany: async () => { calls.push('logoUpload.findMany'); return []; }, deleteMany: op('logoUpload.deleteMany') },
    async $transaction(x: any) { calls.push('$transaction'); return typeof x === 'function' ? x(this) : Promise.all(x); },
  };
  const d: PrivacyDeps = {
    requireAdmin: async (r, roles) => {
      const role = r.headers.get('x-test-role') as Role | null;
      if (!role) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      if (!(roles as string[]).includes(role)) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
      return { user: { id: 'u_admin', role } as never, ip: '203.0.113.1' };
    },
    db: db as never,
    audit: async (e) => { audits.push(e); },
  };
  return { d, calls, audits };
}

const ROUTES = [
  ['export', handlePrivacyExport, { email: 'John.Doe@gmail.com' }],
  ['delete', handlePrivacyDelete, { email: 'John.Doe@gmail.com', confirmEmail: 'johndoe@gmail.com' }],
] as const;

beforeEach(() => {
  setRateLimitStore(new MemoryStore());
  process.env.PRIVACY_HASH_SECRET = 's'.repeat(32);
  delete process.env.VERCEL_ENV;
  delete process.env.APP_ENV;
  delete process.env.APP_ORIGIN;
});

for (const [name, handle, body] of ROUTES) {
  test(`${name}: unauthenticated 401, SALES/EDITOR 403, no side effects`, async () => {
    const { d, calls, audits } = deps();
    assert.equal((await handle(req(name, body, { role: null }), d)).status, 401);
    for (const role of ['SALES', 'EDITOR'] as const) assert.equal((await handle(req(name, body, { role }), d)).status, 403);
    assert.deepEqual(calls, []); assert.deepEqual(audits, []);
  });

  test(`${name}: cross-origin or missing Origin 403, no side effects`, async () => {
    const { d, calls, audits } = deps();
    for (const origin of ['https://evil.example', 'null', null]) {
      const r = await handle(req(name, body, { origin }), d);
      assert.equal(r.status, 403, String(origin));
      assert.equal((await r.json()).error, 'forbidden_origin');
    }
    assert.deepEqual(calls, []); assert.deepEqual(audits, []);
  });

  test(`${name}: 6th request in a minute from same IP -> 429 with Retry-After`, async () => {
    const { d } = deps();
    for (let i = 0; i < 5; i++) assert.equal((await handle(req(name, body, { ip: '198.51.100.7' }), d)).status, 200);
    const r = await handle(req(name, body, { ip: '198.51.100.7' }), d);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '60');
  });

  test(`${name}: production without PRIVACY_HASH_SECRET -> 503, nothing read/changed/audited`, async () => {
    const { d, calls, audits } = deps();
    const savedSecret = process.env.AUTH_SECRET;
    delete process.env.PRIVACY_HASH_SECRET;
    process.env.APP_ENV = 'production';
    process.env.AUTH_SECRET = 'a'.repeat(40);
    process.env.APP_ORIGIN = ORIGIN; // #323：生产环境同源检查只认 APP_ORIGIN
    try {
      const r = await handle(req(name, body), d);
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error, 'privacy_hash_secret_missing');
      assert.deepEqual(calls, []); assert.deepEqual(audits, []);
    } finally {
      if (savedSecret === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = savedSecret;
    }
  });

  test(`${name}: ADMIN happy path, no-store, audit has hash only`, async () => {
    const { d, audits } = deps();
    const r = await handle(req(name, body), d);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(audits.length, 1);
    const a = JSON.stringify(audits[0]);
    assert.ok(!/john|gmail/i.test(a), a);
    assert.match(a, /"target":"[0-9a-f]{64}"/);
    if (name === 'export') assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename="privacy-export-[0-9a-f]{12}\.json"$/);
  });
}

test('delete: confirmEmail mismatch -> 400, no side effects', async () => {
  const { d, calls, audits } = deps();
  const r = await handlePrivacyDelete(req('delete', { email: 'a@acme.de', confirmEmail: 'b@acme.de' }), d);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'confirm_mismatch');
  assert.deepEqual(calls, []); assert.deepEqual(audits, []);
});

test('logo deletion via mocked R2: valid logos/YYYY-MM/<id>.png deleted, invalid keys skipped', async () => {
  process.env.PRIVACY_HASH_SECRET = 's'.repeat(32);
  const srv = await mockServer((_r, res) => { res.statusCode = 204; res.end(); });
  try {
    const r2 = new S3Storage({ endpoint: srv.url, bucket: 'packjoyu-private', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' });
    const VALID = 'logos/2026-10/abcdefghijklmnopqrstuvwx.png';
    const logos = [{ id: 'l1', path: VALID }, { id: 'l2', path: 'models/2026-10/abcdefghijklmnop.glb' }, { id: 'l3', path: 'logos/2026-10/short.png' }, { id: 'l4', path: 'logos/../secrets/abcdefghijkl.png' }];
    const deleted: string[][] = [];
    const db = {
      contact: { findMany: async () => [{ id: 'c1' }], updateMany: async () => ({ count: 1 }) },
      inquiry: { findMany: async () => [{ id: 'i1' }], updateMany: async () => ({ count: 1 }), update: async () => ({}) },
      inquiryItem: { updateMany: async () => ({ count: 0 }), findMany: async () => [], update: async () => ({}) },
      inquiryNote: { updateMany: async () => ({ count: 0 }) },
      inquiryMessage: { updateMany: async () => ({ count: 0 }) },
      mailMessage: { updateMany: async () => ({ count: 0 }), update: async () => ({}), findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
      sampleRequest: { updateMany: async () => ({ count: 0 }) },
      logoUpload: { findMany: async () => logos, deleteMany: async (a: { where: { id: { in: string[] } } }) => { deleted.push(a.where.id.in); return { count: a.where.id.in.length }; } },
      async $transaction(x: any) { return typeof x === 'function' ? x(this) : Promise.all(x); },
    };
    const out = await deleteCustomer(db as never, 'a@acme.de', r2);
    assert.equal(out.logos, 4);
    assert.deepEqual(deleted, [['l1', 'l2', 'l3', 'l4']]); // 记录都删
    const dels = srv.reqs.filter((r) => r.method === 'DELETE').map((r) => r.url);
    assert.deepEqual(dels, [`/packjoyu-private/${VALID}`]); // 文件只删合法的 logo key
    assert.match(String(srv.reqs[0].headers.authorization), /^AWS4-HMAC-SHA256 /);
  } finally { await srv.close(); }
});
