import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { authenticator } from 'otplib';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';
import { recomputableFrom as earliestRecomputableFrom } from '../src/lib/analytics/day-boundaries';
import {
  ANALYTICS_SETTINGS_GET_ROUTE_ID,
  ANALYTICS_SETTINGS_PATCH_ROUTE_ID,
  createAnalyticsSettingsService,
  handleGetAnalyticsSettings,
  handlePatchAnalyticsSettings,
  type AnalyticsSettingsHttpServices,
} from '../src/lib/server/analytics/settings';
import { ANALYTICS_RECOMPUTE_KEY, consumeRecomputeBacklog } from '../src/lib/server/analytics/settings-repo';
import { ANALYTICS_SETTINGS_KEY } from '../src/lib/server/jobs/types';

// M5-T4 HTTP 验收：真 handler + 真 Prisma（专用库的 m5t4 schema）+ DB 角色复核。
// 只在显式提供 M5T4_TEST_DATABASE_URL 时运行；M5T4_REQUIRE_DATABASE=true 时缺库直接失败，不 skip 记绿。
const origin = 'http://127.0.0.1:3000';
const NOW = new Date('2026-06-15T12:00:00.000Z');

function validateDatabaseUrl(raw: string | undefined): { url: string; schema: string } {
  if (!raw) throw new Error('M5T4_TEST_DATABASE_URL is required when M5T4_REQUIRE_DATABASE=true');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('M5T4_TEST_DATABASE_URL must be a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('M5T4_TEST_DATABASE_URL must use the postgres scheme');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('M5T4_TEST_DATABASE_URL must point at loopback');
  }
  if (!parsed.pathname.replace(/^\//, '')) {
    throw new Error('M5T4_TEST_DATABASE_URL must name a database');
  }
  const schema = parsed.searchParams.get('schema');
  if (schema !== 'm5t4') throw new Error('M5T4_TEST_DATABASE_URL must carry schema=m5t4');
  return { url: raw, schema };
}

const requireDatabase = process.env.M5T4_REQUIRE_DATABASE === 'true';
const rawUrl = process.env.M5T4_TEST_DATABASE_URL;
let database: { url: string; schema: string } | null = null;
if (rawUrl) database = validateDatabaseUrl(rawUrl);
else if (requireDatabase) validateDatabaseUrl(undefined);
const skip = !database && 'no M5T4_TEST_DATABASE_URL';
if (database) process.env.DATABASE_URL = database.url;
process.env.APP_ENV = 'test';
process.env.AUTH_SECRET ??= 'm5t4-settings-http-test-secret-32b';
process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 7).toString('base64');
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;

const db = database ? new PrismaClient({ datasources: { db: { url: database.url } } }) : null;

const counter: import('../src/lib/server/http/metrics').ApiCounter = {
  async recordFinalResponse(response) {
    return { status: response.status, body: response.body, recorded: false };
  },
};

function requireDb(): PrismaClient {
  if (!db) assert.fail('M5-T4 HTTP 验收必须连真实 PostgreSQL：M5T4_TEST_DATABASE_URL 未设置');
  return db;
}

function gate(userId: string, ip = '198.51.100.10') {
  return { user: { id: userId }, ip };
}

function services(clock: () => Date): AnalyticsSettingsHttpServices {
  return {
    analyticsSettings: createAnalyticsSettingsService({ db: requireDb(), clock }),
    apiCounter: counter,
  };
}

function getRequest(): Request {
  return new Request(`${origin}/api/admin/settings/analytics`, { method: 'GET' });
}

function patchRequest(
  body: unknown,
  { withOrigin = true, rawBody }: { withOrigin?: boolean; rawBody?: string } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (withOrigin) headers.origin = origin;
  return new Request(`${origin}/api/admin/settings/analytics`, {
    method: 'PATCH',
    headers,
    body: rawBody ?? JSON.stringify(body),
  });
}

async function getAt(now: Date) {
  return handleGetAnalyticsSettings(getRequest(), gate('admin-a'), services(() => now));
}

