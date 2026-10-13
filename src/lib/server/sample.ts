import { z } from 'zod';

export const SAMPLE_MAX_ITEMS = 5;
export const SAMPLE_EMAIL_WINDOW_DAYS = 30; // 每个规范化邮箱 30 天 1 次
export const SAMPLE_IP_LIMIT = 3; // 每 IP 30 天 3 次
const GMAIL = new Set(['gmail.com', 'googlemail.com']);

/** 规范化邮箱：小写、去掉 +后缀；Gmail 去掉本地部分的点，googlemail 归一为 gmail */
export function normalizeEmail(raw: string) {
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  local = local.split('+')[0];
  if (GMAIL.has(domain)) { local = local.replace(/\./g, ''); domain = 'gmail.com'; }
  return `${local}@${domain}`;
}

const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f<>]*$/, 'bad_chars');
export const ShippingAddress = z.object({
  line1: line(200),
  line2: line(200).optional(),
  city: line(100),
  state: line(100).optional(),
  postalCode: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9 -]+$/),
  country: z.string().trim().length(2).toUpperCase(),
}).strict();
export type ShippingAddress = z.infer<typeof ShippingAddress>;

const maskStr = (s?: string) => (s ? `${s.slice(0, 1)}***` : undefined);
/** 后台默认展示：只留国家、城市首字母、邮编前 2 位 */
export function maskAddress(a: unknown) {
  const p = ShippingAddress.safeParse(a);
  if (!p.success) return a == null ? null : { masked: true };
  return { masked: true, country: p.data.country, city: maskStr(p.data.city), postalCode: `${p.data.postalCode.slice(0, 2)}***`, line1: '***' };
}
