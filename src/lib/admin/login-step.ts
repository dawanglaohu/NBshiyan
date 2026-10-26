import { adminCallbackPath } from './safe-callback';

/** 自定义登录页与服务端挑战共用的信号。出现在 Auth.js 的 code 查询参数里，不表示账号是否存在。 */
export const TOTP_REQUIRED_CODE = 'totp_required';
export const TOTP_SETUP_REQUIRED_CODE = 'totp_setup_required';
export const RATE_LIMITED_CODE = 'rate_limited';
export const CHALLENGE_INVALID_CODE = 'challenge_invalid';

export type LoginLang = 'zh' | 'en' | 'ru';
export type LoginStep = 'password' | 'totp' | 'setup';

const COPY = {
  zh: {
    title: '登录',
    email: '邮箱',
    password: '密码',
    totp: '验证码',
    submit: '登录',
    busy: '正在登录',
    back: '返回',
    showPassword: '显示密码',
    hidePassword: '隐藏密码',
    brand: '管理后台',
    badCredentials: '邮箱或密码不正确',
    badTotp: '验证码不正确',
    setupRequired: '后台必须开启两步验证，请使用邮件里的绑定链接完成设置；链接失效请联系管理员重新发送。',
    rateLimited: '尝试次数过多，请稍后再试',
    challengeExpired: '验证已超时，请重新输入密码',
  },
  en: {
    title: 'Sign in',
    email: 'Email',
    password: 'Password',
    totp: 'Verification code',
    submit: 'Sign in',
    busy: 'Signing in',
    back: 'Back',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    brand: 'Admin',
    badCredentials: 'Email or password is incorrect',
    badTotp: 'The code is incorrect',
    setupRequired: 'Two-step verification is required for the admin. Please use the setup link in your email; if it has expired, ask an administrator to resend it.',
    rateLimited: 'Too many attempts. Please try again later.',
    challengeExpired: 'Verification timed out. Please enter your password again.',
  },
  ru: {
    title: 'Вход',
    email: 'Эл. почта',
    password: 'Пароль',
    totp: 'Код подтверждения',
    submit: 'Войти',
    busy: 'Выполняется вход',
    back: 'Назад',
    showPassword: 'Показать пароль',
    hidePassword: 'Скрыть пароль',
    brand: 'Панель',
    badCredentials: 'Неверный адрес эл. почты или пароль',
    badTotp: 'Неверный код',
    setupRequired: 'Для входа в панель нужна двухэтапная проверка. Воспользуйтесь ссылкой из письма; если она истекла, попросите администратора отправить её снова.',
    rateLimited: 'Слишком много попыток. Попробуйте позже.',
    challengeExpired: 'Время подтверждения истекло. Введите пароль ещё раз.',
  },
} as const;

export type LoginCopy = (typeof COPY)[LoginLang];
export function loginCopy(lang: LoginLang): LoginCopy {
  return COPY[lang];
}

export const LOGIN_LANGS = ['zh', 'en', 'ru'] as const;

/** 按 q 值扫描 Accept-Language。认 zh / en / ru，都没有就用中文。 */
export function pickLoginLang(acceptLanguage: string | null | undefined): LoginLang {
  if (!acceptLanguage) return 'zh';
  const ranked: { lang: LoginLang; q: number; index: number }[] = [];
  for (const [index, part] of acceptLanguage.split(',').entries()) {
    const [rawTag, ...params] = part.split(';');
    const tag = rawTag.trim().toLowerCase();
    if (!tag || tag === '*') continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split('=');
      if (key?.trim().toLowerCase() !== 'q') continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) q = parsed;
    }
    if (!(q > 0)) continue;
    const lang = tag.startsWith('zh') ? 'zh' : tag.startsWith('en') ? 'en' : tag.startsWith('ru') ? 'ru' : null;
    if (!lang) continue;
    ranked.push({ lang, q, index });
  }
  ranked.sort((left, right) => (right.q - left.q) || (left.index - right.index));
  return ranked[0]?.lang ?? 'zh';
}

export function loginHtmlLang(lang: LoginLang): 'zh-CN' | 'en' | 'ru' {
  if (lang === 'en') return 'en';
  if (lang === 'ru') return 'ru';
  return 'zh-CN';
}

async function acceptLanguage(): Promise<string | null> {
  try {
    const { headers } = await import('next/headers');
    return (await headers()).get('accept-language');
  } catch {
    return null;
  }
}

export async function loginPageLang(): Promise<LoginLang> {
  return pickLoginLang(await acceptLanguage());
}

export async function loginDocumentLang(): Promise<'zh-CN' | 'en' | 'ru'> {
  return loginHtmlLang(await loginPageLang());
}

/** 第一步只提交邮箱和密码。mode 与 rememberDevice 固定，不做成输入框。 */
export function passwordCredentials(email: string, password: string) {
  return { email: email.trim(), password, mode: 'password' as const, rememberDevice: false as const };
}

/** 第二步只提交验证码。挑战从 cookie 取，不再带邮箱或密码。 */
export function totpCredentials(totp: string) {
  return { totp, mode: 'password' as const, rememberDevice: false as const };
}

/** redirect:false 让页面留在原地读 code；回跳只用服务端校验过的后台路径。 */
export function signInOptions(callbackUrl: string) {
  return { redirect: false as const, redirectTo: adminCallbackPath(callbackUrl) };
}

export type SignInOutcome = 'success' | 'totp' | 'setup' | 'credentials' | 'totp-rejected' | 'rate-limited' | 'challenge-invalid';

/**
 * 只有密码步骤收到 totp_required 才进入验证码。
 * 地址栏里的 code 不能走这里，调用方不得用它切换步骤。
 */
export function interpretSignInResult(
  result: { error?: string | null; code?: string | null } | undefined,
  step: LoginStep,
): SignInOutcome {
  if (!result || result.error) {
    const code = result?.code;
    const signin = result?.error === 'CredentialsSignin';
    if (signin && step === 'password' && code === TOTP_REQUIRED_CODE) return 'totp';
    if (signin && step === 'password' && code === TOTP_SETUP_REQUIRED_CODE) return 'setup';
    if (signin && code === RATE_LIMITED_CODE) return 'rate-limited';
    if (signin && step === 'totp' && code === CHALLENGE_INVALID_CODE) return 'challenge-invalid';
    if (step === 'totp') return 'totp-rejected';
    return 'credentials';
  }
  return 'success';
}
