/**
 * #347 后台一次性绑定链接面板的纯逻辑（UX spec v1.0–v1.0.4，接口契约 v2 §2）。
 * 三个签发接口（新建账号、重置他人 2FA、自助重置 2FA）成功时在响应体里多带 enrollLink / expiresAt / expiresTruncated，
 * 只出现这一次，签发后任何接口都拿不回链接。字段缺失（后端 #347 未上线）时返回 null，界面什么都不多显示。
 *
 * 安全（全栈 / 契约 v2）：链接只放在组件 state 里，关闭面板即清掉；不进地址栏、路由 state、localStorage / sessionStorage、
 * console、toast、统计或错误上报。这个文件不做任何日志、存储或网络请求。
 */
export const ADMIN_TIME_ZONE = 'America/Los_Angeles';

/** <源>/admin-enroll#t=<43 位 base64url>；源只允许 http(s)，没有路径、query、凭据 */
export const ENROLL_LINK_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/admin-enroll#t=[A-Za-z0-9_-]{43}$/;

export type IssuedEnrollLink = { link: string; expiresAt: string; truncated: boolean };

/** 从签发接口的响应里取一次性链接；字段缺失、类型不对或格式不符一律返回 null（不报错、不记录响应内容） */
export function pickEnrollLink(res: unknown): IssuedEnrollLink | null {
  if (!res || typeof res !== 'object') return null;
  const r = res as { enrollLink?: unknown; expiresAt?: unknown; expiresTruncated?: unknown };
  if (typeof r.enrollLink !== 'string' || !ENROLL_LINK_RE.test(r.enrollLink)) return null;
  if (typeof r.expiresAt !== 'string' || Number.isNaN(Date.parse(r.expiresAt))) return null;
  return { link: r.enrollLink, expiresAt: r.expiresAt, truncated: r.expiresTruncated === true };
}

/** 截止时间固定按 PT 显示（不跟浏览器时区），UX v1.0.6：「2026-10-19 06:41 PT」，24 小时制。无效时间返回 null */
export function fmtEnrollExpiry(iso: string, timeZone: string = ADMIN_TIME_ZONE): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortGeneric',
  }).formatToParts(d);
  const v = (t: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === t)?.value ?? '';
  const tz = timeZone === ADMIN_TIME_ZONE ? 'PT' : v('timeZoneName');
  return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')} ${tz}`;
}

/**
 * 签发接口 500 `site_url_invalid`（NEXT_PUBLIC_SITE_URL 配错）。后端三个接口都在任何写库之前返回（不建号、不重置、不解锁、旧链接仍有效），
 * 文案按接口分（UX v1.0.6），不显示错误码。重置他人 2FA 走通用的 `site_url_invalid`；新建账号 / 自助重置用带后缀的码。
 */
export type IssueRoute = 'create' | 'reset2fa' | 'self';
export const SITE_URL_INVALID = 'site_url_invalid';
export const SITE_URL_INVALID_TEXT: Record<IssueRoute, string> = {
  create: '账号没有创建：站点地址配置有误，请联系运维。',
  reset2fa: '没有生成绑定链接：站点地址配置有误，请联系运维。',
  self: '2FA 没有重置：站点地址配置有误，请联系运维。', // 自助重置还没有界面，先留常量
};
/** 错误码 → 文案表（合进 UsersAdmin 的 ERR）：`site_url_invalid` = 重置他人 2FA，`site_url_invalid:create` / `:self` 按接口区分 */
export const ISSUE_ERROR_TEXT: Record<string, string> = {
  [SITE_URL_INVALID]: SITE_URL_INVALID_TEXT.reset2fa,
  [`${SITE_URL_INVALID}:create`]: SITE_URL_INVALID_TEXT.create,
  [`${SITE_URL_INVALID}:self`]: SITE_URL_INVALID_TEXT.self,
};
/** 把签发接口抛出的错误码按接口加后缀（只处理 site_url_invalid，其余原样返回） */
export function scopeIssueError(e: unknown, route: IssueRoute): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  return err.message === SITE_URL_INVALID && route !== 'reset2fa' ? new Error(`${SITE_URL_INVALID}:${route}`) : err;
}

/**
 * 新建账号提交（UsersAdmin 用）：成功 → 有链接就 onIssued，再 onCreated（清空表单）；
 * 失败 → 抛出（site_url_invalid 换成 :create），**不调用 onCreated**，表单里填的值（含初始密码）全部保留。
 */
export async function submitCreate<F>(post: (form: F) => Promise<unknown>, form: F, h: { onIssued: (i: IssuedEnrollLink) => void; onCreated: () => void }): Promise<void> {
  let res: unknown;
  try { res = await post(form); } catch (e) { throw scopeIssueError(e, 'create'); }
  const issued = pickEnrollLink(res);
  if (issued) h.onIssued(issued);
  h.onCreated();
}

/** 面板文案（UX spec v1.0 第 7 条 + v1.0.1） */
export const PANEL_TEXT = {
  title: '一次性绑定链接',
  linkLabel: '绑定链接',
  copy: '复制链接',
  copied: '已复制',
  expires: (when: string) => `有效至 ${when}`,
  truncated: '已按账号绑定截止时间缩短',
  warn: '只私信发给本人，离开此页后无法再查看。',
  done: '我已复制',
  leave: '绑定链接还没复制，离开后就不能再查看了。确定离开吗？',
  leaveOk: '离开',
} as const;
/** 「已复制」显示 2 秒后变回「复制链接」 */
export const COPIED_MS = 2_000;

/** 面板状态：签发成功 → 显示；「我已复制」→ 清空（链接从 state 里删掉，不能再查看） */
export type PanelState = { issued: IssuedEnrollLink; email: string } | null;
export type PanelAction = { type: 'issued'; issued: IssuedEnrollLink; email: string } | { type: 'dismiss' };
export function panelReducer(_s: PanelState, a: PanelAction): PanelState {
  return a.type === 'issued' ? { issued: a.issued, email: a.email } : null;
}