async function patchAt(
  now: Date,
  body: unknown,
  opts: { withOrigin?: boolean; rawBody?: string; userId?: string } = {},
) {
  return handlePatchAnalyticsSettings(
    patchRequest(body, opts),
    gate(opts.userId ?? 'admin-a'),
    services(() => now),
  );
}

async function rows() {
  return requireDb().$queryRaw<{ key: string; value: string }[]>`
    SELECT "key", "value"::text AS "value" FROM "SiteSetting" ORDER BY "key"
  `;
}

async function valueOf(key: string): Promise<unknown> {
  const all = await rows();
  const row = all.find((item) => item.key === key);
  return row ? JSON.parse(row.value) as unknown : null;
}

const SEEDED_USER_IDS = ['admin-a', 'admin-b', 'sales-1', 'editor-1'] as const;
const realUserIds: string[] = [];
let handleAuth: typeof import('../src/auth').handleAuth;
let createAdminServices: typeof import('../src/lib/server/composition').createAdminServices;
let settingsRoute: typeof import('../src/app/api/admin/settings/analytics/route');

function cookieJar(response: Response, previous = ''): string {
  const pairs = new Map<string, string>();
  for (const part of previous.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const name = trimmed.split('=', 1)[0];
    pairs.set(name, trimmed.slice(name.length + 1));
  }
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0] ?? '';
    const name = pair.split('=', 1)[0] ?? '';
    const value = pair.slice(name.length + 1);
    if (!value) pairs.delete(name);
    else pairs.set(name, value);
  }
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** 真登录：真 User/AdminDeviceSession 行 + 真 Auth.js csrf/credentials 往返，返回会话 cookie 串。 */
async function enrolled(role: 'ADMIN' | 'SALES' | 'EDITOR') {
  const client = requireDb();
  const plain = authenticator.generateSecret();
  const email = `m5t4-${role.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`;
  const password = 'correct-horse-battery';
  const row = await client.user.create({
    data: { email, name: 'M5T4', passwordHash: await hashSecret(password), role, totpSecret: encrypt(plain), totpEnabled: true },
  });
  realUserIds.push(row.id);
  return { id: row.id, email, password, code: () => authenticator.generate(plain) };
}

