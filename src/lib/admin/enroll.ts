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
/** #347 方案 A：绑定链接里的一次性令牌参数名（/admin-enroll#t=<令牌>，放在 fragment 里，浏览器不会发给服务器） */
export const ENROLL_TOKEN_PARAM = 't';

/**
 * #347：从地址栏的 #fragment 里取一次性绑定令牌，并给出去掉 t 之后的地址（页面打开后立即 history.replaceState，令牌只留在内存里）。
 * 令牌格式不对时 token 为 null（仍然从地址栏去掉）。查询参数原样保留；fragment 里的其他键保留。
 */
/** #347 UX v1.0：地址里没有 #t=（直接打开或刷新过）时的「需要绑定链接」页 */
export const NO_TOKEN_TITLE = '需要绑定链接';
export const NO_TOKEN_BODY = '这个页面只能从管理员发给你的绑定链接打开。如果你刚刚刷新了页面，请重新点开那个链接；链接失效的话请联系管理员重新发送。';
export const NO_TOKEN_SIGNIN = '去登录';
/** 有令牌时表单上方的灰色提示（刷新后令牌就没了） */
export const KEEP_PAGE_HINT = '请在这个页面完成绑定，不要刷新或关闭';
/** 页面打开时的令牌状态：unknown = 还没读地址栏（服务端渲染 / 首帧）；none = hash 里没有 t；present = 有 t（格式不对也算，提交时后端回 401） */
export type TokenState = 'unknown' | 'none' | 'present';
export const tokenStateOf = (cleanUrl: string | null): TokenState => (cleanUrl === null ? 'none' : 'present');

