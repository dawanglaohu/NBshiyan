import { adminLoginHref } from '@/lib/admin/safe-callback';
export const PRODUCT_LABEL: Record<string, string> = {
  'corrugated-boxes': '瓦楞纸箱',
  'color-boxes': '彩盒',
  'gift-boxes': '礼盒',
  'pulp-molding': '纸浆模塑',
  'paper-cups': '纸杯',
  'party-supplies': '派对用品',
  'wine-boxes': '酒盒',
  'color-printing': '彩色印刷',
  'offset-printing': '胶印',
  'eco-paper-cups': '印刷咖啡杯',
  'gift-cards': '礼品卡',
  'christmas-merchandise': '圣诞用品'
};
/** 只查自身属性：'constructor'、'__proto__'、'toString' 等原型键回退为 slug */
export const productName = (slug: string) => (Object.prototype.hasOwnProperty.call(PRODUCT_LABEL, slug) ? PRODUCT_LABEL[slug] : slug);
/** 接口错误转成后台可读的提示 */
const ERR: Record<string, string> = {
  invalid: '参数不正确，请检查后重试。',
  invalid_assignee: '负责人无效（账号已禁用或没有询盘权限）。',
  too_large: '内容太长，请删减后重试。',
  rate_limited: '操作太频繁，请稍等一分钟再试。',
  mail_failed: '邮件发送失败，回复没有保存。请稍后重试。',
  anonymized: '此询盘已匿名化，无法修改',
  not_found: '询盘不存在，或不在你的权限范围内。'
};
export function errorText(code: string, prefix = '加载失败') {
  if (ERR[code]) return ERR[code];
  if (code === 'forbidden_origin') return '请求被拒绝：来源校验失败（请从后台页面本身操作，不要跨站或从缓存页面提交）。请刷新页面后重试。';
  if (code === 'unauthorized') return '登录已过期，请重新登录。';
  if (code === 'forbidden') return '没有权限执行这个操作。';
  return `${prefix}：${code}`;
}
/**
 * 后台统一时间格式（#291）：「2026/09/15 00:44」= YYYY/MM/DD HH:mm，月日补零、24 小时制、不显示秒。
 * 默认按浏览器本地时区；timeZone 只给测试和需要固定时区的地方用。无效时间原样返回，不显示 "Invalid Date"。
 */
type DateParts = { year: string; month: string; day: string; hour: string; minute: string };
function dateParts(d: Date, timeZone?: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}),
  }).formatToParts(d);
  const v = (t: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === t)?.value ?? '';
  return { year: v('year'), month: v('month'), day: v('day'), hour: v('hour'), minute: v('minute') };
}

/**
 * 后台完整时间格式（#291）：「2026/09/15 00:44」= YYYY/MM/DD HH:mm，月日补零、24 小时制、不显示秒。
 * 用于匿名化横幅（固定完整格式）和 <time title>。默认按浏览器本地时区；timeZone 只给测试和需要固定时区的地方用。无效时间原样返回。
 */
export function fmtDate(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = dateParts(d, timeZone);
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

const HOUR = 3_600_000;
/**
 * 后台统一时间显示规则（#291 UX）：
 * - 24 小时内（含将来不超过 1 分钟的时钟误差）：相对时间「刚刚 / N 分钟前 / N 小时前」（向下取整，23h59 → 23 小时前）
 * - ≥24 小时、同一年：「MM/DD HH:mm」
 * - 不同年份，或者是将来的时间：完整「YYYY/MM/DD HH:mm」（「同一年」按显示时区判断）
 * 超过 24 小时一律显示绝对时间，不再用相对天数。界面上用 <AdminTime>，它会包一层 <time dateTime title=完整时间>。
 */
export function adminTime(iso: string, opts: { now?: number; timeZone?: string } = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = opts.now ?? Date.now();
  const diff = now - d.getTime();
  if (diff >= -60_000 && diff < 24 * HOUR) {
    const m = Math.floor(Math.max(0, diff) / 60_000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    return `${Math.floor(m / 60)} 小时前`;
  }
  const p = dateParts(d, opts.timeZone);
  if (diff > 0 && dateParts(new Date(now), opts.timeZone).year === p.year) return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** Auth.js 默认登录页（Credentials：email、password、totp 或 recoveryCode），登录后回到当前页 */
export const loginHref = () => adminLoginHref(typeof location === 'undefined' ? '/admin' : location.pathname + location.search);

/** #225：只有 ADMIN 能改询盘负责人；角色未知时一律按不能改处理 */
export const canAssignInquiry = (role: string | null | undefined) => role === 'ADMIN';
