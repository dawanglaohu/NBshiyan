/**
 * 品类规格编辑页的表单模型（纯函数，客户端可用，不依赖 Prisma）。
 * 表单里都是字符串；toBody 做客户端校验并转成 PUT /api/admin/specs/:category 的 body（规则与服务端 zod 一致，
 * 服务端仍会再校验一次）。fromView 把 GET 返回的后台视图转回表单。
 */
import { outageFormMessage } from '@/lib/admin/outage-copy';

export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;
export const CURRENCIES = ['USD', 'EUR', 'CNY', 'RUB'] as const;
export const SIZE_UNITS = ['mm'] as const;
export const MOQ_UNITS = ['pcs'] as const;
export const LEAD_UNITS = ['day'] as const;
export const DIMS = ['l', 'w', 'h'] as const;
export const URL_MAX = 2048;

type Dim = (typeof DIMS)[number];
export type CertRow = { key: string; name: string; certNo: string; url: string };
export type SpecForm = {
  sizeMin: Record<Dim, string>; sizeMax: Record<Dim, string>; sizeUnit: string;
  materialEn: string; materialRu: string;
  moqValue: string; moqUnit: string;
  feeMode: 'none' | 'free' | 'paid'; feeAmount: string; feeCurrency: string;
  leadMin: string; leadMax: string; leadUnit: string;
  certifications: CertRow[];
  tradeTerms: string[];
  notesEn: string; notesRu: string;
};
type Loc = { en?: string; ru?: string } | null;
type Dims = { l: number; w: number; h: number };
export type SpecView = {
  size: { min?: Dims; max?: Dims; unit: string } | null;
  material: Loc; moq: { value: number; unit: string } | null;
  sampleFee: { free: true } | { amount: number; currency: string } | null;
  leadTime: { min?: number; max?: number; unit: string } | null;
  certifications: { name: string; certNo?: string; url?: string }[] | null;
  tradeTerms: string[] | null; notes: Loc; updatedAt?: string | null;
};

let seq = 0;
export const newCertRow = (c: Partial<CertRow> = {}): CertRow => ({ key: `c${++seq}`, name: '', certNo: '', url: '', ...c });
const emptyDims = () => ({ l: '', w: '', h: '' });
export function emptyForm(): SpecForm {
  return { sizeMin: emptyDims(), sizeMax: emptyDims(), sizeUnit: 'mm', materialEn: '', materialRu: '', moqValue: '', moqUnit: 'pcs',
    feeMode: 'none', feeAmount: '', feeCurrency: 'USD', leadMin: '', leadMax: '', leadUnit: 'day', certifications: [], tradeTerms: [], notesEn: '', notesRu: '' };
}
const s = (n: number | undefined) => (n === undefined ? '' : String(n));
const dimsToStr = (d?: Dims) => (d ? { l: s(d.l), w: s(d.w), h: s(d.h) } : emptyDims());

export function fromView(v: SpecView): SpecForm {
  const f = emptyForm();
  if (v.size) { f.sizeMin = dimsToStr(v.size.min); f.sizeMax = dimsToStr(v.size.max); f.sizeUnit = v.size.unit; }
  f.materialEn = v.material?.en ?? ''; f.materialRu = v.material?.ru ?? '';
  if (v.moq) { f.moqValue = s(v.moq.value); f.moqUnit = v.moq.unit; }
  if (v.sampleFee && 'free' in v.sampleFee) f.feeMode = 'free';
  else if (v.sampleFee) { f.feeMode = 'paid'; f.feeAmount = String(v.sampleFee.amount); f.feeCurrency = v.sampleFee.currency; }
  if (v.leadTime) { f.leadMin = s(v.leadTime.min); f.leadMax = s(v.leadTime.max); f.leadUnit = v.leadTime.unit; }
  f.certifications = (v.certifications ?? []).map((c) => newCertRow({ name: c.name, certNo: c.certNo ?? '', url: c.url ?? '' }));
  f.tradeTerms = [...(v.tradeTerms ?? [])];
  f.notesEn = v.notes?.en ?? ''; f.notesRu = v.notes?.ru ?? '';
  return f;
}