async function login(email: string, password: string, totp: string): Promise<string> {
  const first = await handleAuth(new Request(`${origin}/api/auth/csrf`, { headers: { cookie: '' } }));
  const body = await first.json() as { csrfToken: string };
  const jar = cookieJar(first);
  const form = new URLSearchParams({ email, password, totp, csrfToken: body.csrfToken, callbackUrl: `${origin}/admin` });
  const response = await handleAuth(new Request(`${origin}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar, origin },
    body: form,
  }));
  const cookie = cookieJar(response, jar);
  assert.ok(cookie.split('; ').some((part) => part.startsWith('authjs.session-token=') && !part.endsWith('=')), '登录必须拿到真实会话 cookie');
  return cookie;
}

function realGet(cookie: string): Promise<Response> {
  return settingsRoute.GET(new Request(`${origin}/api/admin/settings/analytics`, { headers: { cookie, origin } }));
}

function realPatch(cookie: string, body: unknown, { withOrigin = true }: { withOrigin?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' };
  if (withOrigin) headers.origin = origin;
  return settingsRoute.PATCH(new Request(`${origin}/api/admin/settings/analytics`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  }));
}

async function auditRows(): Promise<{ actorId: string; action: string; meta: unknown }[]> {
  return requireDb().$queryRaw<
    { actorId: string; action: string; meta: unknown }[]
  >`SELECT "actorId", "action", "meta" FROM "AuditLog" WHERE "action" = 'analytics.timezone_change' ORDER BY "createdAt"`;
}

before(async () => {
  if (!db) return;
  const conn = requireDb();
  setRateLimitStore(new MemoryStore());
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: database!.url },
    stdio: 'pipe',
  });
  for (const [id, role] of [['admin-a', 'ADMIN'], ['admin-b', 'ADMIN'], ['sales-1', 'SALES'], ['editor-1', 'EDITOR']] as const) {
    await conn.user.upsert({
      where: { id },
      create: { id, email: `${id}@example.com`, name: id, passwordHash: 'fixture', role, totpEnabled: true },
      update: { role, totpEnabled: true, disabled: false, sessionVersion: 0, lockedUntil: null },
    });
  }
  for (const [key, value] of [
    ['about.enabled', { enabled: true, version: 4 }],
    ['site.organization', { version: 2, name: 'PackJoyU' }],
  ] as const) {
    await conn.siteSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
  ({ handleAuth } = await import('../src/auth'));
  ({ createAdminServices } = await import('../src/lib/server/composition'));
  settingsRoute = await import('../src/app/api/admin/settings/analytics/route');
}, { timeout: 180_000 });

beforeEach(async () => {
  if (!db) return;
  const conn = requireDb();
  await conn.$executeRaw`DELETE FROM "SiteSetting" WHERE "key" IN (${ANALYTICS_SETTINGS_KEY}, ${ANALYTICS_RECOMPUTE_KEY})`;
  await conn.$executeRaw`DELETE FROM "AuditLog" WHERE "action" = 'analytics.timezone_change'`;
});

after(async () => {
  if (!db) return;
  const conn = requireDb();
  await conn.$executeRaw`DELETE FROM "SiteSetting" WHERE "key" IN (${ANALYTICS_SETTINGS_KEY}, ${ANALYTICS_RECOMPUTE_KEY})`;
  await conn.$executeRaw`DELETE FROM "AuditLog" WHERE "action" = 'analytics.timezone_change'`;
  await conn.siteSetting.deleteMany({ where: { key: { in: ['about.enabled', 'site.organization'] } } });
  await conn.apiDailyCounter.deleteMany({
    where: { routeId: { in: [ANALYTICS_SETTINGS_GET_ROUTE_ID, ANALYTICS_SETTINGS_PATCH_ROUTE_ID] } },
  });
  // 登录链路会写 auth.login_success；按本次创建的用户 actorId 精确删除，再删用户（设备行随外键级联）。
  if (realUserIds.length > 0) await conn.auditLog.deleteMany({ where: { actorId: { in: realUserIds } } });
  await conn.user.deleteMany({ where: { id: { in: [...SEEDED_USER_IDS, ...realUserIds] } } });
  await db.$disconnect();
});

describe('M5-T4 GET/PATCH /api/admin/settings/analytics', { concurrency: false, skip }, () => {
  test('无行时 GET 返回默认 UTC/rev1/null，DTO 恰四个字段', async () => {
    const response = await getAt(NOW);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body, { version: 0, timezone: 'UTC', timezoneRevision: 1, recomputableFrom: null });
    assert.deepEqual(Object.keys(body).sort(), ['recomputableFrom', 'timezone', 'timezoneRevision', 'version']);
  });

  test('PATCH 换区：ADMIN 版本 CAS，settings/待办/审计同事务，about/org 不变', async () => {
    const response = await patchAt(NOW, { timezone: 'America/New_York', expectedVersion: 0 });
    assert.equal(response.status, 200);
    const body = await response.json() as { rebuildScheduled: boolean; recomputableFrom: string; timezoneRevision: number };
    assert.equal(body.rebuildScheduled, true);
    assert.equal(body.timezoneRevision, 2);
    assert.equal(body.recomputableFrom, earliestRecomputableFrom(NOW, 'America/New_York'));

    assert.deepEqual(await valueOf(ANALYTICS_SETTINGS_KEY), {
      version: 1,
      timezone: 'America/New_York',
      timezoneRevision: 2,
      changedAt: NOW.toISOString(),
      updatedBy: 'admin-a',
    });
    const backlog = await valueOf(ANALYTICS_RECOMPUTE_KEY) as Record<string, unknown>;
    assert.equal(backlog.timezoneRevision, 2);
    assert.equal(backlog.timezone, 'America/New_York');
    assert.equal(backlog.status, 'pending');
    assert.equal(backlog.recomputableFrom, body.recomputableFrom);
    const audits = await requireDb().$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AuditLog" WHERE "action" = 'analytics.timezone_change'`;
    assert.equal(Number(audits[0]!.c), 1);
    assert.deepEqual(await valueOf('about.enabled'), { enabled: true, version: 4 });
    assert.deepEqual(await valueOf('site.organization'), { version: 2, name: 'PackJoyU' });
  });

  test('GET 读时 live：推进时钟 live 前进，待办行不变；同区 PATCH 不再写待办', async () => {
    await patchAt(NOW, { timezone: 'Asia/Shanghai', expectedVersion: 0 });
    const storedBacklog = await valueOf(ANALYTICS_RECOMPUTE_KEY);
    const first = await (await getAt(NOW)).json() as { recomputableFrom: string };
    assert.equal(first.recomputableFrom, earliestRecomputableFrom(NOW, 'Asia/Shanghai'));

    const later = new Date(NOW.getTime() + 5 * 60 * 60 * 1000);
    const second = await (await getAt(later)).json() as { recomputableFrom: string };
    assert.equal(second.recomputableFrom, earliestRecomputableFrom(later, 'Asia/Shanghai'));
    assert.notEqual(second.recomputableFrom, first.recomputableFrom);
    assert.deepEqual(await valueOf(ANALYTICS_RECOMPUTE_KEY), storedBacklog, 'GET 不得改写待办');

    const again = await patchAt(NOW, { timezone: 'Asia/Shanghai', expectedVersion: 1 });
    assert.equal(again.status, 200);
    const againBody = await again.json() as { rebuildScheduled: boolean };
    assert.equal(againBody.rebuildScheduled, false);
    assert.deepEqual(await valueOf(ANALYTICS_RECOMPUTE_KEY), storedBacklog, '同区不写新待办');
  });

  test('完整值 CAS 消费后 GET 变 null；坏待办 JSON 返回 null 而不 500', async () => {
    await patchAt(NOW, { timezone: 'Asia/Shanghai', expectedVersion: 0 });
    const raw = await valueOf(ANALYTICS_RECOMPUTE_KEY);
    assert.ok(raw);
    const removed = await consumeRecomputeBacklog(requireDb(), raw);
    assert.equal(removed, 1);
    assert.equal(await valueOf(ANALYTICS_RECOMPUTE_KEY), null);
    const afterConsume = await (await getAt(NOW)).json() as { recomputableFrom: string | null };
    assert.equal(afterConsume.recomputableFrom, null, 'null 只表示读时无可用 pending');

    await requireDb().$executeRaw`INSERT INTO "SiteSetting" ("key", "value") VALUES (${ANALYTICS_RECOMPUTE_KEY}, ${'{"timezoneRevision":2}'}::jsonb)`;
    const corrupt = await getAt(NOW);
    assert.equal(corrupt.status, 200);
    const corruptBody = await corrupt.json() as { recomputableFrom: string | null };
    assert.equal(corruptBody.recomputableFrom, null);
  });

  test('坏 settings → 503；非法 IANA/旧 version/额外字段/非 ADMIN/空身份/无 Origin/超体均拒绝且不改配置', async () => {
    await requireDb().$executeRaw`
      INSERT INTO "SiteSetting" ("key", "value") VALUES (${ANALYTICS_SETTINGS_KEY}, ${JSON.stringify({ timezone: 'UTC' })}::jsonb)
    `;
    assert.equal((await getAt(NOW)).status, 503);
    await requireDb().$executeRaw`DELETE FROM "SiteSetting" WHERE "key" = ${ANALYTICS_SETTINGS_KEY}`;

    assert.equal((await patchAt(NOW, { timezone: 'Not/AZone', expectedVersion: 0 })).status, 400);
    const oldVersion = await patchAt(NOW, { timezone: 'Europe/Berlin', expectedVersion: 7 });
    assert.equal(oldVersion.status, 409);
    assert.equal((await oldVersion.json() as { error: string }).error, 'version_conflict');
    const extra = await patchAt(NOW, { timezone: 'UTC', expectedVersion: 0, browserTimezone: 'Asia/Tokyo' });
    assert.equal(extra.status, 400);
    assert.equal((await extra.json() as { error: string }).error, 'invalid');
    assert.equal((await patchAt(NOW, { timezone: 'Europe/Berlin', expectedVersion: 0 }, { userId: 'sales-1' })).status, 403);
    assert.equal((await patchAt(NOW, { timezone: 'Europe/Berlin', expectedVersion: 0 }, { userId: 'missing-user' })).status, 401);
    const noOrigin = await patchAt(NOW, { timezone: 'Europe/Berlin', expectedVersion: 0 }, { withOrigin: false });
    assert.equal(noOrigin.status, 403);
    assert.equal((await noOrigin.json() as { error: string }).error, 'forbidden_origin');
    const tooLarge = await patchAt(NOW, {}, {
      rawBody: JSON.stringify({ timezone: 'UTC', expectedVersion: 0, pad: 'x'.repeat(3_000) }),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json() as { error: string }).error, 'too_large');

    assert.deepEqual(await valueOf('about.enabled'), { enabled: true, version: 4 });
    assert.deepEqual(await valueOf('site.organization'), { version: 2, name: 'PackJoyU' });
    assert.equal(await valueOf(ANALYTICS_SETTINGS_KEY), null);
    assert.equal(await valueOf(ANALYTICS_RECOMPUTE_KEY), null);
    const audits = await requireDb().$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AuditLog" WHERE "action" = 'analytics.timezone_change'`;
    assert.equal(Number(audits[0]!.c), 0);
  });

  test('路由真实入口：无会话 GET 401，且只导出 GET/PATCH', async () => {
    const route = await import('../src/app/api/admin/settings/analytics/route');
    const response = await route.GET(new Request(`${origin}/api/admin/settings/analytics`));
    assert.equal(response.status, 401);
    assert.equal(typeof route.PATCH, 'function');
    assert.equal(ANALYTICS_SETTINGS_GET_ROUTE_ID, 'GET /api/admin/settings/analytics');
    assert.equal(ANALYTICS_SETTINGS_PATCH_ROUTE_ID, 'PATCH /api/admin/settings/analytics');
  });
});

