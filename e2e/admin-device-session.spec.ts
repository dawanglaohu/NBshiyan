import { randomBytes } from 'node:crypto';
import { PrismaClient, type Role } from '@prisma/client';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { authenticator } from 'otplib';
import { test, expect } from './fixtures';
import { BASE } from '../playwright.config';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import { revokeUserDevices } from '../src/lib/server/admin/device-repo';
import { AccountDTOSchema } from '../src/lib/contracts/account';

const PASSWORD = 'device-network-only-Passw0rd!';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const clearsSession = (response: APIResponse) => /(?:__Secure-)?authjs\.session-token=;[^\n]*Max-Age=0/i.test(response.headers()['set-cookie'] ?? '');

test('device sessions: real network denial, version-safe revocation race and sign-out', async ({ playwright }, info) => {
  test.setTimeout(120_000);
  if (!process.env.DATABASE_URL || !process.env.ADMIN_TOTP_KEY) throw new Error('device network acceptance needs the dedicated E2E database and TOTP key');
  const db = new PrismaClient();
  const users: string[] = [];
  const contexts: APIRequestContext[] = [];
  const evidence: Record<string, unknown> = { transport: 'existing standalone HTTP server', fixtureUsers: 0 };
  let releaseLock: (() => void) | undefined;
  let locking: Promise<unknown> | undefined;
  async function seed(role: Role) {
    const totp = authenticator.generateSecret();
    const email = `device-network-${randomBytes(10).toString('hex')}@example.test`;
    const user = await db.user.create({ data: { email, name: 'Device network acceptance', role, passwordHash: await hashSecret(PASSWORD), totpEnabled: true, totpSecret: encrypt(totp) } });
    users.push(user.id);
    return { user, totp };
  }
  async function context() {
    const req = await playwright.request.newContext({ baseURL: BASE });
    contexts.push(req);
    return req;
  }
  async function login(member: Awaited<ReturnType<typeof seed>>, remembered = false, nextStep = false) {
    const req = await context();
    const csrf = await req.get('/api/auth/csrf');
    expect(csrf.status()).toBe(200);
    const token = (await csrf.json()).csrfToken as string;
    const code = authenticator.clone({ epoch: Date.now() + (nextStep ? 30_000 : 0) }).generate(member.totp);
    const signed = await req.post('/api/auth/callback/credentials', { maxRedirects: 0, headers: { Origin: BASE }, form: { email: member.user.email, password: PASSWORD, totp: code, csrfToken: token, rememberDevice: String(remembered), callbackUrl: `${BASE}/admin` } });
    expect(signed.headers()['location'] ?? '').not.toContain('error');
    expect((await req.storageState()).cookies.some((cookie) => /authjs\.session-token$/.test(cookie.name))).toBe(true);
    expect((await req.get('/api/admin/account')).status()).toBe(200);
    return req;
  }
  try {
    const actor = await seed('ADMIN');
    const sales = await seed('SALES');
    const target = await seed('SALES');
    const actorHttp = await login(actor);
    const validAccount = await actorHttp.get('/api/admin/account');
    const dto = AccountDTOSchema.parse(await validAccount.json());
    expect(dto.passwordlessEnabled).toBe(false);
    expect(Date.parse(dto.currentDevice.effectiveExpiresAt) - Date.now()).toBeGreaterThan(HOUR);
    expect(Date.parse(dto.currentDevice.effectiveExpiresAt) - Date.now()).toBeLessThanOrEqual(2 * HOUR);
    expect(dto.currentDevice.absoluteExpiresAt).toBeNull();
    const session = await actorHttp.get('/api/auth/session');
    expect((await session.json()).user.id).toBe(actor.user.id);
    expect((await actorHttp.get('/admin/users')).status()).toBe(200);

    const salesHttp = await login(sales);
    const salesState = await salesHttp.storageState();
    const salesDevice = await db.adminDeviceSession.findFirstOrThrow({ where: { userId: sales.user.id } });
    const actorCookie = (await actorHttp.storageState()).cookies.find((cookie) => cookie.name === '__Secure-authjs.session-token');
    expect(actorCookie).toBeDefined();
    const stalePlain = await encode({ secret: process.env.AUTH_SECRET!, salt: 'authjs.session-token', token: { uid: sales.user.id, sv: sales.user.sessionVersion, sid: salesDevice.id }, maxAge: 3600 });
    const mixedCookieCases = [
      { tag: 'both-valid', cookie: `authjs.session-token=${stalePlain}; __Secure-authjs.session-token=${actorCookie!.value}`, status: 200 },
      { tag: 'invalid-plain', cookie: `authjs.session-token=malformed; __Secure-authjs.session-token=${actorCookie!.value}`, status: 200 },
      { tag: 'invalid-secure', cookie: `authjs.session-token=${stalePlain}; __Secure-authjs.session-token=malformed`, status: 401 },
      { tag: 'plain-only', cookie: `authjs.session-token=${stalePlain}`, status: 401 },
    ];
    const mixedCookieEvidence: Record<string, unknown> = {};
    for (const mixed of mixedCookieCases) {
      const raw = await context();
      const account = await raw.get('/api/admin/account', { headers: { Cookie: mixed.cookie } });
      expect(account.status()).toBe(mixed.status);
      const session = await raw.get('/api/auth/session', { headers: { Cookie: mixed.cookie } });
      if (mixed.status === 200) {
        expect((await account.json()).id).toBe(actor.user.id);
        expect((await session.json()).user.id).toBe(actor.user.id);
        expect(clearsSession(account)).toBe(false);
      } else {
        expect(clearsSession(account)).toBe(true);
        expect(await session.json()).toBeNull();
      }
      mixedCookieEvidence[mixed.tag] = { status: account.status(), authJsSameAccount: true, clearsCookie: mixed.status === 401 };
    }
    evidence.mixedCookieNamespaces = mixedCookieEvidence;
    const validForbidden = await salesHttp.post('/api/admin/users', { data: {}, headers: { Origin: BASE } });
    expect(validForbidden.status()).toBe(403);
    expect(clearsSession(validForbidden)).toBe(false);
    const deniedScenarios: Record<string, unknown> = {};
    for (const invalid of ['revoked', 'expired', 'missing'] as const) {
      if (invalid === 'revoked') await db.adminDeviceSession.update({ where: { id: salesDevice.id }, data: { revokedAt: new Date() } });
      if (invalid === 'expired') await db.adminDeviceSession.update({ where: { id: salesDevice.id }, data: { revokedAt: null, lastActivityAt: new Date(Date.now() - 2 * HOUR - 1000) } });
      if (invalid === 'missing') await db.adminDeviceSession.delete({ where: { id: salesDevice.id } });
      // Copy the original authenticated cookie independently for every denial path; an earlier response must not hide a missing clear-cookie header.
      const copy = async () => {
        const req = await playwright.request.newContext({ baseURL: BASE, storageState: salesState });
        contexts.push(req);
        return req;
      };
      const excluded = await (await copy()).post('/api/admin/users', { data: {}, headers: { Origin: BASE } });
      expect(excluded.status()).toBe(401);
      expect(clearsSession(excluded)).toBe(true);
      const account = await (await copy()).get('/api/admin/account');
      expect(account.status()).toBe(401);
      expect(clearsSession(account)).toBe(true);
      const authSession = await (await copy()).get('/api/auth/session');
      expect(await authSession.json()).toBeNull();
      const ssr = await (await copy()).get('/admin/users', { maxRedirects: 0 });
      expect([303, 307]).toContain(ssr.status());
      const signIn = new URL(ssr.headers()['location'], BASE);
      expect(signIn.pathname).toBe('/api/auth/signin');
      expect(signIn.searchParams.get('callbackUrl')).toBe('/admin/users');
      deniedScenarios[invalid] = { excludedRole: excluded.status(), account: account.status(), session: 'null', ssr: ssr.status(), clearsCookie: true };
    }
    evidence.invalidDevices = deniedScenarios;
    evidence.validRoleDenial = { status: validForbidden.status(), clearsCookie: false };

    const oldHttp = await login(target, true);
    const oldState = await oldHttp.storageState();
    const oldDevice = await db.adminDeviceSession.findFirstOrThrow({ where: { userId: target.user.id } });
    expect(oldDevice.remembered).toBe(true);
    expect(oldDevice.absoluteExpiresAt!.getTime() - oldDevice.createdAt.getTime()).toBe(30 * DAY);
    const oldSummary = AccountDTOSchema.parse(await (await oldHttp.get('/api/admin/account')).json());
    expect(Date.parse(oldSummary.currentDevice.effectiveExpiresAt) - Date.now()).toBeGreaterThan(6 * DAY);
    expect(Date.parse(oldSummary.currentDevice.effectiveExpiresAt) - Date.now()).toBeLessThanOrEqual(7 * DAY);

    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    locking = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AdminDeviceSession" WHERE id = ${oldDevice.id} FOR UPDATE`;
      locked();
      await release;
    }, { maxWait: 10_000, timeout: 45_000 });
    await lockReady;
    const patchPromise = actorHttp.patch(`/api/admin/users/${target.user.id}`, { headers: { Origin: BASE }, data: { role: 'EDITOR' }, timeout: 60_000 });
    await expect.poll(async () => (await db.user.findUniqueOrThrow({ where: { id: target.user.id } })).sessionVersion, { timeout: 15_000 }).toBeGreaterThan(target.user.sessionVersion);
    const committed = await db.user.findUniqueOrThrow({ where: { id: target.user.id } });
    const freshHttp = await login(target, false, true);
    const freshDevice = await db.adminDeviceSession.findFirstOrThrow({ where: { userId: target.user.id, sessionVersion: committed.sessionVersion } });
    releaseLock?.();
    await locking;
    const patched = await patchPromise;
    expect(patched.status()).toBe(200);
    // An UPDATE already waiting on a row lock can have an older statement snapshot. A call that starts after the new login must also preserve that device.
    await revokeUserDevices(db, target.user.id, 'session_bumped', committed.sessionVersion);
    expect((await db.adminDeviceSession.findUniqueOrThrow({ where: { id: oldDevice.id } })).revokedAt).not.toBeNull();
    expect((await db.adminDeviceSession.findUniqueOrThrow({ where: { id: freshDevice.id } })).revokedAt).toBeNull();
    const newAccount = await freshHttp.get('/api/admin/account');
    expect(newAccount.status()).toBe(200);
    expect((await newAccount.json()).role).toBe('EDITOR');
    const oldCopy = await playwright.request.newContext({ baseURL: BASE, storageState: oldState });
    contexts.push(oldCopy);
    expect((await oldCopy.get('/api/admin/account')).status()).toBe(401);
    evidence.race = { delayedHelperAfterNewNetworkLogin: true, patchStatus: patched.status(), committedVersion: committed.sessionVersion, newDeviceVersion: freshDevice.sessionVersion, oldRevoked: true, freshRevoked: false, newCookieStatus: 200, oldCookieStatus: 401 };

    const beforeSignOut = await freshHttp.storageState();
    const csrf = (await (await freshHttp.get('/api/auth/csrf')).json()).csrfToken as string;
    const signedOut = await freshHttp.post('/api/auth/signout', { maxRedirects: 0, headers: { Origin: BASE }, form: { csrfToken: csrf, callbackUrl: `${BASE}/admin-signin` } });
    expect(signedOut.status()).not.toBe(503);
    expect(clearsSession(signedOut)).toBe(true);
    expect((await db.adminDeviceSession.findUniqueOrThrow({ where: { id: freshDevice.id } })).revokedAt).not.toBeNull();
    const replay = await playwright.request.newContext({ baseURL: BASE, storageState: beforeSignOut });
    contexts.push(replay);
    expect((await replay.get('/api/admin/account')).status()).toBe(401);
    evidence.signOut = { revoked: true, clearsCookie: true, copiedCookieStatus: 401 };
    evidence.fixtureUsers = users.length;
    await info.attach('device-session-network-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    console.log(`DEVICE_SESSION_NETWORK_EVIDENCE ${JSON.stringify(evidence)}`);
  } finally {
    releaseLock?.();
    await locking?.catch(() => {});
    await Promise.all(contexts.map((req) => req.dispose()));
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }
});
