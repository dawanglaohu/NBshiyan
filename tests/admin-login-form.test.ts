import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: typeof React }).React = React; // tsx 用经典 JSX 转换
import { renderToStaticMarkup } from 'react-dom/server';
import { CredentialsSignin } from 'next-auth';
import LoginForm from '../src/components/admin/auth/LoginForm';
import AdminLoginPage from '../src/app/admin-login/page';
import { throwTotpRequired } from '../src/lib/server/admin/login-challenge';
import {
  interpretSignInResult,
  loginCopy,
  passwordCredentials,
  signInOptions,
  totpCredentials,
  TOTP_REQUIRED_CODE,
} from '../src/lib/admin/login-step';

const forbidden = /name="(?:recoveryCode|rememberDevice|mode)"|recoveryCode|rememberDevice|\bmode\b/i;

function markup(props: { callbackUrl?: string; urlError?: boolean; initialStep?: 'password' | 'totp'; initialEmail?: string; initialLang?: 'zh' | 'en' | 'ru' }) {
  return renderToStaticMarkup(React.createElement(LoginForm, { callbackUrl: '/admin/inquiries', ...props }));
}

test('password step renders email and password only', () => {
  for (const lang of ['zh', 'en', 'ru'] as const) {
    const html = markup({ initialLang: lang });
    const copy = loginCopy(lang);
    assert.match(html, new RegExp(`<label for="admin-login-email">${copy.email}</label>`));
    assert.match(html, /id="admin-login-email"[^>]*type="email"/);
    assert.match(html, /auto[Cc]omplete="username"/);
    assert.match(html, new RegExp(`<label for="admin-login-password">${copy.password}</label>`));
    assert.match(html, /id="admin-login-password"[^>]*type="password"/);
    assert.match(html, /auto[Cc]omplete="current-password"/);
    assert.doesNotMatch(html, /admin-login-totp|one-time-code/);
    assert.doesNotMatch(html, forbidden);
  }
});

test('totp step keeps the email and drops the password field', () => {
  const html = markup({ initialStep: 'totp', initialEmail: 'ada@example.com' });
  assert.match(html, /id="admin-login-email"[^>]*value="ada@example.com"/);
  assert.match(html, /<label for="admin-login-totp">验证码<\/label>/);
  assert.match(html, /id="admin-login-totp"[^>]*input[Mm]ode="numeric"/);
  assert.match(html, /auto[Cc]omplete="one-time-code"/);
  assert.doesNotMatch(html, /admin-login-password|type="password"/);
  assert.doesNotMatch(html, forbidden);
});

test('submit payload fixes mode and rememberDevice and does not carry the hidden fields', () => {
  const password = passwordCredentials('  Ada@Example.com ', 'correct-horse');
  assert.deepEqual(password, { email: 'Ada@Example.com', password: 'correct-horse', mode: 'password', rememberDevice: false });
  assert.equal(password.rememberDevice, false);
  const code = totpCredentials('Ada@Example.com', 'correct-horse', '001234');
  assert.deepEqual(code, { email: 'Ada@Example.com', password: 'correct-horse', totp: '001234', mode: 'password', rememberDevice: false });
  for (const fields of [password, code]) {
    assert.equal('recoveryCode' in fields, false);
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
    assert.equal(body.get('mode'), 'password');
    assert.equal(body.get('rememberDevice'), 'false');
    assert.equal(body.has('recoveryCode'), false);
  }
  assert.deepEqual(signInOptions('/admin/inquiries'), { redirect: false, redirectTo: '/admin/inquiries' });
});

test('only the password-step totp_required signal opens the code step', () => {
  assert.equal(interpretSignInResult({ error: 'CredentialsSignin', code: TOTP_REQUIRED_CODE }, 'password'), 'totp');
  assert.equal(interpretSignInResult({ error: 'CredentialsSignin', code: 'credentials' }, 'password'), 'credentials');
  assert.equal(interpretSignInResult({ error: 'CredentialsSignin', code: 'other' }, 'password'), 'credentials');
  assert.equal(interpretSignInResult(undefined, 'password'), 'credentials');
  assert.equal(interpretSignInResult({ error: null, code: null }, 'password'), 'success');
  assert.equal(interpretSignInResult({ error: 'CredentialsSignin', code: 'credentials' }, 'totp'), 'totp-rejected');
  assert.equal(interpretSignInResult({ error: 'CredentialsSignin', code: TOTP_REQUIRED_CODE }, 'totp'), 'totp-rejected');
});

test('a crafted query does not open the code step or echo the callback', async () => {
  const html = renderToStaticMarkup(await AdminLoginPage({
    searchParams: Promise.resolve({ callbackUrl: 'https://evil.example/phish', error: 'CredentialsSignin', code: TOTP_REQUIRED_CODE }),
  }));
  assert.match(html, /id="admin-login-password"/);
  assert.match(html, /邮箱或密码不正确/);
  assert.match(html, /data-callback="\/admin"/);
  assert.doesNotMatch(html, /admin-login-totp|one-time-code|totp_required|evil\.example/);
  const kept = renderToStaticMarkup(await AdminLoginPage({
    searchParams: Promise.resolve({ callbackUrl: '/admin/inquiries' }),
  }));
  assert.match(kept, /data-callback="\/admin\/inquiries"/);
  assert.doesNotMatch(kept, /role="alert"/);
});

test('totp_required is a CredentialsSignin code and the login page stays outside the admin guard', () => {
  assert.throws(throwTotpRequired, (error: unknown) => error instanceof CredentialsSignin && error.code === TOTP_REQUIRED_CODE);
  const layout = readFileSync('src/app/admin-login/layout.tsx', 'utf8');
  assert.match(layout, /robots: \{ index: false, follow: false \}/);
  assert.match(layout, /referrer: 'no-referrer'/);
  assert.match(layout, /<html lang="zh-CN"/);
  assert.doesNotMatch(layout, /checkAdminSession|adminGate|enforceAdminPage/);
  assert.match(readFileSync('src/app/admin-login/page.tsx', 'utf8'), /export const dynamic = 'force-dynamic'/);
  assert.match(readFileSync('src/auth.ts', 'utf8'), /pages: \{ signIn: '\/admin-login' \}/);
  assert.match(readFileSync('next.config.ts', 'utf8'), /'\/admin-enroll', '\/admin-login'\]\.map\(\(source\) => \(\{ source, headers: adminHeaders \}\)\)/);
});
