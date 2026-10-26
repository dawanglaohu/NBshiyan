/** 自定义登录页与服务端挑战共用的信号。出现在 Auth.js 的 code 查询参数里，不表示账号是否存在。 */
export const TOTP_REQUIRED_CODE = 'totp_required';

export type LoginLang = 'zh' | 'en' | 'ru';
export type LoginStep = 'password' | 'totp';

const COPY = {
  zh: {
    langName: '中文',
    langLabel: '语言',
    title: '登录',
    email: '邮箱',
    password: '密码',
    totp: '验证码',
    submit: '登录',
    busy: '正在登录',
    badCredentials: '邮箱或密码不正确',
    badTotp: '验证码不正确',
  },
  en: {
    langName: 'EN',
    langLabel: 'Language',
    title: 'Sign in',
    email: 'Email',
    password: 'Password',
    totp: 'Verification code',
    submit: 'Sign in',
    busy: 'Signing in',
    badCredentials: 'Email or password is incorrect',
    badTotp: 'The code is incorrect',
  },
  ru: {
    langName: 'RU',
    langLabel: 'Язык',
    title: 'Вход',
    email: 'Эл. почта',
    password: 'Пароль',
    totp: 'Код подтверждения',
    submit: 'Войти',
    busy: 'Вход',
    badCredentials: 'Неверная эл. почта или пароль',
    badTotp: 'Неверный код',
  },
} as const;

export type LoginCopy = (typeof COPY)[LoginLang];
export function loginCopy(lang: LoginLang): LoginCopy {
  return COPY[lang];
}

export const LOGIN_LANGS = ['zh', 'en', 'ru'] as const;

/** 第一步只提交邮箱和密码。mode 与 rememberDevice 固定，不做成输入框。 */
export function passwordCredentials(email: string, password: string) {
  return { email: email.trim(), password, mode: 'password' as const, rememberDevice: false as const };
}

/** 第二步仍用 password 模式，带上内存里的密码和验证码。 */
export function totpCredentials(email: string, password: string, totp: string) {
  return { email: email.trim(), password, totp, mode: 'password' as const, rememberDevice: false as const };
}

/** redirect:false 让页面留在原地读 code；回跳只用服务端校验过的站内路径。 */
export function signInOptions(callbackUrl: string) {
  return { redirect: false as const, redirectTo: callbackUrl };
}

export type SignInOutcome = 'success' | 'totp' | 'credentials' | 'totp-rejected';

/**
 * 只有密码步骤收到 totp_required 才进入验证码。
 * 其余失败都笼统处理。地址栏里的 code 不能走这里，调用方不得用它切换步骤。
 */
export function interpretSignInResult(
  result: { error?: string | null; code?: string | null } | undefined,
  step: LoginStep,
): SignInOutcome {
  if (!result || result.error) {
    if (step === 'password' && result?.error === 'CredentialsSignin' && result.code === TOTP_REQUIRED_CODE) return 'totp';
    return step === 'totp' ? 'totp-rejected' : 'credentials';
  }
  return 'success';
}
