// Next 的 storage 在模块评估时创建，真实 Auth.js/handler 测试须先完成其官方初始化。
import 'next/dist/server/node-environment-baseline.js';
import { before, after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PrismaClient, type User } from '@prisma/client';
import { authenticator } from 'otplib';
import { DevicePageDTOSchema, DeviceRevokeDTOSchema, SignedOutDTOSchema } from '../src/lib/contracts/account';
import type * as DeviceManagement from '../src/lib/server/admin/device-management';
let createDeviceManagementService: typeof DeviceManagement.createDeviceManagementService;
let handleDeviceList: typeof DeviceManagement.handleDeviceList;
let handleDeviceRevoke: typeof DeviceManagement.handleDeviceRevoke;
let handleLogoutAll: typeof DeviceManagement.handleLogoutAll;
import type { DeviceManagementRepo, ListedDevice } from '../src/lib/server/admin/device-repo';
import { AppError } from '../src/lib/server/http/errors';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';
import type { ActionGrantService } from '../src/lib/server/admin/action-grant';
import type { ApiCounter } from '../src/lib/server/http/metrics';

const databaseUrl = process.env.M3T3_TEST_DATABASE_URL?.startsWith('postgres') ? process.env.M3T3_TEST_DATABASE_URL : '';
if (process.env.M3T3_REQUIRE_DATABASE === 'true' && !databaseUrl) throw new Error('M3T3_TEST_DATABASE_URL must be a postgres URL when M3T3_REQUIRE_DATABASE=true');
const skip = !databaseUrl && 'no dedicated M3T3_TEST_DATABASE_URL';
process.env.APP_ENV = 'test';
Object.assign(process.env, { NODE_ENV: 'test' });
process.env.AUTH_SECRET ??= 'm3t17-auth-http-synthetic-secret-32b';
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.EDGE_AUTH_SECRET ??= 'm'.repeat(40);
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
// 先选专用库，再加载持有唯一PrismaClient的真实服务；不得让静态依赖提前连普通DATABASE_URL。
before(async () => {
  ({ createDeviceManagementService, handleDeviceList, handleDeviceRevoke, handleLogoutAll } = await import('../src/lib/server/admin/device-management'));
});

const origin = 'http://127.0.0.1:3000';
const password = 'correct-horse-battery';
const sessionName = 'authjs.session-token';
const date = new Date('2026-11-01T12:00:00.000Z');
const rows: ListedDevice[] = [{
  id: 'device-2', remembered: false, createdAt: date, lastActivityAt: date,
  absoluteExpiresAt: null, hardExpiresAt: new Date(date.getTime() + ADMIN_SESSION_POLICY.ordinaryAbsoluteMs),
  revokedAt: null, deviceLabel: 'Chrome / Linux',
}, {
  id: 'device-1', remembered: false, createdAt: date, lastActivityAt: date,
  absoluteExpiresAt: null, hardExpiresAt: new Date(date.getTime() + ADMIN_SESSION_POLICY.ordinaryAbsoluteMs),
  revokedAt: null, deviceLabel: null,
}];
const grantStub: ActionGrantService = { issue: async () => { throw new Error('not used'); }, consume: async () => true };

function repoStub(overrides: Partial<DeviceManagementRepo> = {}): DeviceManagementRepo {
  return {
    findCursor: async () => ({ id: 'device-2' }), list: async () => rows,
    readOwnedTarget: async () => ({ id: 'device-1', revokedAt: null }), revokeOwned: async () => 1,
    readVersion: async () => ({ sessionVersion: 3 }), incrementVersion: async () => 1,
    revokePreviousVersion: async () => {}, ...overrides,
  };
}
const counter: ApiCounter = { recordFinalResponse: async (response) => ({ ...response, recorded: true }) };

