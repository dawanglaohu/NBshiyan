import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdminDeviceSession, User } from '@prisma/client';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';
import { RememberDeviceSchema } from '../src/lib/contracts/account';
import {
  accountDto,
  coarseDeviceLabel,
  createDeviceSessionService,
  decideAdminAccess,
  expiryBounds,
  type DeviceRepo,
} from '../src/lib/server/admin/device-session';

const policy = ADMIN_SESSION_POLICY;
const created = new Date('2026-01-01T00:00:00.000Z');
const area = ['ADMIN', 'SALES', 'EDITOR'] as const;

function user(over: Partial<User> = {}): User {
  return {
    id: 'user-1', email: 'ada@example.com', name: 'Ada', passwordHash: 'h', role: 'ADMIN',
    totpSecret: 's', totpEnabled: true, totpLastStep: null, recoveryCodes: [], sessionVersion: 3,
    passwordlessEnabled: false, disabled: false, failedLogins: 0, lockedUntil: null, lastLoginAt: null,
    reactivatedAt: null, enrollIssuedAt: null, totpPendingUntil: null, totpEnrollFails: 0,
    enrollTokenHash: null, enrollTokenExpiresAt: null, createdAt: created, ...over,
  } as User;
}

function device(over: Partial<AdminDeviceSession> = {}): AdminDeviceSession {
  return {
    id: 'device-1', userId: 'user-1', sessionVersion: 3, remembered: false, createdAt: created,
    lastActivityAt: created, absoluteExpiresAt: null, revokedAt: null, revokedReason: null, deviceLabel: null,
    ...over,
  } as AdminDeviceSession;
}

function access(now: Date, row = device(), account = user(), sid: string | undefined = row.id) {
  return decideAdminAccess({
    userId: account.id, sessionVersion: account.sessionVersion, sid, user: account, device: sid ? row : null,
    roles: area, now, policy,
  });
}

test('E-01 normal expiry slides from last activity and has no absolute cap', () => {
  const active = device({ lastActivityAt: new Date(created.getTime() + 60 * 60_000) });
  const bounds = expiryBounds(active, policy);
  assert.equal(bounds.absoluteExpiresAt, null);
  assert.equal(bounds.effectiveExpiresAt.toISOString(), new Date(active.lastActivityAt.getTime() + policy.idleMs).toISOString());
  assert.notEqual(bounds.effectiveExpiresAt.toISOString(), new Date(created.getTime() + policy.idleMs).toISOString());
  const remembered = device({
    remembered: true,
    lastActivityAt: new Date(created.getTime() + 24 * 24 * 60 * 60_000),
    absoluteExpiresAt: new Date(created.getTime() + policy.absoluteMs),
  });
  const capped = expiryBounds(remembered, policy);
  assert.equal(capped.absoluteExpiresAt?.toISOString(), new Date(created.getTime() + policy.absoluteMs).toISOString());
  assert.equal(capped.effectiveExpiresAt.toISOString(), capped.absoluteExpiresAt?.toISOString());
});

test('E-02 E-69 equality at idle or absolute rejects and one millisecond before allows', () => {
  const idleEnd = new Date(created.getTime() + policy.idleMs);
  assert.equal(access(new Date(idleEnd.getTime() - 1)).ok, true);
  assert.equal(access(idleEnd).ok, false);
  const remembered = device({ remembered: true, absoluteExpiresAt: new Date(created.getTime() + policy.absoluteMs) });
  const idle = new Date(created.getTime() + policy.rememberedIdleMs);
  assert.equal(access(new Date(idle.getTime() - 1), remembered).ok, true);
  assert.equal(access(idle, remembered).ok, false);
  const atAbsolute = device({
    remembered: true,
    lastActivityAt: new Date(created.getTime() + 29 * 24 * 60 * 60_000),
    absoluteExpiresAt: new Date(created.getTime() + policy.absoluteMs),
  });
  const absolute = new Date(created.getTime() + policy.absoluteMs);
  assert.equal(access(new Date(absolute.getTime() - 1), atAbsolute).ok, true);
  assert.equal(access(absolute, atAbsolute).ok, false);
});

test('E-03 E-70 revoked, foreign, stale version, missing sid, disabled, locked and totp are refused', () => {
  assert.equal(access(created, device({ revokedAt: created })).ok, false);
  assert.equal(access(created, device({ userId: 'other' })).ok, false);
  assert.equal(access(created, device({ sessionVersion: 2 })).ok, false);
  const missing = decideAdminAccess({
    userId: 'user-1', sessionVersion: 3, sid: undefined, user: user(), device: null, roles: area, now: created, policy,
  });
  assert.equal(missing.ok, false);
  const disabled = access(created, device(), user({ disabled: true, sessionVersion: 9 }));
  assert.deepEqual(disabled.ok ? null : { reason: disabled.reason, status: disabled.status }, { reason: 'disabled', status: 403 });
  assert.equal(access(created, device(), user({ lockedUntil: new Date(created.getTime() + 1000) })).ok, false);
  assert.equal(access(created, device(), user({ totpEnabled: false })).ok, false);
  const editor = decideAdminAccess({
    userId: 'user-1', sessionVersion: 3, sid: 'device-1', user: user({ role: 'EDITOR' }), device: device(),
    roles: ['ADMIN'], now: created, policy,
  });
  assert.deepEqual(editor.ok ? null : { reason: editor.reason, status: editor.status }, { reason: 'forbidden', status: 403 });
});

test('a revoked row seen on the next call is not served from the first result', async () => {
  let row = device();
  const repo = {
    findUser: async () => user(),
    findDevice: async () => row,
    create: async () => row,
    revokeSid: async () => {},
    revokeUser: async () => {},
    transaction: async (run: (repo: DeviceRepo) => Promise<unknown>) => run({} as DeviceRepo),
  } satisfies DeviceRepo;
  const service = createDeviceSessionService({ repo, clock: () => created, policy });
  const input = { userId: 'user-1', sessionVersion: 3, sid: 'device-1', roles: area };
  assert.equal((await service.authenticate(input)).ok, true);
  row = device({ revokedAt: created });
  assert.equal((await service.authenticate(input)).ok, false);
});

test('database errors deny instead of accepting the cookie', async () => {
  const repo = {
    findUser: async () => { throw new Error('database down'); },
    findDevice: async () => { throw new Error('database down'); },
    create: async () => { throw new Error('database down'); },
    revokeSid: async () => { throw new Error('database down'); },
    revokeUser: async () => { throw new Error('database down'); },
    transaction: async () => { throw new Error('database down'); },
  } satisfies DeviceRepo;
  const service = createDeviceSessionService({ repo, clock: () => created, policy });
  const result = await service.authenticate({ userId: 'user-1', sessionVersion: 3, sid: 'device-1', roles: area });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('database down'), false);
});

test('device label keeps a coarse name and the account DTO defaults passwordless to false', () => {
  const raw = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
  const label = coarseDeviceLabel(raw);
  assert.equal(label, 'Chrome / Windows');
  assert.equal(label?.includes('Mozilla'), false);
  const bounds = expiryBounds(device(), policy);
  const dto = accountDto(user(), device({ deviceLabel: label }), bounds);
  assert.equal(dto.passwordlessEnabled, false);
  assert.equal(dto.currentDevice.absoluteExpiresAt, null);
  assert.equal(dto.currentDevice.effectiveExpiresAt, bounds.effectiveExpiresAt.toISOString());
  assert.equal(RememberDeviceSchema.safeParse(true).success, false);
  assert.equal(RememberDeviceSchema.parse('false'), false);
  assert.equal(RememberDeviceSchema.parse('true'), true);
});
