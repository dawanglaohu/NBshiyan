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
export const fmtDate = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });
