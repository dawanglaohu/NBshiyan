import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySession, denialError } from '../src/lib/server/admin/guard';

const base = { disabled: false, totpEnabled: true, lockedUntil: null as Date | null, sessionVersion: 3, role: 'EDITOR' as const };
const R = ['ADMIN', 'EDITOR'] as const;
const reason = (r: ReturnType<typeof classifySession>) => (r.ok ? 'ok' : `${r.reason}:${r.status}`);

test('unauthenticated -> 401', () => {
  assert.equal(reason(classifySession(undefined, null, undefined, R)), 'unauthenticated:401');
  assert.equal(reason(classifySession('u1', null, 3, R)), 'unauthenticated:401');
  assert.equal(reason(classifySession('u1', { ...base, sessionVersion: 4 }, 3, R)), 'unauthenticated:401');
  assert.equal(reason(classifySession('u1', { ...base, totpEnabled: false }, 3, R)), 'unauthenticated:401');
  assert.equal(reason(classifySession('u1', { ...base, lockedUntil: new Date(Date.now() + 60_000) }, 3, R)), 'unauthenticated:401');
});

test('disabled -> 403 account_disabled, even with stale session or allowed role', () => {
  assert.equal(reason(classifySession('u1', { ...base, disabled: true }, 3, R)), 'disabled:403');
  assert.equal(reason(classifySession('u1', { ...base, disabled: true, sessionVersion: 9 }, 3, R)), 'disabled:403');
  assert.equal(denialError('disabled'), 'account_disabled');
});

test('wrong role -> 403 forbidden; ok otherwise', () => {
  assert.equal(reason(classifySession('u1', { ...base, role: 'SALES' as never }, 3, R)), 'forbidden:403');
  assert.equal(reason(classifySession('u1', base, 3, R)), 'ok');
  assert.equal(denialError('unauthenticated'), 'unauthorized');
  assert.equal(denialError('forbidden'), 'forbidden');
  assert.equal(denialError('unavailable'), 'service_unavailable');
  assert.equal(denialError('internal'), 'internal_error');
});
