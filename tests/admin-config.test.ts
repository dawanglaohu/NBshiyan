import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { prodEnvProblems } from '../prod-env-check';
import {
  ADMIN_GRANT_POLICY,
  ADMIN_SESSION_POLICY,
  ServerConfigError,
  freezeServerConfig,
  loadServerConfig,
  parseServerPolicy,
  policyConfigProblems,
  serverConfigFailureText,
} from '../src/lib/server/config';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('shipped admin policy is the section 18 duration set and parses', () => {
  assert.equal(ADMIN_SESSION_POLICY.idleMs, 2 * HOUR);
  assert.equal(ADMIN_SESSION_POLICY.rememberedIdleMs, 7 * DAY);
  assert.equal(ADMIN_SESSION_POLICY.absoluteMs, 30 * DAY);
  assert.equal(ADMIN_SESSION_POLICY.activityThrottleMs, 15 * 60 * 1000);
  assert.equal(ADMIN_GRANT_POLICY.ttlMs, 5 * 60 * 1000);
  assert.equal(ADMIN_GRANT_POLICY.permitTtlMs, 15 * 60 * 1000);
  assert.equal(ADMIN_GRANT_POLICY.restrictedTtlMs, 10 * 60 * 1000);
  assert.deepEqual(policyConfigProblems(), []);
  const loaded = loadServerConfig({ APP_ENV: 'test' });
  assert.equal(loaded.production, false);
  assert.equal(loaded.session.idleMs, ADMIN_SESSION_POLICY.idleMs);
  assert.equal(Object.isFrozen(loaded), true);
});

test('missing policy fields and illegal durations are rejected without the raw exception or the input value', () => {
  assert.throws(() => parseServerPolicy({}), (error) => {
    assert.ok(error instanceof ServerConfigError);
    assert.match(error.message, /session 未设置/);
    assert.doesNotMatch(error.message, /ZodError|stack|received/i);
    return true;
  });

  const leak = 'LEAK-TOKEN-VALUE';
  assert.throws(() => parseServerPolicy({
    session: { idleMs: leak, rememberedIdleMs: 7 * DAY, absoluteMs: 30 * DAY, activityThrottleMs: 15 * 60 * 1000 },
    grant: ADMIN_GRANT_POLICY,
  }), (error) => {
    assert.ok(error instanceof ServerConfigError);
    assert.match(error.message, /session\.idleMs 无效/);
    assert.equal(error.message.includes(leak), false);
    assert.equal(JSON.stringify(error.problems).includes(leak), false);
    return true;
  });

  assert.throws(() => parseServerPolicy({
    session: { ...ADMIN_SESSION_POLICY, activityThrottleMs: ADMIN_SESSION_POLICY.idleMs },
    grant: ADMIN_GRANT_POLICY,
  }), (error) => {
    assert.ok(error instanceof ServerConfigError);
    assert.match(error.message, /activityThrottleMs 无效/);
    return true;
  });

  const evil = {};
  Object.defineProperty(evil, 'session', { get() { throw new Error('LEAK-raw-exception'); } });
  assert.throws(() => parseServerPolicy(evil), (error) => {
    assert.ok(error instanceof ServerConfigError);
    assert.equal(error.message.includes('LEAK-raw-exception'), false);
    assert.equal(serverConfigFailureText(error).includes('LEAK-raw-exception'), false);
    return true;
  });
});

test('production load rejects missing required secrets and does not echo their values', () => {
  const leak = 'LEAK-not-a-totp-key-value';
  assert.throws(() => loadServerConfig({ APP_ENV: 'production', ADMIN_TOTP_KEY: leak, CRON_SECRET: 'short' }), (error) => {
    assert.ok(error instanceof ServerConfigError);
    assert.match(error.message, /AUTH_SECRET 未设置/);
    assert.match(error.message, /ADMIN_TOTP_KEY 必须是 base64 解码后 32 字节/);
    assert.match(error.message, /CRON_SECRET 至少 32 个字符/);
    assert.equal(error.message.includes(leak), false);
    assert.equal(error.message.includes('short'), false);
    assert.doesNotMatch(serverConfigFailureText(error), /LEAK|ZodError/);
    return true;
  });
  assert.equal(serverConfigFailureText(new Error('postgres://user:LEAK@db/app')).includes('LEAK'), false);

  const totp = Buffer.alloc(32, 7).toString('base64');
  const loaded = loadServerConfig({
    APP_ENV: 'production',
    DATABASE_URL: 'postgres://example',
    AUTH_SECRET: 'secret-value-should-not-be-copied',
    AUTH_URL: 'https://example.com',
    APP_ORIGIN: 'https://example.com',
    ADMIN_TOTP_KEY: totp,
    PRIVACY_HASH_SECRET: 'p'.repeat(32),
    CRON_SECRET: 'c'.repeat(32),
  });
  assert.equal(loaded.production, true);
  assert.equal(JSON.stringify(loaded).includes('secret-value-should-not-be-copied'), false);
  assert.equal(JSON.stringify(loaded).includes(totp), false);
});

test('startup wires the frozen config without adding a second problem list', () => {
  assert.equal(prodEnvProblems({ APP_ENV: 'production' }).length, 24);
  const instrumentation = readFileSync('src/instrumentation.ts', 'utf8');
  assert.match(instrumentation, /freezeServerConfig\(\)/);
  assert.match(instrumentation, /serverConfigFailureText/);
  const check = readFileSync('prod-env-check.ts', 'utf8');
  assert.match(check, /policyConfigProblems\(\)/);
  const frozen = freezeServerConfig({ APP_ENV: 'test' });
  assert.equal(freezeServerConfig({ APP_ENV: 'production' }), frozen);
  assert.equal(frozen.production, false);
});
