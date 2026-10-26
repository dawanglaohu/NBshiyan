import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialLoginFormState,
  passwordSubmitAction,
  reduceLoginForm,
  totpSubmitAction,
  type LoginFormState,
} from '../src/lib/admin/login-form-state';

function withPassword(password: string, email = 'ada@example.test'): LoginFormState {
  return reduceLoginForm(reduceLoginForm(initialLoginFormState(), { type: 'email', value: email }), { type: 'password', value: password });
}

function shown(state: LoginFormState) {
  return reduceLoginForm(state, { type: 'toggle-password' });
}

test('showing the password flips only the visibility flag', () => {
  const hidden = withPassword('secret-value');
  assert.equal(hidden.showPassword, false);
  const visible = shown(hidden);
  assert.equal(visible.showPassword, true);
  assert.equal(visible.password, 'secret-value');
  assert.equal(reduceLoginForm(visible, { type: 'toggle-password' }).showPassword, false);
});

test('an empty email does not clear the password or start a request', () => {
  const state = reduceLoginForm(initialLoginFormState(), { type: 'password', value: 'secret-value' });
  const action = passwordSubmitAction(state);
  assert.equal(action.type, 'submit-password-blocked');
  const next = reduceLoginForm(state, action);
  assert.equal(next.password, 'secret-value');
  assert.equal(next.errorKind, 'credentials');
  assert.equal(next.busy, false);
  assert.equal(next.showPassword, false);
});

test('a rejected sign-in clears the password only after the request is sent', () => {
  const state = shown(withPassword('secret-value'));
  const action = passwordSubmitAction(state);
  assert.equal(action.type, 'submit-password');
  if (action.type !== 'submit-password') return;
  assert.equal(action.password, 'secret-value');
  const sent = reduceLoginForm(state, { type: 'submit-password' });
  assert.equal(sent.password, '');
  assert.equal(sent.busy, true);
  assert.equal(sent.showPassword, true);
  const rejected = reduceLoginForm(sent, { type: 'password-outcome', outcome: 'credentials' });
  assert.equal(rejected.password, '');
  assert.equal(rejected.errorKind, 'credentials');
  assert.equal(rejected.busy, false);
  assert.equal(rejected.step, 'password');
});

test('back and an invalid challenge both hide the password again', () => {
  const sent = reduceLoginForm(shown(withPassword('secret-value')), { type: 'submit-password' });
  const totp = reduceLoginForm(sent, { type: 'password-outcome', outcome: 'totp' });
  assert.equal(totp.step, 'totp');
  assert.equal(totp.showPassword, true);
  const back = reduceLoginForm(totp, { type: 'back' });
  assert.equal(back.step, 'password');
  assert.equal(back.password, '');
  assert.equal(back.showPassword, false);
  assert.equal(back.notice, '');

  const expired = reduceLoginForm(reduceLoginForm(totp, { type: 'totp', value: '123456' }), { type: 'totp-outcome', outcome: 'challenge-invalid' });
  assert.equal(expired.step, 'password');
  assert.equal(expired.password, '');
  assert.equal(expired.showPassword, false);
  assert.equal(expired.notice, 'expired');
  assert.equal(expired.errorKind, '');
});

test('a short code does not start a request and a rate limit keeps the step', () => {
  const totp = reduceLoginForm(initialLoginFormState({ step: 'totp', email: 'ada@example.test' }), { type: 'totp', value: '1234' });
  const blocked = totpSubmitAction(totp);
  assert.equal(blocked.type, 'submit-totp-blocked');
  assert.equal(reduceLoginForm(totp, blocked).errorKind, 'totp');
  const ready = reduceLoginForm(totp, { type: 'totp', value: '123456' });
  const action = totpSubmitAction(ready);
  assert.deepEqual(action, { type: 'submit-totp', code: '123456' });
  const limited = reduceLoginForm(reduceLoginForm(ready, { type: 'submit-totp' }), { type: 'totp-outcome', outcome: 'rate-limited' });
  assert.equal(limited.step, 'totp');
  assert.equal(limited.errorKind, 'rate');
  assert.equal(limited.totp, '');
  assert.equal(limited.showPassword, false);
});
