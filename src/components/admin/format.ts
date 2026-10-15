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
export const productName = (slug: string) => PRODUCT_LABEL[slug] ?? slug;
export function relTime(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 60) return `${Math.max(1, m)} 分钟前`;
  if (m < 60 * 24) return `${Math.round(m / 60)} 小时前`;
  if (m < 60 * 48) return '昨天';
  return `${Math.round(m / 1440)} 天前`;
}
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
export const fmtDate = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

/** Auth.js 默认登录页（Credentials：email、password、totp 或 recoveryCode），登录后回到当前页 */
export const loginHref = () => adminLoginHref(typeof location === 'undefined' ? '/admin' : location.pathname + location.search);

/** #225：只有 ADMIN 能改询盘负责人；角色未知时一律按不能改处理 */
export const canAssignInquiry = (role: string | null | undefined) => role === 'ADMIN';
