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
  CHALLENGE_INVALID_CODE,
  interpretSignInResult,
  loginCopy,
  loginHtmlLang,
  passwordCredentials,
  pickLoginLang,
  RATE_LIMITED_CODE,
  signInOptions,
  totpCredentials,
  TOTP_REQUIRED_CODE,
  TOTP_SETUP_REQUIRED_CODE,
} from '../src/lib/admin/login-step';
import { adminCallbackPath } from '../src/lib/admin/safe-callback';

const forbidden = /name="(?:recoveryCode|rememberDevice|mode)"|recoveryCode|rememberDevice|\bmode\b/i;

function markup(props: { callbackUrl?: string; urlError?: boolean; initialStep?: 'password' | 'totp' | 'setup'; initialEmail?: string; initialLang?: 'zh' | 'en' | 'ru' }) {
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
    assert.match(html, new RegExp(copy.showPassword));
    assert.match(html, /aria-pressed="false"/);
    assert.match(html, /<button(?=[^>]*class="lg-submit")(?=[^>]*disabled)[^>]*>/);
    assert.doesNotMatch(html, /lg-langs|admin-login-totp|one-time-code/);
    assert.doesNotMatch(html, forbidden);
  }
});

test('totp step keeps a readonly email, offers back, and drops the password field', () => {
  const html = markup({ initialStep: 'totp', initialEmail: 'ada@example.com' });
  assert.match(html, /id="admin-login-email"[^>]*value="ada@example.com"/);
  assert.match(html, /id="admin-login-email"[^>]*read[Oo]nly/);
  assert.match(html, />返回</);
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
  const code = totpCredentials('001234');
  assert.deepEqual(code, { totp: '001234', mode: 'password', rememberDevice: false });
  assert.equal('email' in code, false);
  assert.equal('password' in code, false);
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
  assert.equal(interpretSignInResult({ error: 'CredentialsSignin', code: TOTP_SETUP_REQUIRED_CODE }, 'password'), 'setup');
  assert.equal(interpretSignInResult({ error: 'CredentialsSignin', code: RATE_LIMITED_CODE }, 'password'), 'rate-limited');
  assert.equal(interpretSignInResult({ error: 'CredentialsSignin', code: RATE_LIMITED_CODE }, 'totp'), 'rate-limited');
  assert.equal(interpretSignInResult({ error: 'CredentialsSignin', code: CHALLENGE_INVALID_CODE }, 'totp'), 'challenge-invalid');
});

test('a crafted query does not open the code step or echo the callback', async () => {
  const html = renderToStaticMarkup(await AdminLoginPage({
    searchParams: Promise.resolve({ callbackUrl: 'https://evil.example/phish', error: 'CredentialsSignin', code: TOTP_REQUIRED_CODE }),
  }));
  assert.match(html, /id="admin-login-password"/);
  assert.match(html, /邮箱或密码不正确/);
  assert.match(html, /data-callback="\/admin\/inquiries"/);
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
  assert.match(layout, /const lang = await loginDocumentLang\(\)/);
  assert.match(layout, /<html lang=\{lang\}/);
  assert.equal(loginHtmlLang('zh'), 'zh-CN');
  assert.doesNotMatch(layout, /checkAdminSession|adminGate|enforceAdminPage/);
  assert.match(readFileSync('src/app/admin-login/page.tsx', 'utf8'), /export const dynamic = 'force-dynamic'/);
  assert.match(readFileSync('src/auth.ts', 'utf8'), /pages: \{ signIn: '\/admin-login' \}/);
  assert.match(readFileSync('next.config.ts', 'utf8'), /'\/admin-enroll', '\/admin-login'\]\.map\(\(source\) => \(\{ source, headers: adminHeaders \}\)\)/);
});

test('copy, callback, and language follow the admin sign-in rules', () => {
  const zh = loginCopy('zh');
  const en = loginCopy('en');
  const ru = loginCopy('ru');
  assert.equal(zh.setupRequired, '后台必须开启两步验证，请使用邮件里的绑定链接完成设置；链接失效请联系管理员重新发送。');
  assert.equal(en.setupRequired, 'Two-step verification is required for the admin. Please use the setup link in your email; if it has expired, ask an administrator to resend it.');
  assert.equal(ru.setupRequired, 'Для входа в панель нужна двухэтапная проверка. Воспользуйтесь ссылкой из письма; если она истекла, попросите администратора отправить её снова.');
  assert.equal(zh.rateLimited, '尝试次数过多，请稍后再试');
  assert.equal(en.rateLimited, 'Too many attempts. Please try again later.');
  assert.equal(ru.rateLimited, 'Слишком много попыток. Попробуйте позже.');
  assert.equal(zh.challengeExpired, '验证已超时，请重新输入密码');
  assert.equal(en.challengeExpired, 'Verification timed out. Please enter your password again.');
  assert.equal(ru.challengeExpired, 'Время подтверждения истекло. Введите пароль ещё раз.');
  assert.equal(ru.busy, 'Выполняется вход');
  assert.equal(ru.badCredentials, 'Неверный адрес эл. почты или пароль');
  assert.equal(ru.back, 'Назад');
  assert.equal(pickLoginLang(null), 'zh');
  assert.equal(pickLoginLang('fr, en;q=0.8'), 'en');
  assert.equal(pickLoginLang('en;q=0.2, zh;q=0.9'), 'zh');
  assert.equal(pickLoginLang('ru;q=0, en;q=0.4'), 'en');
  assert.equal(adminCallbackPath('/admin'), '/admin');
  assert.equal(adminCallbackPath('/admin/inquiries'), '/admin/inquiries');
  assert.equal(adminCallbackPath('/admin/inquiries?tab=open'), '/admin/inquiries?tab=open');
  assert.equal(adminCallbackPath('https://evil.example/phish'), '/admin/inquiries');
  assert.equal(adminCallbackPath('/other'), '/admin/inquiries');
  assert.equal(adminCallbackPath('/admin/%2e%2e/secret'), '/admin/inquiries');
  assert.equal(adminCallbackPath('/admin/%2Fsecret'), '/admin/inquiries');
  assert.equal(adminCallbackPath('/admin/%5Csecret'), '/admin/inquiries');
  assert.equal(adminCallbackPath(adminCallbackPath('/admin/%2e%2e')), adminCallbackPath('/admin/%2e%2e'));
  const setup = markup({ initialStep: 'setup', initialEmail: 'ada@example.com' });
  assert.match(setup, /role="alert"/);
  assert.match(setup, /后台必须开启两步验证/);
  assert.match(setup, /read[Oo]nly/);
  assert.match(setup, />返回</);
  assert.doesNotMatch(setup, /admin-enroll|qrcode|二维码/);
  const form = readFileSync('src/components/admin/auth/LoginForm.tsx', 'utf8');
  assert.match(form, /commitAndReveal\(alertRef/);
  assert.match(form, /commitAndReveal\(passwordRef/);
  assert.match(form, /setPassword\(''\)/);
  assert.match(form, /totpRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(form, /params\.get\('code'\)|searchParams\.get\('code'\)/);
  const css = readFileSync('src/app/admin-login/login.css', 'utf8');
  assert.match(css, /place-items:\s*start center/);
  assert.match(css, /#F7F5F1/);
  assert.match(css, /PingFang SC/);
  assert.match(css, /Microsoft YaHei/);
  assert.match(css, /opacity:\s*1/);
  assert.match(css, /cursor:\s*progress/);
  assert.doesNotMatch(css, /--pj-/);
});
