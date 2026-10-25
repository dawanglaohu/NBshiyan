import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProdEnvFrom } from '../src/lib/site';
import { isProductionDeploy, prodEnvProblems } from '../prod-env-check';
import { turnstileVerifyUrl } from '../src/lib/server/security';
import { seoMockEnabled } from '../src/lib/seo/mock';
import { mockAdapterAllowed } from '../src/lib/server/mail/config';
import { privacyHashReady } from '../src/lib/server/privacy';
import { enrollLinkBase } from '../src/lib/server/admin/enroll-token';

const CF = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const LOCAL = 'http://127.0.0.1:3999/siteverify';
const SECRET = 'a'.repeat(40);

test('APP_ENV=production is production; VERCEL_ENV=production alone is not', () => {
  assert.equal(isProdEnvFrom({ APP_ENV: 'production' }), true);
  assert.equal(isProductionDeploy({ APP_ENV: 'production' }), true);
  assert.equal(isProdEnvFrom({ VERCEL_ENV: 'production' }), false);
  assert.equal(isProductionDeploy({ VERCEL_ENV: 'production' }), false);
  assert.equal(isProdEnvFrom({ APP_ENV: 'production', VERCEL_ENV: 'preview' }), true);
  assert.equal(isProdEnvFrom({ APP_ENV: 'preview', VERCEL_ENV: 'production' }), false);
  assert.equal(isProdEnvFrom({}), false);
  assert.equal(isProdEnvFrom({ APP_ENV: '' }), false);
  assert.equal(isProdEnvFrom({ APP_ENV: '  production  ' }), false);
  assert.equal(isProdEnvFrom({ NODE_ENV: 'production', VERCEL_ENV: 'production' }), false);
  assert.deepEqual(prodEnvProblems({ VERCEL_ENV: 'production' }), []);
});

test('APP_ENV=production ignores TURNSTILE_VERIFY_URL; VERCEL_ENV=production does not', () => {
  assert.equal(turnstileVerifyUrl({ APP_ENV: 'production', TURNSTILE_VERIFY_URL: LOCAL }), CF);
  assert.equal(turnstileVerifyUrl({ APP_ENV: 'production', VERCEL_ENV: 'preview', TURNSTILE_VERIFY_URL: LOCAL }), CF);
  assert.equal(turnstileVerifyUrl({ VERCEL_ENV: 'production', TURNSTILE_VERIFY_URL: LOCAL }), LOCAL);
  assert.equal(turnstileVerifyUrl({ APP_ENV: 'development', TURNSTILE_VERIFY_URL: LOCAL }), LOCAL);
  assert.equal(turnstileVerifyUrl({ APP_ENV: 'development', TURNSTILE_VERIFY_URL: 'https://evil.example/siteverify' }), CF);
  assert.equal(turnstileVerifyUrl({ APP_ENV: 'development', TURNSTILE_VERIFY_URL: 'not a url' }), CF);
});

test('APP_ENV=production ignores SEO_AUDIT_MOCK=1; unset APP_ENV stays off', () => {
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', APP_ENV: 'production' }), false);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', APP_ENV: 'production', NODE_ENV: 'production', VERCEL_ENV: 'preview' }), false);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', VERCEL_ENV: 'production' }), false);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', VERCEL_ENV: 'preview' }), false);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1' }), false);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', APP_ENV: 'development' }), true);
  assert.equal(seoMockEnabled({ APP_ENV: 'development' }), false);
});

test('mail mock and privacy hash fallback follow APP_ENV, not VERCEL_ENV', () => {
  assert.equal(mockAdapterAllowed({ MAIL_SEND_ADAPTER: 'mock', APP_ENV: 'production' }), false);
  assert.equal(mockAdapterAllowed({ MAIL_SEND_ADAPTER: 'mock', VERCEL_ENV: 'production' }), false);
  assert.equal(mockAdapterAllowed({ MAIL_SEND_ADAPTER: 'mock', VERCEL_ENV: 'preview' }), false);
  assert.equal(mockAdapterAllowed({ MAIL_SEND_ADAPTER: 'mock' }), false);
  assert.equal(mockAdapterAllowed({ MAIL_SEND_ADAPTER: 'mock', APP_ENV: 'development' }), true);
  assert.equal(privacyHashReady({ APP_ENV: 'production', AUTH_SECRET: SECRET } as never), false);
  assert.equal(privacyHashReady({ VERCEL_ENV: 'production', AUTH_SECRET: SECRET } as never), true);
  assert.equal(privacyHashReady({ NODE_ENV: 'production', VERCEL_ENV: 'preview', AUTH_SECRET: SECRET } as never), false);
  assert.equal(privacyHashReady({ APP_ENV: 'production', PRIVACY_HASH_SECRET: 'p'.repeat(32) } as never), true);
});

test('enroll http://localhost follows APP_ENV, not VERCEL_ENV', () => {
  assert.equal(enrollLinkBase({ NEXT_PUBLIC_SITE_URL: 'http://localhost:3100', APP_ENV: 'production' }), null);
  assert.equal(enrollLinkBase({ NEXT_PUBLIC_SITE_URL: 'http://localhost:3100', VERCEL_ENV: 'production' }), 'http://localhost:3100');
  assert.equal(enrollLinkBase({ NEXT_PUBLIC_SITE_URL: 'https://geiom.com', VERCEL_ENV: 'production' }), 'https://geiom.com');
  assert.equal(enrollLinkBase({ NEXT_PUBLIC_SITE_URL: '' }), null);
});
