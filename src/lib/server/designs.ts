import { z } from 'zod';
import { prisma } from './db';
import { LOGO_ID_RE } from './uploads';
import { categoryMeta } from '@/lib/seo/categoryMeta';
import { categorySlugs } from '@/lib/seo/categorySlugs';
import { SITE_URL } from '@/lib/site';

/** 新方案 id 16 位（约 93 bit），旧数据 10 位 */
export const DESIGN_ID_LEN = 16;
export const DESIGN_ID_RE = /^[A-Za-z0-9]{10,16}$/;
export const DESIGN_TTL_DAYS = 180;
export const DESIGN_GRACE_DAYS = 90; // 过期后再保留 90 天用于返回 410
export const DESIGN_MAX_BODY = 16_000; // 请求体字节上限
export const DESIGN_MAX_CONFIG = 8_000; // 序列化后 config 上限

const CATEGORY_KEYS = new Set(categoryMeta.map((c) => c.key));
const token = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const vec3 = z.tuple([z.number().finite().min(-100).max(100), z.number().finite().min(-100).max(100), z.number().finite().min(-100).max(100)]);
const dim = z.number().finite().positive().max(5000);

/** 方案配置：白名单字段，未知字段一律拒绝，不存任意 JSON */
export const DesignConfig = z.object({
  modelId: z.string().regex(/^[a-z0-9]{20,32}$/).optional(),
  colors: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/), hex).refine((r) => Object.keys(r).length <= 12, 'too_many_colors').optional(),
  size: z.object({ length: dim, width: dim, height: dim, unit: z.enum(['mm', 'cm', 'in']) }).strict().optional(),
  material: token.optional(),
  finishes: z.array(token).max(10).optional(),
  quantity: z.number().int().positive().max(100_000_000).optional(),
  logo: z.object({
    placement: token,
    scale: z.number().finite().min(0.01).max(4).default(1),
    offset: z.tuple([z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1)]).default([0, 0]),
    rotation: z.number().finite().min(-360).max(360).default(0),
  }).strict().optional(),
  camera: z.object({ position: vec3, target: vec3 }).strict().optional(),
}).strict();

export const DesignBody = z.object({
  productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/),
  category: z.string().refine((k) => CATEGORY_KEYS.has(k), 'unknown_category').optional(),
  locale: z.enum(['en', 'ru']).default('en'),
  config: DesignConfig,
  logoUploadId: z.string().regex(LOGO_ID_RE).optional(),
  turnstileToken: z.string().max(4096).optional(),
}).strict();

const notExpired = (now = new Date()) => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

export type PublicDesign = { id: string; productSlug: string; category: string | null; locale: 'en' | 'ru'; config: unknown; expiresAt: Date | null; createdAt: Date; hasLogo: boolean };
export type DesignLookup = { state: 'ok'; design: PublicDesign } | { state: 'expired'; category: string | null; locale: 'en' | 'ru' } | { state: 'missing' };

/** 公开读取。过期的方案保留 DESIGN_GRACE_DAYS 天以返回 410 和分类页链接，之后删除（404）。
 *  不返回 logoUploadId（防止被别人拿去绑定询盘），只返回 hasLogo。方案不可修改。 */
export async function lookupDesign(id: string, now = new Date()): Promise<DesignLookup> {
  if (!DESIGN_ID_RE.test(id)) return { state: 'missing' };
  const d = await prisma.sharedDesign.findUnique({
    where: { id },
    select: { id: true, productSlug: true, category: true, locale: true, config: true, logoUploadId: true, expiresAt: true, createdAt: true },
  });
  if (!d) return { state: 'missing' };
  if (d.expiresAt && d.expiresAt <= now) return { state: 'expired', category: d.category, locale: d.locale };
  const { logoUploadId, ...rest } = d;
  return { state: 'ok', design: { ...rest, hasLogo: !!logoUploadId } };
}

/** 询盘引用的方案必须都存在且未过期 */
export async function liveDesignIds(ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await prisma.sharedDesign.findMany({ where: { id: { in: ids }, ...notExpired() }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** 定时清理：删掉过期超过宽限期且未被询盘引用的方案；以及询盘已删除（GDPR 到期）后留下的、曾被引用（expiresAt=null）的方案 */
export async function cleanupExpiredDesigns(now = new Date()) {
  const r = await prisma.sharedDesign.deleteMany({ where: { items: { none: {} }, OR: [{ expiresAt: { lt: new Date(now.getTime() - DESIGN_GRACE_DAYS * 86_400_000) } }, { expiresAt: null }] } });
  return r.count;
}

/** /s/:id 的 canonical：指向对应分类落地页（按方案语言取 slug）；没有分类时指向产品总页 */
export function canonicalFor(d: { locale: 'en' | 'ru'; category: string | null }) {
  const slug = d.category ? categorySlugs(d.category)?.[d.locale] : null;
  return `${SITE_URL}/${d.locale}/products${slug ? `/${slug}` : ''}`;
}

/** 询价清单里附带的分享链接：只接受本站 /{en|ru}/s/<id>（也兼容 /s/<id>）（相对路径或 SITE_URL 开头），返回 id；其它一律 null */
export function designIdFromShareUrl(raw: string): string | null {
  const v = raw.trim();
  const rel = v.startsWith(SITE_URL + '/') ? v.slice(SITE_URL.length) : v;
  const m = /^(?:\/(?:en|ru))?\/s\/([A-Za-z0-9]{10,16})\/?$/.exec(rel);
  return m ? m[1] : null;
}
