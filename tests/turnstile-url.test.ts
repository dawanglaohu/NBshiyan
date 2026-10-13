import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnstileVerifyUrl } from '../src/lib/server/security';

const CF = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
test('turnstileVerifyUrl：仅非生产且本机 http 地址可覆盖', () => {
  assert.equal(turnstileVerifyUrl({}), CF);
  assert.equal(turnstileVerifyUrl({ TURNSTILE_VERIFY_URL: 'http://127.0.0.1:3999/siteverify' }), 'http://127.0.0.1:3999/siteverify');
  assert.equal(turnstileVerifyUrl({ TURNSTILE_VERIFY_URL: 'http://127.0.0.1:3999/x', VERCEL_ENV: 'production' }), CF);
  assert.equal(turnstileVerifyUrl({ TURNSTILE_VERIFY_URL: 'https://evil.example/siteverify' }), CF);
  assert.equal(turnstileVerifyUrl({ TURNSTILE_VERIFY_URL: 'http://localhost.evil.com/x' }), CF);
});
