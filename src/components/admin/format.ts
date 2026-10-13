export const PRODUCT_LABEL: Record<string, string> = {
  'corrugated-boxes': '瓦楞纸箱', 'gift-boxes': '礼盒', 'wine-boxes': '酒盒', 'paper-cups': '纸杯', 'molded-pulp': '纸浆模塑', 'color-boxes': '彩盒'
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
export function errorText(code: string) {
  if (code === 'forbidden_origin') return '请求被拒绝：来源校验失败（请从后台页面本身操作，不要跨站或从缓存页面提交）。请刷新页面后重试。';
  if (code === 'unauthorized') return '登录已过期，请重新登录。';
  if (code === 'forbidden') return '没有权限执行这个操作。';
  return `加载失败：${code}`;
}
export const fmtDate = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });
