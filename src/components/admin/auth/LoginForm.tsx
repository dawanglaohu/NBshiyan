'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { signIn } from 'next-auth/react';
import { commitAndReveal } from '@/components/admin/reveal-error';
import {
  interpretSignInResult,
  loginCopy,
  passwordCredentials,
  signInOptions,
  totpCredentials,
  type LoginLang,
  type LoginStep,
} from '@/lib/admin/login-step';

type ErrorKind = '' | 'credentials' | 'totp' | 'rate';
type NoticeKind = '' | 'setup' | 'expired';

function PasswordEye({ off }: { off: boolean }) {
  return (
    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {off ? (
        <>
          <path d="M3 3l18 18" />
          <path d="M10.58 10.58a2 2 0 0 0 2.83 2.83" />
          <path d="M9.88 5.09A10.94 10.94 0 0 1 12 5c5 0 9.27 3.11 10.5 7a11.6 11.6 0 0 1-2.16 3.19" />
          <path d="M6.61 6.61A11.8 11.8 0 0 0 1.5 12c.55 1.74 1.64 3.32 3.08 4.61" />
        </>
      ) : (
        <>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

/**
 * 第一步只有真正发出登录请求时才清掉密码。邮箱或密码为空时保留已输入的内容。
 * 第二步只提交验证码，挑战由 cookie 带上。
 * 地址栏里的 error / code 只用来显示笼统错误，不能决定当前步骤。
 */
export default function LoginForm({
  callbackUrl,
  urlError = false,
  initialStep = 'password',
  initialEmail = '',
  initialLang = 'zh',
  signInFn = signIn,
}: {
  callbackUrl: string;
  urlError?: boolean;
  initialStep?: LoginStep;
  initialEmail?: string;
  initialLang?: LoginLang;
  signInFn?: typeof signIn;
}) {
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<LoginStep>(initialStep);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totp, setTotp] = useState('');
  const [errorKind, setErrorKind] = useState<ErrorKind>(urlError ? 'credentials' : '');
  const [notice, setNotice] = useState<NoticeKind>(initialStep === 'setup' ? 'setup' : '');
  const [busy, setBusy] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const totpRef = useRef<HTMLInputElement>(null);
  const t = loginCopy(initialLang);
  const alertText = notice === 'setup' ? t.setupRequired
    : notice === 'expired' ? t.challengeExpired
      : errorKind === 'credentials' ? t.badCredentials
        : errorKind === 'totp' ? t.badTotp
          : errorKind === 'rate' ? t.rateLimited
            : '';

  useEffect(() => { setReady(true); }, []);

  useEffect(() => {
    if (step === 'totp') totpRef.current?.focus();
  }, [step]);

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

  function goBack() {
    commitAndReveal(passwordRef, () => {
      setTotp('');
      setPassword('');
      setShowPassword(false);
      setStep('password');
      setNotice('');
      setErrorKind('');
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy || step === 'setup') return;
    if (step === 'password') {
      const submittedPassword = password;
      const submittedEmail = email.trim();
      if (!submittedEmail || !submittedPassword) {
        commitAndReveal(alertRef, () => {
          setNotice('');
          setErrorKind('credentials');
        });
        return;
      }
      setPassword('');
      setBusy(true);
      setNotice('');
      setErrorKind('');
      try {
        const result = await signInFn('credentials', { ...passwordCredentials(submittedEmail, submittedPassword), ...signInOptions(callbackUrl) });
        const outcome = interpretSignInResult(result, 'password');
        if (outcome === 'success') {
          window.location.assign(callbackUrl);
          return;
        }
        if (outcome === 'totp') {
          setStep('totp');
          setTotp('');
          setErrorKind('');
          setNotice('');
          return;
        }
        if (outcome === 'setup') {
          commitAndReveal(alertRef, () => {
            setStep('setup');
            setNotice('setup');
            setErrorKind('');
          });
          return;
        }
        commitAndReveal(alertRef, () => {
          setNotice('');
          setErrorKind(outcome === 'rate-limited' ? 'rate' : 'credentials');
        });
      } catch {
        commitAndReveal(alertRef, () => {
          setNotice('');
          setErrorKind('credentials');
        });
      } finally {
        setBusy(false);
      }
      return;
    }
    const code = totp.replace(/\s/g, '');
    if (!/^[0-9]{6}$/.test(code)) {
      commitAndReveal(alertRef, () => {
        setTotp('');
        setNotice('');
        setErrorKind('totp');
      });
      return;
    }
    setBusy(true);
    setErrorKind('');
    setNotice('');
    try {
      const result = await signInFn('credentials', { ...totpCredentials(code), ...signInOptions(callbackUrl) });
      const outcome = interpretSignInResult(result, 'totp');
      if (outcome === 'success') {
        window.location.assign(callbackUrl);
        return;
      }
      if (outcome === 'challenge-invalid') {
        commitAndReveal(passwordRef, () => {
          setTotp('');
          setPassword('');
          setShowPassword(false);
          setStep('password');
          setErrorKind('');
          setNotice('expired');
        });
        return;
      }
      commitAndReveal(alertRef, () => {
        setTotp('');
        setNotice('');
        setErrorKind(outcome === 'rate-limited' ? 'rate' : 'totp');
      });
    } catch {
      commitAndReveal(alertRef, () => {
        setTotp('');
        setNotice('');
        setErrorKind('totp');
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="lg-wrap">
      <form className="lg-card" method="post" data-callback={callbackUrl} onSubmit={onSubmit} noValidate>
        <p className="lg-brand">PackJoy<i>U</i><span>{t.brand}</span></p>
        <h1>{t.title}</h1>
        {alertText ? <p id="admin-login-alert" className="lg-err" role="alert" tabIndex={-1} ref={alertRef}>{alertText}</p> : null}
        {step === 'password' ? (
          <>
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
            <div className="lg-field">
              <label htmlFor="admin-login-password">{t.password}</label>
              <div className="lg-pw">
                <input
                  id="admin-login-password"
                  ref={passwordRef}
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <button
                  type="button"
                  className="lg-pw-toggle"
                  aria-label={showPassword ? t.hidePassword : t.showPassword}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  <PasswordEye off={showPassword} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <button type="button" className="lg-back" onClick={goBack}>{t.back}</button>
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
                readOnly
              />
            </div>
          </>
        )}
        {step === 'totp' ? <p className="lg-hint">{t.totpHint}</p> : null}
        {step === 'totp' ? (
          <div className="lg-field">
            <label htmlFor="admin-login-totp">{t.totp}</label>
            <input
              id="admin-login-totp"
              ref={totpRef}
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
        ) : null}
        {step === 'setup' ? null : (
          <button className="lg-submit" type="submit" disabled={!ready || busy} aria-busy={busy}>{busy ? t.busy : t.submit}</button>
        )}
      </form>
    </main>
  );
}