test('M3-T17 device page is bounded, uses stable createdAt/id cursor, current flag and DTO whitelist', async () => {
  const calls: unknown[] = [];
  const repo = repoStub({ list: async (_db, _user, _limit, cursor) => { calls.push(cursor); return cursor ? [rows[1]] : rows; } });
  const service = createDeviceManagementService({ db: {} as PrismaClient, actionGrants: grantStub, repo });
  const first = await service.list({ userId: 'user-1', sid: 'device-2', query: { limit: 1 } });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].current, true);
  assert.equal(first.hasMore, true);
  assert.deepEqual(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()), { createdAt: date.toISOString(), id: 'device-2' });
  const second = await service.list({ userId: 'user-1', sid: 'device-2', query: { limit: 1, cursor: first.nextCursor! } });
  assert.equal(second.items[0].id, 'device-1');
  assert.equal(second.items[0].current, false);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  for (const forbidden of ['sid', 'userId', 'sessionVersion', 'token', 'tokenHash', 'deviceSessionId', 'hardExpiresAt']) assert.equal(forbidden in first.items[0], false);
  assert.ok(calls[1]);
});

test('M3-T17 foreign or changed cursor anchor is rejected instead of paging another account', async () => {
  const service = createDeviceManagementService({ db: {} as PrismaClient, actionGrants: grantStub, repo: repoStub({ findCursor: async () => null }) });
  const cursor = Buffer.from(JSON.stringify({ createdAt: date.toISOString(), id: 'other-device' })).toString('base64url');
  await assert.rejects(service.list({ userId: 'user-1', sid: 'device-2', query: { cursor, limit: 25 } }), (e: unknown) => e instanceof AppError && e.code === 'invalid');
});

test('M3-T17 denied device handlers preserve 503 cookie and clear only invalid session cookie', async () => {
  const services = { deviceManagement: {} as ReturnType<typeof createDeviceManagementService>, apiCounter: counter };
  const unavailable = await handleDeviceList(new Request(`${origin}/api/admin/account/devices`), Response.json({ error: 'service_unavailable' }, { status: 503 }), services);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.getSetCookie().length, 0);
  const denied = await handleLogoutAll(new Request(`${origin}/api/admin/account/logout-all`, { method: 'POST' }), Response.json({ error: 'unauthorized' }, { status: 401 }), services);
  assert.equal(denied.status, 401);
  assert.ok(denied.headers.getSetCookie().every((v) => /Expires=Thu, 01 Jan 1970/.test(v)));
});

test('M3-T17 mutations enforce guard then same-origin then rate-limit before reading body or service', async () => {
  const gate = { user: { id: 'user-1' } as User, device: { id: 'device-1' }, bounds: {}, ip: '198.51.100.1' } as Exclude<Parameters<typeof handleDeviceRevoke>[1], Response>;
  let calls = 0;
  const services = { deviceManagement: { list: async () => { throw new Error('not used'); }, logoutAll: async () => { throw new Error('not used'); }, revoke: async () => { calls++; return { id: 'device-1', revokedAt: date.toISOString() }; } }, apiCounter: counter };
  const request = () => new Request(`${origin}/api/admin/account/devices/device-1/revoke`, { method: 'POST', headers: { origin: 'https://outside.example' }, body: '{}' });
  const denied = await handleDeviceRevoke(request(), gate, services, 'device-1');
  assert.equal(denied.status, 403);
  assert.equal(calls, 0);
  setRateLimitStore(new MemoryStore());
  const own = () => new Request(`${origin}/api/admin/account/devices/device-1/revoke`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ actionGrant: 'x'.repeat(43) }) });
  for (let n = 0; n < 5; n++) assert.equal((await handleDeviceRevoke(own(), gate, services, 'device-1')).status, 200);
  assert.equal((await handleDeviceRevoke(own(), gate, services, 'device-1')).status, 429);
  assert.equal(calls, 5);
  setRateLimitStore(new MemoryStore());
});

let db: PrismaClient;
let auth: (request: Request) => Promise<Response>;
let reauth: (request: Request) => Promise<Response>;
let listRoute: (request: Request) => Promise<Response>;
let revokeRoute: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
let logoutRoute: (request: Request) => Promise<Response>;
let accountRoute: (request: Request) => Promise<Response>;
let servicesFor: typeof import('../src/lib/server/composition').createAdminServices;
const createdUsers: string[] = [];
let ipSeq = 20;
const nextIp = () => `198.51.100.${ipSeq++}`;
const headers = (ip: string, jar = '') => ({ origin, 'x-edge-auth': process.env.EDGE_AUTH_SECRET!, 'cf-connecting-ip': ip, cookie: jar });