export function takeEnrollToken(loc: { pathname: string; search: string; hash: string }): { token: string | null; cleanUrl: string | null } {
  const h = new URLSearchParams(loc.hash.replace(/^#/, ''));
  if (!h.has(ENROLL_TOKEN_PARAM)) return { token: null, cleanUrl: null };
  const raw = h.get(ENROLL_TOKEN_PARAM) ?? '';
  h.delete(ENROLL_TOKEN_PARAM);
  const rest = h.toString();
  return { token: /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null, cleanUrl: `${loc.pathname}${loc.search}${rest ? `#${rest}` : ''}` };
}

export const STEPS = ['账号验证', '扫码并确认', '保存恢复码'] as const;
/** 1：邮箱 + 初始密码；2：扫码并输入验证码；3：保存恢复码 → 去登录 */
export type Step = 1 | 2 | 3;
/** voided：第 2 步验证失败过多、后端已让这次待绑定的密钥失效（#350 稿件 enroll-step2-void），只能重新开始 */
export type EnrollState = { step: Step; otpauthUri: string | null; recoveryCodes: string[] | null; saved: boolean; confirmedAt: number | null; voided: boolean };
/** 确认用掉的验证码在登录时再用会失败，而且计入账号锁定次数：确认成功后至少等 30 秒（换下一个码）才能去登录 */
export const NEXT_CODE_WAIT_MS = 30_000;

/** 错误文案按 UX 稿（spec §6）；forbidden_origin 多一句联系运维（APP_ORIGIN 配错时刷新没用） */
export const ERROR_TEXT: Record<string, string> = {
  // #347 UX v1.0.4：令牌缺失 / 错误 / 过期 / 已用、密码错、锁定中，后端都回同一个 401，文案也不区分
  bad_credentials: '链接无效或已过期、邮箱或密码不正确，或尝试次数过多。请稍后重试；仍然不行的话，请联系管理员重新发送绑定链接。',
  bad_totp: '验证码不正确或已过期',
  invalid: '请求无效，请刷新页面重试',
  rate_limited: '尝试过多，请稍后再试',
  forbidden_origin: '请求无效，请刷新页面重试；如果一直出现，可能是站点配置错误，请联系运维',
  network: '网络错误，请检查网络后重试',
  code_incomplete: '请输入 6 位数字验证码',
};
export const errorText = (code: string | undefined | null): string => (code && ERROR_TEXT[code]) || '操作失败，请稍后再试；如果一直失败，请联系运维';

/**
 * #350「绑定已作废、重新开始」（稿件 enroll-step2-void）：验证码失败次数过多后，后端让这次待绑定的密钥失效，
 * 返回 HTTP 401 `{ error: 'enroll_reset' }`（后端已定）。`bad_credentials`（密码错）和 429 `rate_limited` 不变。
 * 文案不透露账号是否存在，也不显示密钥或验证码。
 */
export const ENROLL_VOID_CODES: readonly string[] = ['enroll_reset'];
export const ENROLL_VOID_TEXT = '验证失败次数过多，此绑定已作废，请重新开始绑定';
export const ENROLL_VOID_HINT = '二维码和密钥已失效，不能再使用。请回到第 1 步，重新输入邮箱和初始密码，获取新的二维码。';
export const ENROLL_VOID_FOOT = '身份验证器 App 里刚添加的旧条目可以删除。';
export const ENROLL_RESTART = '重新开始绑定';
export const isVoidCode = (code: string | null | undefined, codes: readonly string[] = ENROLL_VOID_CODES): boolean => !!code && codes.includes(code);

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
export const INITIAL: EnrollState = { step: 1, otpauthUri: null, recoveryCodes: null, saved: false, confirmedAt: null, voided: false };
export const afterEnroll = (s: EnrollState, otpauthUri: string): EnrollState =>
  s.step === 1 && parseSecret(otpauthUri) ? { ...s, step: 2, otpauthUri } : s;
export const afterConfirm = (s: EnrollState, codes: string[], now: number): EnrollState =>
  s.step === 2 && !s.voided && codes.length > 0 ? { step: 3, otpauthUri: null, recoveryCodes: codes, saved: false, confirmedAt: now, voided: false } : s;
/** 绑定作废：只在第 2 步发生；丢掉 otpauth URI（二维码、密钥不再显示），之后只能 restart 回第 1 步 */
export const afterVoid = (s: EnrollState): EnrollState => (s.step === 2 ? { ...INITIAL, step: 2, voided: true } : s);
/** 还要等多少毫秒才能去登录（确认成功后 30 秒） */
export const waitLeft = (s: EnrollState, now: number): number =>
  s.confirmedAt === null ? NEXT_CODE_WAIT_MS : Math.max(0, s.confirmedAt + NEXT_CODE_WAIT_MS - now);
/** 「去登录」可用：第 3 步、勾了「我已保存恢复码」、确认后已过 30 秒 */
export const canFinish = (s: EnrollState, now: number): boolean => s.step === 3 && s.saved && !!s.recoveryCodes?.length && waitLeft(s, now) === 0;
/** 正在绑定中（离开页面要提醒）：已经拿到密钥、还没去登录 */
/** 作废后没有可丢失的进度，离开不再提醒 */
export const inProgress = (s: EnrollState): boolean => s.step >= 2 && !s.voided;
/** 进度条：第几步的状态 */
export const stepStatus = (current: Step, n: Step): 'done' | 'current' | 'todo' => (current > n ? 'done' : current === n ? 'current' : 'todo');

/** 下载的恢复码 .txt：按 UX 稿，10 行，每行一个码（CRLF，记事本也能正常显示） */
export const recoveryTxt = (codes: readonly string[]): string => codes.map((c) => `${c}\r\n`).join('');
export const recoveryFilename = 'packjoyu-admin-recovery-codes.txt';

/** 后台「重置 2FA」确认框（#347）：「之前发出的绑定链接会立即失效」+「同时会解除这个账号的登录锁定」 */
export const RESET_2FA_CONFIRM = (email: string) =>
  `重置 ${email} 的 2FA？对方会立即退出登录，需要用新的绑定链接重新绑定。之前发出的绑定链接会立即失效，同时会解除这个账号的登录锁定。`;