/** 与服务端 normalizeUrlSchemeHost 一致：协议和主机名转小写，路径原样保留 */
export function normalizeUrlSchemeHost(u: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/.exec(u);
  if (!m) return u;
  const auth = m[2];
  const at = auth.lastIndexOf('@');
  const host = at >= 0 ? auth.slice(0, at + 1) + auth.slice(at + 1).toLowerCase() : auth.toLowerCase();
  return m[1].toLowerCase() + '://' + host + u.slice(m[0].length);
}

/**
 * URL 是否带 userinfo（user@host、user:pass@host、空的 :@、百分号编码的 %40 等）。
 * 先按 WHATWG 规则去掉制表/换行，再取协议后的 authority（特殊协议里 \ 等同 /，且 https:host 也会被当成 https://host），
 * 看里面有没有 @ 或 %40；同时以 new URL() 解析出的 username/password 兜底。
 */
export function hasUserinfo(u: string): boolean {
  const s = u.replace(/[\t\n\r]/g, '').trim();
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:[\/\\]*([^\/\\?#]*)/.exec(s);
  if (m && (m[1].includes('@') || /%40/i.test(m[1]))) return true;
  try { const x = new URL(s); return x.username !== '' || x.password !== ''; } catch { return false; }
}

/** 证书链接（前后台共用这一个校验）：能被 new URL() 解析、协议正好是 https:、不带 userinfo、长度 ≤ 2048 */
export function isHttpsUrl(u: string): boolean {
  if (u.length > URL_MAX) return false;
  if (hasUserinfo(u)) return false;
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

export type FieldErrors = Record<string, string>;
const INT = /^\d+$/;
function int(errors: FieldErrors, key: string, raw: string, min: number, max: number, label: string): number | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  if (!INT.test(t)) { errors[key] = `${label}必须是整数`; return undefined; }
  const n = Number(t);
  if (n < min || n > max) { errors[key] = `${label}范围 ${min}–${max}`; return undefined; }
  return n;
}
function loc(en: string, ru: string, max: number, key: string, errors: FieldErrors) {
  const o: { en?: string; ru?: string } = {};
  if (en.trim()) o.en = en.trim();
  if (ru.trim()) o.ru = ru.trim();
  if ((o.en?.length ?? 0) > max || (o.ru?.length ?? 0) > max) errors[key] = `最多 ${max} 个字符`;
  return Object.keys(o).length ? o : null;
}

/** 客户端校验 + 生成 PUT body。有错误时 body 为 null。 */
export function toBody(f: SpecForm): { body: Record<string, unknown> | null; errors: FieldErrors } {
  const e: FieldErrors = {};
  const dims = (d: Record<Dim, string>, which: 'min' | 'max') => {
    const filled = DIMS.filter((k) => d[k].trim());
    if (!filled.length) return undefined;
    if (filled.length < 3) { e[`size.${which}`] = '长、宽、高要么都填，要么都不填'; return undefined; }
    const out = {} as Dims;
    for (const k of DIMS) { const n = int(e, `size.${which}.${k}`, d[k], 1, 10_000, '尺寸'); if (n === undefined) return undefined; out[k] = n; }
    return out;
  };
  const min = dims(f.sizeMin, 'min'), max = dims(f.sizeMax, 'max');
  if (min && max) for (const k of DIMS) if (min[k] > max[k]) e[`size.max.${k}`] = '最大尺寸不能小于最小尺寸';
  if (!(SIZE_UNITS as readonly string[]).includes(f.sizeUnit)) e['size.unit'] = '单位无效';

  const moq = int(e, 'moq.value', f.moqValue, 1, 100_000_000, '起订量');
  if (!(MOQ_UNITS as readonly string[]).includes(f.moqUnit)) e['moq.unit'] = '单位无效';

  let sampleFee: unknown = null;
  if (f.feeMode === 'free') sampleFee = { free: true };
  else if (f.feeMode === 'paid') {
    const t = f.feeAmount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(t) || Number(t) <= 0 || Number(t) > 100_000) e['sampleFee.amount'] = '金额须大于 0，最多两位小数，不超过 100000';
    if (!(CURRENCIES as readonly string[]).includes(f.feeCurrency)) e['sampleFee.currency'] = '币种无效';
    sampleFee = { amount: Number(t), currency: f.feeCurrency };
  }

  const lmin = int(e, 'leadTime.min', f.leadMin, 1, 365, '交期');
  const lmax = int(e, 'leadTime.max', f.leadMax, 1, 365, '交期');
  if (lmin !== undefined && lmax !== undefined && lmin > lmax) e['leadTime.max'] = '最长交期不能小于最短交期';
  if (!(LEAD_UNITS as readonly string[]).includes(f.leadUnit)) e['leadTime.unit'] = '单位无效';

  if (f.certifications.length > 30) e.certifications = '最多 30 条认证';
  const certs = f.certifications.map((c, i) => {
    const name = c.name.trim(), certNo = c.certNo.trim(), url = normalizeUrlSchemeHost(c.url.trim());
    if (!name) e[`certifications.${i}.name`] = '请填写认证名称';
    else if (name.length > 80) e[`certifications.${i}.name`] = '最多 80 个字符';
    if (certNo.length > 80) e[`certifications.${i}.certNo`] = '最多 80 个字符';
    if (!certNo && !url) e[`certifications.${i}.certNo`] = '证书编号和链接至少填一个';
    if (url && !isHttpsUrl(url)) e[`certifications.${i}.url`] = '链接必须是 https:// 开头的有效地址，不能包含用户名或密码（≤ 2048 字符）';
    return { name, ...(certNo ? { certNo } : {}), ...(url ? { url } : {}) };
  });

  const bad = f.tradeTerms.filter((t) => !(INCOTERMS as readonly string[]).includes(t));
  if (bad.length || new Set(f.tradeTerms).size !== f.tradeTerms.length) e.tradeTerms = '贸易术语无效或重复';

  const material = loc(f.materialEn, f.materialRu, 300, 'material', e);
  const notes = loc(f.notesEn, f.notesRu, 2_000, 'notes', e);
  if (Object.keys(e).length) return { body: null, errors: e };
  return {
    errors: e,
    body: {
      size: min || max ? { ...(min ? { min } : {}), ...(max ? { max } : {}), unit: f.sizeUnit } : null,
      material,
      moq: moq !== undefined ? { value: moq, unit: f.moqUnit } : null,
      sampleFee,
      leadTime: lmin !== undefined || lmax !== undefined ? { ...(lmin !== undefined ? { min: lmin } : {}), ...(lmax !== undefined ? { max: lmax } : {}), unit: f.leadUnit } : null,
      certifications: certs.length ? certs : null,
      tradeTerms: f.tradeTerms.length ? INCOTERMS.filter((t) => f.tradeTerms.includes(t)) : null,
      notes,
    },
  };
}

const OUTAGE_FORM = outageFormMessage();
const API_ERR: Record<string, string> = {
  unauthorized: '登录已过期，请重新登录', forbidden: '没有权限（需要 ADMIN 或 EDITOR 角色）', forbidden_origin: '请求被拒绝：来源校验失败，请刷新页面后重试',
  rate_limited: '操作太频繁，请稍后再试', too_large: '内容太长', not_found: '品类不存在', invalid: '服务器校验未通过',
  service_unavailable: OUTAGE_FORM, http_503: OUTAGE_FORM,
};
export type ServerIssue = { path: string; message: string };
/** 服务端错误 → 页面提示：总提示 + 按字段的提示（来自 400 的 issues） */
export function serverErrors(status: number, json: unknown): { message: string; fields: FieldErrors } {
  const j = (json && typeof json === 'object' ? json : {}) as { error?: unknown; issues?: unknown };
  const code = typeof j.error === 'string' ? j.error : `http_${status}`;
  const fields: FieldErrors = {};
  if (Array.isArray(j.issues)) for (const it of j.issues as ServerIssue[]) {
    if (it && typeof it.path === 'string' && typeof it.message === 'string') fields[it.path || '_'] = it.message.slice(0, 200);
  }
  return { message: API_ERR[code] ?? `保存失败（${code.slice(0, 40)}）`, fields };
}