function cookieJar(response: Response, previous = '') {
  const pairs = new Map(previous.split('; ').filter(Boolean).map((v) => [v.split('=', 1)[0], v.slice(v.indexOf('=') + 1)]));
  for (const h of response.headers.getSetCookie()) {
    const p = h.split(';', 1)[0]; const i = p.indexOf('=');
    if (p.slice(i + 1)) pairs.set(p.slice(0, i), p.slice(i + 1)); else pairs.delete(p.slice(0, i));
  }
  return [...pairs].map(([k, v]) => `${k}=${v}`).join('; ');
}

describe('M3-T17 real PostgreSQL and Auth.js HTTP device-management', { skip, concurrency: 1, timeout: 300_000 }, () => {
  before(async () => {
    process.env.APP_ENV = 'test'; Object.assign(process.env, { NODE_ENV: 'test' });
    process.env.AUTH_SECRET ??= 'm3t17-auth-http-synthetic-secret-32b';
    process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 9).toString('base64');
    process.env.EDGE_AUTH_SECRET ??= 'm'.repeat(40);
    delete process.env.AUTH_URL; delete process.env.NEXTAUTH_URL;
    process.env.DATABASE_URL = databaseUrl;
    const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [cli, 'db', 'push', '--skip-generate'], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
    ({ prisma: db } = await import('../src/lib/server/db'));
    ({ handleAuth: auth } = await import('../src/auth'));
    ({ POST: reauth } = await import('../src/app/api/admin/account/reauth/route'));
    ({ GET: listRoute } = await import('../src/app/api/admin/account/devices/route'));
    ({ POST: revokeRoute } = await import('../src/app/api/admin/account/devices/[id]/revoke/route'));
    ({ POST: logoutRoute } = await import('../src/app/api/admin/account/logout-all/route'));
    ({ GET: accountRoute } = await import('../src/app/api/admin/account/route'));
    ({ createAdminServices: servicesFor } = await import('../src/lib/server/composition'));
    authenticator.options = { window: 1, step: 30 };
  });
  after(async () => {
    if (createdUsers.length) await db.user.deleteMany({ where: { id: { in: createdUsers } } });
    await db.$disconnect();
  });
  before(() => setRateLimitStore(new MemoryStore()));

  async function member(role: User['role'] = 'ADMIN') {
    const plain = authenticator.generateSecret();
    const user = await db.user.create({ data: { email: `m3t17-${randomBytes(6).toString('hex')}@example.test`, name: 'Device member', role, passwordHash: await hashSecret(password), totpSecret: encrypt(plain), totpEnabled: true } });
    createdUsers.push(user.id);
    return { user, plain };
  }
  async function code(plain: string, previous: number | null) {
    const deadline = Date.now() + 35_000;
    for (;;) {
      const step = Math.floor(Date.now() / 30_000);
      for (const candidate of [step - 1, step, step + 1]) {
        if (previous === null || candidate > previous) return authenticator.clone({ epoch: candidate * 30_000 + 5_000 }).generate(plain);
      }
      // 登录与重验共用真实时间步，耗尽窗口后等下一步，不重置totpLastStep或伪造授权。
      assert.ok(Date.now() < deadline, 'No unused TOTP step became available');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async function login(actor: Awaited<ReturnType<typeof member>>, ip: string) {
    const current = await db.user.findUniqueOrThrow({ where: { id: actor.user.id } });
    const response = await auth(new Request(`${origin}/api/auth/csrf`, { headers: headers(ip) }));
    const csrfToken = (await response.json() as { csrfToken: string }).csrfToken;
    const first = cookieJar(response);
    const signed = await auth(new Request(`${origin}/api/auth/callback/credentials`, {
      method: 'POST', headers: { ...headers(ip, first), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken, email: actor.user.email, password, totp: await code(actor.plain, current.totpLastStep) }),
    }));
    const jar = cookieJar(signed, first);
    assert.ok(jar.includes(`${sessionName}=`), 'real Auth.js login must return a session cookie');
    const account = await accountRoute(new Request(`${origin}/api/admin/account`, { headers: headers(ip, jar) }));
    assert.equal(account.status, 200);
    const sid = (await account.json() as { currentDevice: { id: string } }).currentDevice.id;
    return { jar, sid };
  }
  async function grant(actor: Awaited<ReturnType<typeof member>>, signed: { jar: string; sid: string }, purpose: 'DEVICE_REVOKE' | 'LOGOUT_ALL' | 'PASSWORD', ip: string, targetId?: string) {
    const user = await db.user.findUniqueOrThrow({ where: { id: actor.user.id } });
    const response = await reauth(new Request(`${origin}/api/admin/account/reauth`, {
      method: 'POST', headers: { ...headers(ip, signed.jar), 'content-type': 'application/json' },
      body: JSON.stringify({ purpose, targetId, password, totp: await code(actor.plain, user.totpLastStep) }),
    }));
    assert.equal(response.status, 200, 'real reauth handler must issue actionGrant');
    return (await response.json() as { token: string }).token;
  }
  function revoke(jar: string, target: string, actionGrant: string, ip: string, extra: Record<string, unknown> = {}) {
    return revokeRoute(new Request(`${origin}/api/admin/account/devices/${target}/revoke`, { method: 'POST', headers: { ...headers(ip, jar), 'content-type': 'application/json' }, body: JSON.stringify({ actionGrant, ...extra }) }), { params: Promise.resolve({ id: target }) });
  }
  function logout(jar: string, actionGrant: string, ip: string) {
    return logoutRoute(new Request(`${origin}/api/admin/account/logout-all`, { method: 'POST', headers: { ...headers(ip, jar), 'content-type': 'application/json' }, body: JSON.stringify({ actionGrant }) }));
  }
  async function state(userId: string) {
    return { user: await db.user.findUniqueOrThrow({ where: { id: userId } }), devices: await db.adminDeviceSession.findMany({ where: { userId }, orderBy: { id: 'asc' } }), grants: await db.adminActionGrant.findMany({ where: { userId }, orderBy: { id: 'asc' } }), audits: await db.auditLog.findMany({ where: { actorId: userId }, orderBy: { id: 'asc' } }) };
  }

  test('E-70 real GET list only includes own devices, stable cursor survives activity/revoke and rejects foreign cursor', async () => {
    const actor = await member('EDITOR'); const ip = nextIp(); const signed = await login(actor, ip);
    const foreign = await member(); const foreignSigned = await login(foreign, nextIp());
    const current = await db.adminDeviceSession.findUniqueOrThrow({ where: { id: signed.sid } });
    const now = new Date();
    const synthetic = await db.adminDeviceSession.createMany({ data: ['same-a', 'same-b', 'same-c'].map((id) => ({ id: `${actor.user.id}-${id}`, userId: actor.user.id, sessionVersion: 0, remembered: false, createdAt: new Date(current.createdAt.getTime() - 1000), lastActivityAt: now, hardExpiresAt: new Date(now.getTime() + 60_000) })) });
    assert.equal(synthetic.count, 3);
    const page = (cursor?: string) => listRoute(new Request(`${origin}/api/admin/account/devices?limit=2${cursor ? '&cursor=' + cursor : ''}`, { headers: headers(ip, signed.jar) }));
    const firstResponse = await page(); assert.equal(firstResponse.status, 200);
    const first = DevicePageDTOSchema.parse(await firstResponse.json());
    assert.equal(first.items.length, 2); assert.equal(first.hasMore, true);
    assert.equal(first.items.some((v) => v.id === foreignSigned.sid), false);
    assert.ok(first.items.some((v) => v.current && v.id === signed.sid));
    const anchor = first.items.at(-1)!;
    await db.adminDeviceSession.update({ where: { id: anchor.id }, data: { lastActivityAt: new Date(now.getTime() + 10), revokedAt: now } });
    const second = DevicePageDTOSchema.parse(await (await page(first.nextCursor!)).json());
    assert.equal(new Set([...first.items, ...second.items].map((v) => v.id)).size, 4);
    assert.deepEqual(second, DevicePageDTOSchema.parse(await (await page(first.nextCursor!)).json()));
    const foreignRow = await db.adminDeviceSession.findUniqueOrThrow({ where: { id: foreignSigned.sid } });
    const badCursor = Buffer.from(JSON.stringify({ createdAt: foreignRow.createdAt.toISOString(), id: foreignRow.id })).toString('base64url');
    assert.equal((await page(badCursor)).status, 400);
    assert.equal((await listRoute(new Request(`${origin}/api/admin/account/devices?limit=51`, { headers: headers(ip, signed.jar) }))).status, 400);
    assert.equal((await listRoute(new Request(`${origin}/api/admin/account/devices`))).status, 401);
  });

  test('E-03/E-73 real target revoke consumes grant once; other-device cookie becomes 401; repeat requires new grant', async () => {
    const actor = await member(); const ip = nextIp(); const signed = await login(actor, ip); const target = await login(actor, nextIp());
    const token = await grant(actor, signed, 'DEVICE_REVOKE', ip, target.sid);
    const response = await revoke(signed.jar, target.sid, token, ip);
    assert.equal(response.status, 200);
    const result = DeviceRevokeDTOSchema.parse(await response.json()); assert.equal(result.id, target.sid);
    assert.equal((await accountRoute(new Request(`${origin}/api/admin/account`, { headers: headers(nextIp(), target.jar) }))).status, 401);
    assert.equal((await revoke(signed.jar, target.sid, token, ip)).status, 401);
    const row = await db.adminDeviceSession.findUniqueOrThrow({ where: { id: target.sid } });
    assert.equal(row.revokedAt?.toISOString(), result.revokedAt);
    assert.equal(await db.auditLog.count({ where: { actorId: actor.user.id, action: 'account.device_revoke' } }), 1);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: actor.user.id } })).sessionVersion, 0);
  });

  test('E-73 cross-device, wrong-purpose, foreign target and unknown body never consume grant or change device', async () => {
    const actor = await member(); const ip = nextIp(); const signed = await login(actor, ip); const other = await login(actor, nextIp());
    const token = await grant(actor, signed, 'DEVICE_REVOKE', ip, other.sid);
    const before = await state(actor.user.id);
    assert.equal((await revoke(other.jar, other.sid, token, nextIp())).status, 401);
    assert.equal((await revoke(signed.jar, other.sid, token, ip, { sid: other.sid })).status, 400);
    assert.deepEqual(await state(actor.user.id), before);
    const foreign = await member(); const f = await login(foreign, nextIp());
    assert.equal((await revoke(signed.jar, f.sid, token, ip)).status, 401);
    assert.deepEqual(await state(actor.user.id), before);
    const wrongPurpose = await grant(actor, signed, 'PASSWORD', ip);
    const wrongBefore = await state(actor.user.id);
    assert.equal((await revoke(signed.jar, other.sid, wrongPurpose, ip)).status, 401);
    assert.deepEqual(await state(actor.user.id), wrongBefore);
  });

  test('E-73 target ownership is rechecked after grant issuance in the action transaction', async () => {
    const actor = await member(); const ip = nextIp(); const signed = await login(actor, ip); const target = await login(actor, nextIp());
    const token = await grant(actor, signed, 'DEVICE_REVOKE', ip, target.sid);
    const foreign = await member();
    // 签发后改变归属，证明动作不能只相信签发时的本人校验；不是创建成功路径业务事实。
    await db.adminDeviceSession.update({ where: { id: target.sid }, data: { userId: foreign.user.id } });
    const before = await state(actor.user.id);
    const foreignBefore = await state(foreign.user.id);
    assert.equal((await revoke(signed.jar, target.sid, token, ip)).status, 404);
    assert.deepEqual(await state(actor.user.id), before);
    assert.deepEqual(await state(foreign.user.id), foreignBefore);
  });

  test('E-73/E-03 PostgreSQL audit failure rolls consumed grant, revoke and logout-all version back', async () => {
    const actor = await member(); const ip = nextIp(); const signed = await login(actor, ip); const target = await login(actor, nextIp());
    const token = await grant(actor, signed, 'DEVICE_REVOKE', ip, target.sid);
    const func = `m3t17_fail_audit_${process.pid}`;
    assert.match(func, /^m3t17_fail_audit_\d+$/);
    // 在真正的审计INSERT阶段失败；先前grant UPDATE与device UPDATE必须随之回滚。
    await db.$executeRawUnsafe(`CREATE FUNCTION "${func}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('account.device_revoke', 'account.logout_all') THEN RAISE EXCEPTION 'm3t17_audit_failure'; END IF; RETURN NEW; END; $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${func}" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "${func}"()`);
    try {
      const before = await state(actor.user.id);
      const failed = await revoke(signed.jar, target.sid, token, ip);
      assert.equal(failed.status, 500);
      assert.equal((await failed.json() as { error: string }).error, 'internal_error');
      assert.deepEqual(await state(actor.user.id), before);
      const allToken = await grant(actor, signed, 'LOGOUT_ALL', ip);
      const allBefore = await state(actor.user.id);
      assert.equal((await logout(signed.jar, allToken, ip)).status, 500);
      assert.deepEqual(await state(actor.user.id), allBefore);
      assert.equal((await accountRoute(new Request(`${origin}/api/admin/account`, { headers: headers(nextIp(), target.jar) }))).status, 200);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER "${func}" ON "AuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${func}"()`);
    }
  });

  test('E-03/E-74 real logout-all increments sv and revokes all devices with one audit and clear cookie; concurrent grant once', async () => {
    const actor = await member('SALES'); const ip = nextIp(); const signed = await login(actor, ip); const second = await login(actor, nextIp());
    const token = await grant(actor, signed, 'LOGOUT_ALL', ip);
    const responses = await Promise.all([logout(signed.jar, token, ip), logout(signed.jar, token, nextIp())]);
    assert.equal(responses.filter((r) => r.status === 200).length, 1);
    const ok = responses.find((r) => r.status === 200)!;
    SignedOutDTOSchema.parse(await ok.json());
    assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith(`${sessionName}=`) && /Max-Age=0/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c)));
    const final = await state(actor.user.id);
    assert.equal(final.user.sessionVersion, 1); assert.ok(final.devices.every((v) => v.revokedAt));
    assert.equal(final.audits.filter((v) => v.action === 'account.logout_all').length, 1);
    assert.equal((await accountRoute(new Request(`${origin}/api/admin/account`, { headers: headers(nextIp(), signed.jar) }))).status, 401);
    assert.equal((await accountRoute(new Request(`${origin}/api/admin/account`, { headers: headers(nextIp(), second.jar) }))).status, 401);
    assert.equal((await logout(signed.jar, token, ip)).status, 401);
    assert.deepEqual(await state(actor.user.id), final);
    console.log('M3T17_HTTP_EVIDENCE ' + JSON.stringify({ operation: 'logout-all', concurrentRequests: 2, successes: 1, versionDelta: 1, revokedDevices: final.devices.length, audits: 1, oldCookieStatuses: [401, 401] }));
  });

  test('E-03 current device may revoke itself and clear cookie; its next GET account is 401', async () => {
    const actor = await member(); const ip = nextIp(); const signed = await login(actor, ip);
    const token = await grant(actor, signed, 'DEVICE_REVOKE', ip, signed.sid);
    const result = await revoke(signed.jar, signed.sid, token, ip);
    assert.equal(result.status, 200);
    DeviceRevokeDTOSchema.parse(await result.json());
    assert.ok(result.headers.getSetCookie().some((v) => /authjs\.session-token=;/.test(v) && /Expires=Thu, 01 Jan 1970/.test(v)));
    assert.equal((await accountRoute(new Request(`${origin}/api/admin/account`, { headers: headers(nextIp(), signed.jar) }))).status, 401);
  });

  test('E-73 simultaneous revoke on one grant succeeds exactly once; fresh grant reads original revokedAt', async () => {
    const actor = await member(); const ip = nextIp(); const signed = await login(actor, ip); const target = await login(actor, nextIp());
    const token = await grant(actor, signed, 'DEVICE_REVOKE', ip, target.sid);
    const responses = await Promise.all([revoke(signed.jar, target.sid, token, ip), revoke(signed.jar, target.sid, token, nextIp())]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
    const result = DeviceRevokeDTOSchema.parse(await responses.find((r) => r.status === 200)!.json());
    const fresh = await grant(actor, signed, 'DEVICE_REVOKE', ip, target.sid);
    const repeated = await revoke(signed.jar, target.sid, fresh, ip);
    assert.equal(repeated.status, 200);
    assert.deepEqual(DeviceRevokeDTOSchema.parse(await repeated.json()), result);
    assert.equal(await db.auditLog.count({ where: { actorId: actor.user.id, action: 'account.device_revoke' } }), 1);
  });

  test('E-74 logout-all grant cannot cross devices or be used after source-device revocation', async () => {
    const actor = await member(); const ip = nextIp(); const signed = await login(actor, ip); const other = await login(actor, nextIp());
    const token = await grant(actor, signed, 'LOGOUT_ALL', ip);
    const before = await state(actor.user.id);
    assert.equal((await logout(other.jar, token, nextIp())).status, 401);
    assert.deepEqual(await state(actor.user.id), before);
    await db.adminDeviceSession.update({ where: { id: signed.sid }, data: { revokedAt: new Date(), revokedReason: 'test_revoke' } });
    const revoked = await state(actor.user.id);
    assert.equal((await logout(signed.jar, token, ip)).status, 401);
    assert.deepEqual(await state(actor.user.id), revoked);
  });

  test('E-74 action transaction waits on real User lock and refuses grant after its expiry', async () => {
    const actor = await member(); const ip = nextIp(); const signed = await login(actor, ip);
    const liveServices = servicesFor({ db });
    const { createActionGrantService } = await import('../src/lib/server/admin/action-grant');
    const liveGrant = createActionGrantService({ db, grantTtlMs: 1500 });
    const user = await db.user.findUniqueOrThrow({ where: { id: actor.user.id } });
    const issued = await liveGrant.issue({ userId: actor.user.id, sid: signed.sid, purpose: 'LOGOUT_ALL', password, totp: await code(actor.plain, user.totpLastStep) });
    const before = await state(actor.user.id);
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let ready!: (pid: number) => void;
    let failed!: (e: unknown) => void;
    const locked = new Promise<number>((resolve, reject) => { ready = resolve; failed = reject; });
    const locking = locker.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.user.id} FOR UPDATE`;
      ready(backend.pid);
      await held;
    }, { timeout: 10000 });
    void locking.catch(failed);
    let mutation: Promise<Response> | undefined;
    try {
      const blockerPid = await locked;
      mutation = handleLogoutAll(new Request(`${origin}/api/admin/account/logout-all`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ actionGrant: issued.token }) }), { user: actor.user, device: await db.adminDeviceSession.findUniqueOrThrow({ where: { id: signed.sid } }), bounds: { effectiveExpiresAt: new Date(Date.now() + 60000), absoluteExpiresAt: null }, ip }, { ...liveServices, deviceManagement: createDeviceManagementService({ db, actionGrants: liveGrant }) });
      const observedUntil = Date.now() + 1000;
      let blocked = false;
      while (!blocked && Date.now() < observedUntil) {
        const rows = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND ${blockerPid} = ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM "User"%FOR UPDATE%') AS waiting`;
        blocked = rows[0]?.waiting === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(blocked, 'must observe action-grant consumption waiting on actual PostgreSQL lock');
      while (Date.now() <= issued.expiresAt.getTime()) await new Promise((resolve) => setTimeout(resolve, 10));
      release(); await locking;
      assert.equal((await mutation).status, 401);
      assert.deepEqual(await state(actor.user.id), before);
    } finally {
      release(); await locking.catch(() => {}); await mutation?.catch(() => {}); await locker.$disconnect();
    }
  });

  test('E-74 grant expiry equality and old sv deny mutation without consuming grant', async () => {
    const actor = await member(); const ip = nextIp(); const signed = await login(actor, ip);
    const token = await grant(actor, signed, 'LOGOUT_ALL', ip);
    const rows = await db.adminActionGrant.findMany({ where: { userId: actor.user.id } });
    const expiry = rows[0].expiresAt;
    const fixed = servicesFor({ db, clock: () => expiry }).deviceManagement;
    const before = await state(actor.user.id);
    await assert.rejects(fixed.logoutAll({ userId: actor.user.id, sid: signed.sid, grantToken: token }), (e: unknown) => e instanceof AppError && e.code === 'action_grant_invalid');
    assert.deepEqual(await state(actor.user.id), before);
    await db.user.update({ where: { id: actor.user.id }, data: { sessionVersion: { increment: 1 } } });
    const newer = await state(actor.user.id);
    assert.equal((await logout(signed.jar, token, ip)).status, 401);
    assert.deepEqual(await state(actor.user.id), newer);
  });
});
