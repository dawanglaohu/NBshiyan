import type { LoginStep, SignInOutcome } from './login-step';

export type ErrorKind = '' | 'credentials' | 'totp' | 'rate';
export type NoticeKind = '' | 'setup' | 'expired';

export type LoginFormState = {
  step: LoginStep;
  email: string;
  password: string;
  showPassword: boolean;
  totp: string;
  errorKind: ErrorKind;
  notice: NoticeKind;
  busy: boolean;
};

export type LoginFormAction =
  | { type: 'email'; value: string }
  | { type: 'password'; value: string }
  | { type: 'totp'; value: string }
  | { type: 'toggle-password' }
  | { type: 'clear-password' }
  | { type: 'back' }
  | { type: 'submit-password-blocked' }
  | { type: 'submit-password' }
  | { type: 'password-outcome'; outcome: SignInOutcome }
  | { type: 'password-failed' }
  | { type: 'submit-totp-blocked' }
  | { type: 'submit-totp' }
  | { type: 'totp-outcome'; outcome: SignInOutcome }
  | { type: 'totp-failed' };

export function initialLoginFormState(input: { step?: LoginStep; email?: string; urlError?: boolean } = {}): LoginFormState {
  const step = input.step ?? 'password';
  return {
    step,
    email: input.email ?? '',
    password: '',
    showPassword: false,
    totp: '',
    errorKind: input.urlError ? 'credentials' : '',
    notice: step === 'setup' ? 'setup' : '',
    busy: false,
  };
}

/** 邮箱或密码为空时不发请求，已输入的密码留在框里。 */
export function passwordSubmitAction(state: LoginFormState): { type: 'submit-password-blocked' } | { type: 'submit-password'; email: string; password: string } {
  const email = state.email.trim();
  const password = state.password;
  if (!email || !password) return { type: 'submit-password-blocked' };
  return { type: 'submit-password', email, password };
}

/** 不是 6 位数字就不发请求。 */
export function totpSubmitAction(state: LoginFormState): { type: 'submit-totp-blocked' } | { type: 'submit-totp'; code: string } {
  const code = state.totp.replace(/\s/g, '');
  if (!/^[0-9]{6}$/.test(code)) return { type: 'submit-totp-blocked' };
  return { type: 'submit-totp', code };
}

export function reduceLoginForm(state: LoginFormState, action: LoginFormAction): LoginFormState {
  switch (action.type) {
    case 'email':
      return { ...state, email: action.value };
    case 'password':
      return { ...state, password: action.value };
    case 'totp':
      return { ...state, totp: action.value };
    case 'toggle-password':
      return { ...state, showPassword: !state.showPassword };
    case 'clear-password':
      return { ...state, password: '' };
    case 'back':
      return { ...state, totp: '', password: '', showPassword: false, step: 'password', notice: '', errorKind: '' };
    case 'submit-password-blocked':
      return { ...state, notice: '', errorKind: 'credentials' };
    case 'submit-password':
      return { ...state, password: '', busy: true, notice: '', errorKind: '' };
    case 'password-outcome':
      if (action.outcome === 'success') return { ...state, busy: false };
      if (action.outcome === 'totp') return { ...state, step: 'totp', totp: '', errorKind: '', notice: '', busy: false };
      if (action.outcome === 'setup') return { ...state, step: 'setup', notice: 'setup', errorKind: '', busy: false };
      return { ...state, notice: '', errorKind: action.outcome === 'rate-limited' ? 'rate' : 'credentials', busy: false };
    case 'password-failed':
      return { ...state, notice: '', errorKind: 'credentials', busy: false };
    case 'submit-totp-blocked':
      return { ...state, totp: '', notice: '', errorKind: 'totp' };
    case 'submit-totp':
      return { ...state, busy: true, errorKind: '', notice: '' };
    case 'totp-outcome':
      if (action.outcome === 'success') return { ...state, busy: false };
      if (action.outcome === 'challenge-invalid') {
        return { ...state, totp: '', password: '', showPassword: false, step: 'password', errorKind: '', notice: 'expired', busy: false };
      }
      return { ...state, totp: '', notice: '', errorKind: action.outcome === 'rate-limited' ? 'rate' : 'totp', busy: false };
    case 'totp-failed':
      return { ...state, totp: '', notice: '', errorKind: 'totp', busy: false };
    default:
      return state;
  }
}
