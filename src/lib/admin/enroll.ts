/**
 * P1 管理员首次绑定 2FA（/admin-enroll）的纯逻辑，组件只负责状态和渲染。
 * 后端契约见 src/app/api/auth-admin/enroll/**：两个接口都不需要登录、只接受同源 POST。
 * 安全要求：otpauth URI、密钥、密码、恢复码不进日志、URL、浏览器本地存储，二维码只在浏览器本地生成。
 */

export const ENROLL_PATH = '/api/auth-admin/enroll';
export const CONFIRM_PATH = '/api/auth-admin/enroll/confirm';
/** 绑定完成后去登录。回跳地址写死 /admin，不读 URL 里的任何 callback / redirect 参数 */
export const SIGNIN_HREF = '/api/auth/signin?callbackUrl=%2Fadmin';
export const ENROLL_PAGE = '/admin-enroll';

export const STEPS = ['账号验证', '扫码并确认', '保存恢复码'] as const;
/** 1：邮箱 + 初始密码；2：扫码并输入验证码；3：保存恢复码 → 去登录 */
export type Step = 1 | 2 | 3;
export type EnrollState = { step: Step; otpauthUri: string | null; recoveryCodes: string[] | null; saved: boolean; confirmedAt: number | null };
/** 确认用掉的验证码在登录时再用会失败，而且计入账号锁定次数：确认成功后至少等 30 秒（换下一个码）才能去登录 */
export const NEXT_CODE_WAIT_MS = 30_000;

/** 错误文案按 UX 稿（spec §6）；forbidden_origin 多一句联系运维（APP_ORIGIN 配错时刷新没用） */
export const ERROR_TEXT: Record<string, string> = {
  bad_credentials: '邮箱或密码错误，或该账号已绑定',
  bad_totp: '验证码不正确或已过期',
  invalid: '请求无效，请刷新页面重试',
  rate_limited: '尝试过多，请稍后再试',
  forbidden_origin: '请求无效，请刷新页面重试；如果一直出现，可能是站点配置错误，请联系运维',
  network: '网络错误，请检查网络后重试',
  code_incomplete: '请输入 6 位数字验证码',
};
export const errorText = (code: string | undefined | null): string => (code && ERROR_TEXT[code]) || '操作失败，请稍后再试；如果一直失败，请联系运维';

/** 只允许本站的两个 enroll 接口（相对路径），防止误把密码 / URI 发到任何外部地址 */
export function assertEnrollPath(path: string): string {
  if (path !== ENROLL_PATH && path !== CONFIRM_PATH) throw new Error('enroll_path_not_allowed');
  return path;
}

export type EnrollResult<T> = { ok: true; data: T } | { ok: false; code: string };
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** POST 到同源 enroll 接口；返回服务端的错误码（error 字段），网络异常返回 network。不记录任何请求 / 响应内容 */
export async function postEnroll<T>(path: string, body: Record<string, string>, f: Fetch = fetch): Promise<EnrollResult<T>> {
  const url = assertEnrollPath(path); // 不在 try 里：路径不对是代码错误，直接抛出，不会发出请求
  let res: Response;
  try {
    res = await f(url, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { return { ok: false, code: 'network' }; }
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) return { ok: false, code: json?.error || (res.status === 429 ? 'rate_limited' : res.status === 403 ? 'forbidden_origin' : `http_${res.status}`) };
  if (!json) return { ok: false, code: 'unknown' };
  return { ok: true, data: json };
}

/** 从 otpauth://totp/...?secret=XXX 里取密钥（Base32，转大写、去空格）；不是 otpauth/totp 或没有 secret 返回 null */
export function parseSecret(uri: string | null | undefined): string | null {
  if (!uri) return null;
  let u: URL;
  try { u = new URL(uri); } catch { return null; }
  if (u.protocol !== 'otpauth:') return null;
  const s = (u.searchParams.get('secret') ?? '').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z2-7]+=*$/.test(s) ? s.replace(/=+$/, '') : null;
}

/** 密钥按 4 位分组显示，方便手动输入（身份验证器 App 会忽略空格） */
export const groupSecret = (s: string, size = 4): string => (s.match(new RegExp(`.{1,${size}}`, 'g')) ?? []).join(' ');

/**
 * 验证码输入：粘贴 / 自动填充 / 输入的「123 456」「123-456」「 123456 」都只留数字。
 * 全角数字（中文输入法全角模式下的「１２３４５６」）先转成半角再保留；其他字符一律丢弃。
 * 超过 6 位不截断（UX + 全栈：静默截断会让用户以为粘对了），交给 codeCheck 判成 'long'，页面提示并禁止提交。
 * 以后要改回「只留前 6 位」，在这一行末尾加 `.slice(0, CODE_LEN)` 即可。
 * 输入框上不设 maxLength：浏览器会先按原始字符数截断（「751 940」被截成「751 94」），丢掉最后一位。
 */
export const CODE_LEN = 6;
export const normalizeCode = (v: string): string =>
  v.replace(/[\uFF10-\uFF19]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/\D+/g, '');
/** 'ok' 正好 6 位可以提交；'short' 不足 6 位（只禁用提交，不提示）；'long' 超过 6 位（提示 + 禁用提交） */
export type CodeCheck = 'ok' | 'short' | 'long';
export const codeCheck = (code: string): CodeCheck => (code.length === CODE_LEN ? 'ok' : code.length < CODE_LEN ? 'short' : 'long');
export const isCompleteCode = (v: string): boolean => /^\d{6}$/.test(v);

/** 不能跳步：1→2 只能由 enroll 接口成功触发，2→3 只能由 confirm 接口成功触发，没有返回、没有「重新生成」 */
export const INITIAL: EnrollState = { step: 1, otpauthUri: null, recoveryCodes: null, saved: false, confirmedAt: null };
export const afterEnroll = (s: EnrollState, otpauthUri: string): EnrollState =>
  s.step === 1 && parseSecret(otpauthUri) ? { ...s, step: 2, otpauthUri } : s;
export const afterConfirm = (s: EnrollState, codes: string[], now: number): EnrollState =>
  s.step === 2 && codes.length > 0 ? { step: 3, otpauthUri: null, recoveryCodes: codes, saved: false, confirmedAt: now } : s;
/** 还要等多少毫秒才能去登录（确认成功后 30 秒） */
export const waitLeft = (s: EnrollState, now: number): number =>
  s.confirmedAt === null ? NEXT_CODE_WAIT_MS : Math.max(0, s.confirmedAt + NEXT_CODE_WAIT_MS - now);
/** 「去登录」可用：第 3 步、勾了「我已保存恢复码」、确认后已过 30 秒 */
export const canFinish = (s: EnrollState, now: number): boolean => s.step === 3 && s.saved && !!s.recoveryCodes?.length && waitLeft(s, now) === 0;
/** 正在绑定中（离开页面要提醒）：已经拿到密钥、还没去登录 */
export const inProgress = (s: EnrollState): boolean => s.step >= 2;
/** 进度条：第几步的状态 */
export const stepStatus = (current: Step, n: Step): 'done' | 'current' | 'todo' => (current > n ? 'done' : current === n ? 'current' : 'todo');

/** 下载的恢复码 .txt：按 UX 稿，10 行，每行一个码（CRLF，记事本也能正常显示） */
export const recoveryTxt = (codes: readonly string[]): string => codes.map((c) => `${c}\r\n`).join('');
export const recoveryFilename = 'packjoyu-admin-recovery-codes.txt';
