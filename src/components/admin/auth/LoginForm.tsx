'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { signIn } from 'next-auth/react';
import {
  LOGIN_LANGS,
  interpretSignInResult,
  loginCopy,
  passwordCredentials,
  signInOptions,
  totpCredentials,
  type LoginLang,
  type LoginStep,
} from '@/lib/admin/login-step';

type ErrorKind = '' | 'credentials' | 'totp';

/**
 * 密码只留在组件状态里，供第二次提交使用。不写入地址、localStorage 或 sessionStorage。
 * 离开页面时清掉。验证码步骤不渲染密码框。
 */
export default function LoginForm({
  callbackUrl,
  urlError = false,
  initialStep = 'password',
  initialEmail = '',
  initialLang = 'zh',
}: {
  callbackUrl: string;
  urlError?: boolean;
  initialStep?: LoginStep;
  initialEmail?: string;
  initialLang?: LoginLang;
}) {
  const [lang, setLang] = useState<LoginLang>(initialLang);
  const [step, setStep] = useState<LoginStep>(initialStep);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [errorKind, setErrorKind] = useState<ErrorKind>(urlError ? 'credentials' : '');
  const [busy, setBusy] = useState(false);
  const t = loginCopy(lang);
  const error = errorKind === 'credentials' ? t.badCredentials : errorKind === 'totp' ? t.badTotp : '';

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('error') || params.has('code')) {
      params.delete('error');
      params.delete('code');
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
      window.history.replaceState(window.history.state, '', next);
    }
    const clear = () => setPassword('');
    window.addEventListener('pagehide', clear);
    return () => {
      window.removeEventListener('pagehide', clear);
      setPassword('');
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (step === 'password') {
      if (!email.trim() || !password) {
        setErrorKind('credentials');
        return;
      }
      setBusy(true);
      setErrorKind('');
      try {
        const result = await signIn('credentials', { ...passwordCredentials(email, password), ...signInOptions(callbackUrl) });
        const outcome = interpretSignInResult(result, 'password');
        if (outcome === 'success') {
          window.location.assign(callbackUrl);
          return;
        }
        if (outcome === 'totp') {
          setStep('totp');
          setTotp('');
          setErrorKind('');
          return;
        }
        setErrorKind('credentials');
      } catch {
        setErrorKind('credentials');
      } finally {
        setBusy(false);
      }
      return;
    }
    const code = totp.replace(/\s/g, '');
    if (!/^[0-9]{6}$/.test(code)) {
      setErrorKind('totp');
      return;
    }
    setBusy(true);
    setErrorKind('');
    try {
      const result = await signIn('credentials', { ...totpCredentials(email, password, code), ...signInOptions(callbackUrl) });
      const outcome = interpretSignInResult(result, 'totp');
      if (outcome === 'success') {
        window.location.assign(callbackUrl);
        return;
      }
      setErrorKind('totp');
    } catch {
      setErrorKind('totp');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="lg-wrap">
      <form className="lg-card" method="post" data-callback={callbackUrl} onSubmit={onSubmit} noValidate>
        <div className="lg-langs" role="group" aria-label={t.langLabel}>
          {LOGIN_LANGS.map((id) => (
            <button key={id} type="button" aria-pressed={lang === id} onClick={() => setLang(id)}>{loginCopy(id).langName}</button>
          ))}
        </div>
        <h1>{t.title}</h1>
        {error ? <p className="lg-err" role="alert">{error}</p> : null}
        <div className="lg-field">
          <label htmlFor="admin-login-email">{t.email}</label>
          <input
            id="admin-login-email"
            name="email"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        {step === 'password' ? (
          <div className="lg-field">
            <label htmlFor="admin-login-password">{t.password}</label>
            <input
              id="admin-login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
        ) : (
          <div className="lg-field">
            <label htmlFor="admin-login-totp">{t.totp}</label>
            <input
              id="admin-login-totp"
              name="totp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              value={totp}
              onChange={(event) => setTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
              required
            />
          </div>
        )}
        <button className="lg-submit" type="submit" disabled={busy}>{busy ? t.busy : t.submit}</button>
      </form>
    </main>
  );
}
