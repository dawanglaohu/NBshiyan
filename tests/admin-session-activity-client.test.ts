import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';
import { adminLoginHref } from '../src/lib/admin/safe-callback';
import { ADMIN_ACTIVITY_THROTTLE_MS, createActivityReporter } from '../src/lib/admin/session-activity';
import { jwtAfterAccess } from '../src/auth';

test('client activity throttle matches the server and only a 401 leaves for the login page', async () => {
  assert.equal(ADMIN_ACTIVITY_THROTTLE_MS, ADMIN_SESSION_POLICY.activityThrottleMs);
  const token = { uid: 'user-1', sid: 'device-1' };
  assert.equal(jwtAfterAccess(token, { ok: false, reason: 'unavailable', status: 503 }), token);
  assert.equal(jwtAfterAccess(token, { ok: false, reason: 'unauthenticated', status: 401 }), null);

  let now = 1_000_000;
  const calls: string[] = [];
  const assigned: string[] = [];
  const pending: Array<(status: number) => void> = [];
  const reporter = createActivityReporter({
    now: () => now,
    path: () => '/admin/settings?section=org',
    assign: (url) => { assigned.push(url); },
    fetch: () => {
      calls.push('send');
      return new Promise((resolve) => { pending.push((status) => resolve({ status })); });
    },
  });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  const settle = (status: number) => {
    const resolve = pending.at(-1);
    if (!resolve) throw new Error('missing request');
    resolve(status);
  };

  reporter.report();
  reporter.report();
  assert.deepEqual(calls, ['send']);
  settle(503);
  await flush();
  reporter.report();
  assert.deepEqual(calls, ['send']);
  assert.deepEqual(assigned, []);

  now += ADMIN_ACTIVITY_THROTTLE_MS;
  reporter.report();
  assert.equal(calls.length, 2);
  settle(401);
  await flush();
  assert.deepEqual(assigned, [adminLoginHref('/admin/settings?section=org')]);

  const network = createActivityReporter({
    now: () => 50,
    path: () => '/admin/users',
    assign: () => { throw new Error('should not assign'); },
    fetch: () => { calls.push('network'); return Promise.reject(new Error('offline')); },
  });
  network.report();
  await flush();
  network.report();
  assert.deepEqual(calls.filter((item) => item === 'network'), ['network']);
});

test('admin shell reports only real interactions', () => {
  const shell = readFileSync('src/components/admin/AdminShell.tsx', 'utf8');
  const route = readFileSync('src/app/api/admin/account/session/activity/route.ts', 'utf8');
  assert.match(shell, /addEventListener\('pointerdown'/);
  assert.match(shell, /addEventListener\('keydown'/);
  assert.match(shell, /addEventListener\('submit'/);
  assert.match(shell, /seenPath\.current === null/);
  assert.equal(shell.includes('visibilitychange'), false);
  assert.equal(shell.includes('setInterval'), false);
  assert.equal(shell.includes('useSession'), false);
  assert.equal(shell.includes("addEventListener('focus'"), false);
  const originAt = route.indexOf('assertSameOrigin(request)');
  const adminAt = route.indexOf('requireAdmin(request');
  const limitAt = route.indexOf('enforceAdminUserRateLimit(');
  assert.ok(originAt !== -1 && originAt < adminAt && adminAt < limitAt);
  assert.equal(route.includes('enforceAdminRateLimit('), false);
  assert.match(route, /enforceAdminUserRateLimit\([^)]*ACTIVITY_USER_LIMIT\)/);
  assert.match(route, /if \(!activity\.wrote\) return finish\(200/);
});
