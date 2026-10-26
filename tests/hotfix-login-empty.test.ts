import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ZodIssue } from 'zod';
import { LoginRequestSchema } from '../src/lib/contracts/account';
import { parseLogin } from '../src/auth';

const EMAIL = 'admin@example.com';
const PASSWORD = 'existing password';
const TOTP = '001234';

function shape(issues: ZodIssue[]) {
  return issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message }));
}

function emailError(email: string) {
  const parsed = LoginRequestSchema.safeParse({ email, password: PASSWORD, totp: TOTP });
  assert.equal(parsed.success, false);
  if (parsed.success) throw new Error('email baseline unexpectedly passed');
  return shape(parsed.error.issues);
}

test('all blank credential fields fail', () => {
  const parsed = parseLogin({ email: '', password: '', totp: '', recoveryCode: '', rememberDevice: '', mode: '' });
  assert.equal(parsed.success, false);
});

test('email and password and totp with the other boxes blank succeed as password mode', () => {
  const parsed = parseLogin({
    email: EMAIL, password: PASSWORD, totp: TOTP, recoveryCode: '', rememberDevice: '', mode: '',
    csrfToken: 'csrf', callbackUrl: 'http://localhost:3100/admin',
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.mode, 'password');
  assert.equal(parsed.data.rememberDevice, false);
  assert.equal(typeof parsed.data.rememberDevice, 'boolean');
  assert.equal(parsed.data.recoveryCode, undefined);
  assert.equal(parsed.data.totp, TOTP);
});

test('whitespace mode is treated as omitted and falls back to password', () => {
  const parsed = parseLogin({ email: EMAIL, password: PASSWORD, totp: TOTP, mode: '  ' });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.mode, 'password');
});

test('mode totp without a password still follows totp rules', () => {
  const parsed = parseLogin({ email: EMAIL, mode: 'totp', password: '', totp: TOTP, recoveryCode: '' });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.mode, 'totp');
  assert.equal(parsed.data.password, undefined);
  assert.equal(parsed.data.totp, TOTP);

  const missing = parseLogin({ email: EMAIL, mode: 'totp', password: '', totp: '', recoveryCode: '' });
  assert.equal(missing.success, false);
  if (missing.success) return;
  const paths = missing.error.issues.map((issue) => issue.path.join('.'));
  assert.ok(paths.includes('totp'));
  assert.equal(paths.includes('password'), false);
});

test('blank recovery code does not count as a recovery login', () => {
  const parsed = parseLogin({ email: EMAIL, password: PASSWORD, totp: TOTP, recoveryCode: '' });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.mode, 'password');
  assert.equal(parsed.data.recoveryCode, undefined);

  const absent = parseLogin({ email: EMAIL, password: PASSWORD, totp: '', recoveryCode: '' });
  assert.equal(absent.success, false);
  if (absent.success) return;
  assert.ok(absent.error.issues.some((issue) => issue.path.join('.') === 'totp' && issue.message === 'Authenticator or recovery code required'));
});

test('blank rememberDevice is false and blank mode is password', () => {
  const parsed = parseLogin({ email: EMAIL, password: PASSWORD, totp: TOTP, rememberDevice: '', mode: '' });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.rememberDevice, false);
  assert.notEqual(parsed.data.rememberDevice, true);
  assert.equal(parsed.data.mode, 'password');

  const checked = parseLogin({ email: EMAIL, password: PASSWORD, totp: TOTP, rememberDevice: 'true' });
  assert.equal(checked.success, true);
  if (!checked.success) return;
  assert.equal(checked.data.rememberDevice, true);
});

test('blank or whitespace email still returns the schema email error', () => {
  for (const email of ['', '   ', '\t  ']) {
    const parsed = parseLogin({ email, password: PASSWORD, totp: TOTP, mode: '', rememberDevice: '', recoveryCode: '' });
    assert.equal(parsed.success, false, JSON.stringify(email));
    if (parsed.success) continue;
    assert.deepEqual(shape(parsed.error.issues), emailError(email));
    assert.ok(parsed.error.issues.some((issue) => issue.path[0] === 'email'));
  }
});

test('unknown fields stay rejected by the strict schema', () => {
  const filled = parseLogin({ email: EMAIL, password: PASSWORD, totp: TOTP, role: 'ADMIN' });
  assert.equal(filled.success, false);
  if (!filled.success) {
    const issue = filled.error.issues.find((item) => item.code === 'unrecognized_keys');
    assert.ok(issue);
    assert.deepEqual((issue as { keys?: string[] }).keys, ['role']);
  }

  const blankUnknown = parseLogin({ email: EMAIL, password: PASSWORD, totp: TOTP, mode: '', extra: '' });
  assert.equal(blankUnknown.success, false);
  if (!blankUnknown.success) {
    const issue = blankUnknown.error.issues.find((item) => item.code === 'unrecognized_keys');
    assert.ok(issue);
    assert.deepEqual((issue as { keys?: string[] }).keys, ['extra']);
  }
});