// R1：不传 gate、不 mock requireAdmin/composition。真登录拿 Auth.js 会话 cookie → 真 route 导出 →
// 真 requireAdmin → 真 createAdminServices → 真 PG 的 m5t4 schema。
describe('M5-T4 R1 真实认证入口 GET/PATCH /api/admin/settings/analytics', { concurrency: false, skip }, () => {
  test('ADMIN 真实登录全链：GET 200；PATCH 200 持久 settings/待办/audit，about/org 不变', async () => {
    const built = createAdminServices();
    assert.equal(typeof built.analyticsSettings.read, 'function');
    assert.equal(typeof built.analyticsSettings.update, 'function');

    const member = await enrolled('ADMIN');
    const jar = await login(member.email, member.password, member.code());

    const first = await realGet(jar);
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { version: number; timezone: string; timezoneRevision: number; recomputableFrom: string | null };
    assert.deepEqual(firstBody, { version: 0, timezone: 'UTC', timezoneRevision: 1, recomputableFrom: null });

    const patched = await realPatch(jar, { timezone: 'America/New_York', expectedVersion: 0 });
    assert.equal(patched.status, 200);
    const patchedBody = await patched.json() as { rebuildScheduled: boolean; timezoneRevision: number; recomputableFrom: string };
    assert.equal(patchedBody.rebuildScheduled, true);
    assert.equal(patchedBody.timezoneRevision, 2);
    assert.equal(typeof patchedBody.recomputableFrom, 'string');

    const stored = await valueOf(ANALYTICS_SETTINGS_KEY) as Record<string, unknown>;
    assert.equal(stored.version, 1);
    assert.equal(stored.timezone, 'America/New_York');
    assert.equal(stored.timezoneRevision, 2);
    assert.equal(stored.updatedBy, member.id);
    const backlog = await valueOf(ANALYTICS_RECOMPUTE_KEY) as Record<string, unknown>;
    assert.equal(backlog.status, 'pending');
    assert.equal(backlog.timezone, 'America/New_York');
    assert.equal(backlog.updatedBy, member.id);
    assert.equal(backlog.recomputableFrom, patchedBody.recomputableFrom);

    const audits = await auditRows();
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.actorId, member.id);

    const second = await realGet(jar);
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { timezone: string; timezoneRevision: number; recomputableFrom: string | null };
    assert.equal(secondBody.timezone, 'America/New_York');
    assert.equal(secondBody.timezoneRevision, 2);
    assert.equal(typeof secondBody.recomputableFrom, 'string');

    assert.deepEqual(await valueOf('about.enabled'), { enabled: true, version: 4 });
    assert.deepEqual(await valueOf('site.organization'), { version: 2, name: 'PackJoyU' });
  });

  test('SALES 真实会话：GET/PATCH 均 403，配置与审计不变', async () => {
    const member = await enrolled('SALES');
    const jar = await login(member.email, member.password, member.code());

    const read = await realGet(jar);
    assert.equal(read.status, 403);
    assert.equal((await read.json() as { error: string }).error, 'forbidden');
    const write = await realPatch(jar, { timezone: 'Europe/Berlin', expectedVersion: 0 });
    assert.equal(write.status, 403);

    assert.equal(await valueOf(ANALYTICS_SETTINGS_KEY), null);
    assert.equal(await valueOf(ANALYTICS_RECOMPUTE_KEY), null);
    assert.equal((await auditRows()).length, 0);
    assert.deepEqual(await valueOf('about.enabled'), { enabled: true, version: 4 });
  });

  test('EDITOR 真实会话：GET/PATCH 均 403，配置不变', async () => {
    const member = await enrolled('EDITOR');
    const jar = await login(member.email, member.password, member.code());

    assert.equal((await realGet(jar)).status, 403);
    assert.equal((await realPatch(jar, { timezone: 'Europe/Berlin', expectedVersion: 0 })).status, 403);
    assert.equal(await valueOf(ANALYTICS_SETTINGS_KEY), null);
    assert.equal(await valueOf(ANALYTICS_RECOMPUTE_KEY), null);
    assert.equal((await auditRows()).length, 0);
  });

  test('ADMIN 旧 version 409、缺 Origin 403，配置均不变；随后同会话可成功', async () => {
    const member = await enrolled('ADMIN');
    const jar = await login(member.email, member.password, member.code());

    const stale = await realPatch(jar, { timezone: 'Europe/Berlin', expectedVersion: 7 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { error: string }).error, 'version_conflict');
    assert.equal(await valueOf(ANALYTICS_SETTINGS_KEY), null);
    assert.equal(await valueOf(ANALYTICS_RECOMPUTE_KEY), null);
    assert.equal((await auditRows()).length, 0);

    const noOrigin = await realPatch(jar, { timezone: 'Europe/Berlin', expectedVersion: 0 }, { withOrigin: false });
    assert.equal(noOrigin.status, 403);
    assert.equal((await noOrigin.json() as { error: string }).error, 'forbidden_origin');
    assert.equal(await valueOf(ANALYTICS_SETTINGS_KEY), null);
    assert.equal(await valueOf(ANALYTICS_RECOMPUTE_KEY), null);
    assert.equal((await auditRows()).length, 0);

    const accepted = await realPatch(jar, { timezone: 'Europe/Berlin', expectedVersion: 0 });
    assert.equal(accepted.status, 200);
    assert.equal(((await valueOf(ANALYTICS_SETTINGS_KEY)) as Record<string, unknown>).updatedBy, member.id);
    const audits = await auditRows();
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.actorId, member.id);
  });
});
