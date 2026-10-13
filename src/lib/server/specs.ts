import { z } from 'zod';
import { Prisma, type CategorySpec, type Incoterm } from '@prisma/client';
import { categoryMeta } from '@/lib/seo/categoryMeta';

/** 品类 key 以 categoryMeta.ts 为准 */
export const CATEGORY_KEYS: readonly string[] = categoryMeta.map((c) => c.key);
export const isCategoryKey = (k: string) => CATEGORY_KEYS.includes(k);
export const SPECS_TAG = 'category-specs';
export const PUBLIC_CACHE = { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' };
export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const satisfies readonly Incoterm[];
export const CURRENCIES = ['USD', 'EUR', 'CNY', 'RUB'] as const;
export type SpecLocale = 'en' | 'ru';

const text = (max: number) => z.string().trim().max(max);
const Localized = (max: number) => z.object({ en: text(max).optional(), ru: text(max).optional() }).strict();
const mm = z.number().int().min(1).max(10_000);
const Dims = z.object({ l: mm, w: mm, h: mm }).strict();
const days = z.number().int().min(1).max(365);

/** 证书链接只允许能被 new URL() 解析且协议正好是 https: 的地址（拒绝 javascript:、data:、http: 等） */
export function isHttpsUrl(u: string): boolean {
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

export const Certification = z.object({
  name: text(80).min(1),
  certNo: text(80).min(1).optional(),
  url: z.string().trim().max(2048).refine(isHttpsUrl, 'https_url_required').optional(),
}).strict().refine((c) => !!(c.certNo || c.url), { message: 'cert_no_or_url_required' });

/** PUT /api/admin/specs/:category 的 body：整体替换，省略或 null = 清空该字段 */
export const SpecInput = z.object({
  size: z.object({ min: Dims.optional(), max: Dims.optional(), unit: z.literal('mm') }).strict().nullable().optional(),
  material: Localized(300).nullable().optional(),
  moq: z.object({ value: z.number().int().min(1).max(100_000_000), unit: z.literal('pcs') }).strict().nullable().optional(),
  sampleFee: z.union([
    z.object({ free: z.literal(true) }).strict(),
    z.object({ amount: z.number().positive().max(100_000).multipleOf(0.01), currency: z.enum(CURRENCIES) }).strict(),
  ]).nullable().optional(),
  leadTime: z.object({ min: days.optional(), max: days.optional(), unit: z.literal('day') }).strict().nullable().optional(),
  certifications: z.array(Certification).max(30).nullable().optional(),
  tradeTerms: z.array(z.enum(INCOTERMS)).max(INCOTERMS.length).nullable().optional(),
  notes: Localized(2_000).nullable().optional(),
}).strict().superRefine((v, ctx) => {
  const s = v.size;
  if (s && s.min && s.max) for (const d of ['l', 'w', 'h'] as const)
    if (s.min[d] > s.max[d]) ctx.addIssue({ code: 'custom', path: ['size', 'max', d], message: 'size_min_gt_max' });
  const lt = v.leadTime;
  if (lt && lt.min !== undefined && lt.max !== undefined && lt.min > lt.max) ctx.addIssue({ code: 'custom', path: ['leadTime'], message: 'lead_min_gt_max' });
  if (v.tradeTerms && new Set(v.tradeTerms).size !== v.tradeTerms.length) ctx.addIssue({ code: 'custom', path: ['tradeTerms'], message: 'duplicate' });
});
export type SpecInput = z.infer<typeof SpecInput>;

type Loc = { en?: string; ru?: string };
type Dims = { l: number; w: number; h: number };
type Cert = { name: string; certNo?: string; url?: string };
const cleanLoc = (l: Loc | null | undefined): Loc | null => {
  if (!l) return null;
  const o: Loc = {};
  if (l.en) o.en = l.en;
  if (l.ru) o.ru = l.ru;
  return Object.keys(o).length ? o : null;
};
const json = (v: unknown) => (v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

/** 输入 → 数据库字段 */
export function toRow(v: SpecInput) {
  const fee = v.sampleFee ?? null;
  const certs = v.certifications?.length ? v.certifications : null;
  return {
    sizeMin: json(v.size?.min), sizeMax: json(v.size?.max),
    material: json(cleanLoc(v.material)),
    moq: v.moq?.value ?? null,
    sampleFree: fee && 'free' in fee ? true : null,
    sampleFeeAmount: fee && 'amount' in fee ? new Prisma.Decimal(fee.amount.toFixed(2)) : null,
    sampleFeeCurrency: fee && 'amount' in fee ? fee.currency : null,
    leadTimeDaysMin: v.leadTime?.min ?? null, leadTimeDaysMax: v.leadTime?.max ?? null,
    certifications: json(certs),
    tradeTerms: v.tradeTerms ?? [],
    notes: json(cleanLoc(v.notes)),
  };
}

type Row = Pick<CategorySpec, 'sizeMin' | 'sizeMax' | 'material' | 'moq' | 'sampleFeeAmount' | 'sampleFeeCurrency' | 'sampleFree' | 'leadTimeDaysMin' | 'leadTimeDaysMax' | 'certifications' | 'tradeTerms' | 'notes' | 'updatedAt'>;

const sizeOf = (r: Row) => (r.sizeMin || r.sizeMax ? { ...(r.sizeMin ? { min: pickDims(r.sizeMin) } : {}), ...(r.sizeMax ? { max: pickDims(r.sizeMax) } : {}), unit: 'mm' as const } : null);
const pickDims = (d: unknown): Dims => { const x = d as Dims; return { l: x.l, w: x.w, h: x.h }; };
const feeOf = (r: Row) => (r.sampleFree ? { free: true as const } : r.sampleFeeAmount != null && r.sampleFeeCurrency ? { amount: Number(r.sampleFeeAmount), currency: r.sampleFeeCurrency } : null);
const leadOf = (r: Row) => (r.leadTimeDaysMin != null || r.leadTimeDaysMax != null
  ? { ...(r.leadTimeDaysMin != null ? { min: r.leadTimeDaysMin } : {}), ...(r.leadTimeDaysMax != null ? { max: r.leadTimeDaysMax } : {}), unit: 'day' as const } : null);
const certsOf = (r: Row): Cert[] => ((r.certifications as Cert[] | null) ?? []).map((c) => ({ name: c.name, ...(c.certNo ? { certNo: c.certNo } : {}), ...(c.url ? { url: c.url } : {}) }));

/** 后台视图：与 PUT body 同形，未填写为 null */
export function adminView(category: string, r: Row | null) {
  const certs = r ? certsOf(r) : [];
  return {
    category,
    size: r ? sizeOf(r) : null,
    material: (r?.material as Loc | null) ?? null,
    moq: r?.moq != null ? { value: r.moq, unit: 'pcs' as const } : null,
    sampleFee: r ? feeOf(r) : null,
    leadTime: r ? leadOf(r) : null,
    certifications: certs.length ? certs : null,
    tradeTerms: r?.tradeTerms?.length ? r.tradeTerms : null,
    notes: (r?.notes as Loc | null) ?? null,
    updatedAt: r?.updatedAt?.toISOString() ?? null,
  };
}

/** 审计 meta 用：去掉 updatedAt */
export const auditView = (category: string, r: Row | null) => { const { updatedAt: _u, ...v } = adminView(category, r); return v; };

/**
 * 公开视图（单一语言）。显式白名单逐字段构造，绝不展开数据库行；未填写的字段整个省略。
 * 字段对应 schema.org Product，见 docs/API.md。
 */
export function publicView(category: string, r: Row | null, locale: SpecLocale) {
  const out: Record<string, unknown> = { category };
  if (!r) return out;
  const size = sizeOf(r); if (size) out.size = size;
  const mat = (r.material as Loc | null)?.[locale]; if (mat) out.material = mat;
  if (r.moq != null) out.moq = { value: r.moq, unit: 'pcs' };
  const fee = feeOf(r); if (fee) out.sampleFee = fee;
  const lead = leadOf(r); if (lead) out.leadTime = lead;
  const certs = certsOf(r); if (certs.length) out.certifications = certs;
  if (r.tradeTerms?.length) out.tradeTerms = [...r.tradeTerms];
  const note = (r.notes as Loc | null)?.[locale]; if (note) out.notes = note;
  if (Object.keys(out).length > 1) out.updatedAt = r.updatedAt.toISOString();
  return out;
}

export const hasPublicFields = (v: Record<string, unknown>) => Object.keys(v).length > 1;
export const parseLocale = (s: string | null): SpecLocale | null => (s === null || s === 'en' ? 'en' : s === 'ru' ? 'ru' : null);
