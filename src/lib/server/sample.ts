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

/** 只有 ADMIN 和被分配的 SALES 能看完整收货地址；EDITOR 和未分配的 SALES 一律不行 */
export function canViewFullAddress(user: { id: string; role: string }, inquiry: { assigneeId: string | null }) {
  return user.role === 'ADMIN' || (user.role === 'SALES' && inquiry.assigneeId === user.id);
}

export const SAMPLE_ID_RE = /^[a-z0-9]{20,32}$/;

type AddressDeps = {
  findSample: (id: string) => Promise<{ id: string; shippingAddress: unknown; inquiry: { id: string; assigneeId: string | null } } | null>;
  audit: (e: { actorId: string; action: string; target: string; ip: string | null }) => Promise<void>;
};
/** 读取完整地址：无权限和不存在都返回 null（路由按 404 处理，不暴露是否存在）；成功先写审计再返回，审计不含地址内容 */
export async function revealSampleAddress(ctx: { user: { id: string; role: string }; ip: string | null }, sampleId: string, deps: AddressDeps) {
  if (!SAMPLE_ID_RE.test(sampleId)) return null;
  const s = await deps.findSample(sampleId);
  if (!s || !s.shippingAddress || !canViewFullAddress(ctx.user, s.inquiry)) return null;
  await deps.audit({ actorId: ctx.user.id, action: 'sample.address.view', target: s.id, ip: ctx.ip });
  return s.shippingAddress;
}
