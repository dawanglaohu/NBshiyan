/**
 * #350 后台「站点设置 · 组织信息」的数据形状、纯逻辑和接口层（UX 字段说明 v1.0 + spec §9；稿件 settings-org-*）。
 * 接口是后端 #367 的 GET/PUT /api/admin/site-settings/organization（仅 ADMIN，同源 cookie）。
 *
 * - 上限、邮箱 / 电话正则和后端 site-settings-model.ts 的 ORG_LIMITS / ORG_EMAIL_RE / ORG_TELEPHONE_RE 一致。
 *   后端那个文件 import 了 sanitize-html，不能进客户端包，所以这里抄一份；tests/admin-org-settings-350.test.ts 逐项核对两边相等，
 *   后端一改测试就会红。前端检查只是提前提示，最终以后端校验为准（400 invalid 的 issues 映射到字段下方）。
 * - 字数一律按 Unicode code point 计（countChars = [...s].length），和后端 zod 的 text(max) 一样按原始输入计。
 * - 没有任何数字类字段（产能、面积、人数、认证、交期、MOQ），也没有带数字的默认值。默认值只做灰色占位，不预填。
 * - 409 冲突沿用 about 的 conflictStep / canSave / writesBlocked（site-settings.ts），文案也共用 SETTINGS_TEXT。
 */
import { countChars } from '@/lib/site-settings/about-rules';
import { issueLine, issuesAlertText, settingsErrorText, VERSION_CONFLICT } from './site-settings';

export { countChars };

export const ORG_LIMITS = {
  nameMax: 100, alternateNameMax: 100, legalNameMax: 150, descriptionMax: 300,
  emailMax: 254, telephoneMax: 40, addressMax: 200, urlMax: 500, sameAsMax: 10,
} as const;
/** 计数器剩这么多字时变提醒色（spec「组织信息字段上限」：剩 30 个字符时） */
export const DESCRIPTION_WARN_REMAINING = 30;
export const ORG_EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
export const ORG_TELEPHONE_RE = /^\+?[0-9][0-9 ()\-.]{2,39}$/;
/** 成立时间年份范围（后端 isValidFoundingDate：1800 至今） */
export const FOUNDING_YEAR_MIN = 1800;

export const ORG_TEXT_FIELDS = ['name', 'alternateName', 'legalName', 'description', 'email', 'telephone', 'address', 'foundingDate', 'logo'] as const;
export type OrgTextField = (typeof ORG_TEXT_FIELDS)[number];
export type OrgField = OrgTextField | 'sameAs';

/** 草稿：所有文字字段都是字符串（空串 = 不填）；sameAs 是界面上的行（可以有空行，保存时去掉） */
export type OrgDraft = Record<OrgTextField, string> & { sameAs: string[] };
export type OrgData = { draft: OrgDraft; version: number; updatedAt: string | null; updatedByName: string | null };

export const emptyOrgDraft = (): OrgDraft => ({ name: '', alternateName: '', legalName: '', description: '', email: '', telephone: '', address: '', foundingDate: '', logo: '', sameAs: [] });

/** 分组和顺序（字段说明 v1.0 的「顺序」列） */
export const ORG_GROUPS = [
  { id: 'basic', label: '基本信息', fields: ['name', 'alternateName', 'legalName', 'description'] },
  { id: 'contact', label: '联系方式', fields: ['email', 'telephone', 'address'] },
  { id: 'other', label: '其他', fields: ['foundingDate', 'logo', 'sameAs'] },
] as const satisfies readonly { id: string; label: string; fields: readonly OrgField[] }[];

/** 标签和提示文字照字段说明 v1.0 原文 */
export const ORG_FIELD_TEXT: Record<OrgField, { label: string; hint: string; public?: true }> = {
  name: { label: '公司名称（对外）', hint: '网站和搜索结果里显示的品牌名' },
  alternateName: { label: '别名', hint: '例如中文品牌名。不填就用默认值「保乐优」' },
  legalName: { label: '公司注册全称', hint: '和营业执照一致' },
  description: { label: '一句话介绍（英文）', hint: '不填就用默认的 manufacturer 那句' },
  email: { label: '对外联系邮箱', hint: '会公开出现在网页代码里', public: true },
  telephone: { label: '对外电话', hint: '带国家区号，例如 +86…', public: true },
  address: { label: '地址', hint: '一行纯文本，会公开', public: true },
  foundingDate: { label: '成立时间', hint: '填年份，例如 2012' }, // UX 定稿：只填年份（替换字段说明 v1.0 的「年份，或年和月」）
  logo: { label: 'Logo 地址', hint: '站内路径或 https 链接' },
  sameAs: { label: '社交主页', hint: '每行一个 https 链接' },
};

export const ORG_TEXT = {
  crumb: '站点设置 / 组织信息',
  h1: '组织信息',
  intro: '这些信息会出现在搜索引擎的结构化数据里，不确定的就不要填。',
  publicTag: '公开',
  urlLabel: '网站地址（只读）',
  urlHint: '来自站点配置，这里不能改',
  saved: '已保存，前台约 1 分钟内生效',
  sameAsAdd: '＋ 添加链接',
  sameAsMaxHint: `最多 ${ORG_LIMITS.sameAsMax} 条`,
  sameAsDuplicate: '和上面的链接重复，保存时会自动去掉',
  sameAsRemove: (n: number) => `删除第 ${n} 条链接`,
  sameAsItem: (n: number) => `社交主页链接（第 ${n} 条）`,
  conflictConfirmBody: '刷新后会载入最新的内容和版本，页面上未保存的修改会丢失。需要保留的话，请先复制再刷新。',
} as const;

/** 默认值只做灰色占位（不预填、不提交）。description 的占位用 SEO 默认句（src/lib/seo/organization-defaults.ts，页面传进来） */
export const ORG_PLACEHOLDER: Partial<Record<OrgTextField, string>> = {
  name: 'PackJoyU',
  alternateName: '保乐优',
  logo: '/… 或 https://…',
};

const MAX: Record<OrgTextField, number> = {
  name: ORG_LIMITS.nameMax, alternateName: ORG_LIMITS.alternateNameMax, legalName: ORG_LIMITS.legalNameMax, description: ORG_LIMITS.descriptionMax,
  email: ORG_LIMITS.emailMax, telephone: ORG_LIMITS.telephoneMax, address: ORG_LIMITS.addressMax, foundingDate: 10, logo: ORG_LIMITS.urlMax,
};

// ───────────────────────── 计数器 ─────────────────────────
/** 一句话介绍的计数器：`n/300`，剩 ≤30 字提醒色，超出红色并禁用保存 */
export function descriptionCounter(s: string): { n: number; max: number; text: string; state: 'ok' | 'warn' | 'over' } {
  const n = countChars(s);
  const max = ORG_LIMITS.descriptionMax;
  const state = n > max ? 'over' : max - n <= DESCRIPTION_WARN_REMAINING ? 'warn' : 'ok';
  return { n, max, text: `${n}/${max}`, state };
}

// ───────────────────────── 链接 ─────────────────────────
const BAD_CHARS = /[\s\\\u0000-\u001f\u007f]/;
function decodeLoose(s: string): string { let c = s; for (let i = 0; i < 3; i++) { try { const n = decodeURIComponent(c); if (n === c) break; c = n; } catch { break; } } return c; }

/** 规范化后的 https 地址（和后端 safeOrgUrl 一样用 URL.toString()）；不合格返回 null。allowSitePath 只给 logo 用 */
export function normalizeOrgUrl(raw: string, allowSitePath = false): string | null {
  const s = raw.trim();
  if (!s || countChars(s) > ORG_LIMITS.urlMax || BAD_CHARS.test(s)) return null;
  if (allowSitePath && s.startsWith('/')) {
    if (s.startsWith('//') || /%2f|%5c/i.test(s.slice(0, 4))) return null;
    const path = s.split(/[?#]/, 1)[0];
    return path.split('/').some((seg) => { const d = decodeLoose(seg); return d === '.' || d === '..'; }) ? null : s;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
    return u.toString();
  } catch { return null; }
}

/** 每一行的状态：空行 / 不合格 / 和前面重复（保存时自动去掉，不算错误）/ 正常 */
export type SameAsRow = { state: 'empty' | 'invalid' | 'duplicate' | 'ok'; url: string | null };
export function sameAsRows(rows: string[]): SameAsRow[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    if (!r.trim()) return { state: 'empty', url: null };
    const u = normalizeOrgUrl(r);
    if (!u) return { state: 'invalid', url: null };
    if (seen.has(u)) return { state: 'duplicate', url: u };
    seen.add(u);
    return { state: 'ok', url: u };
  });
}
/** 「添加链接」：满 10 行就禁用 */
export const canAddSameAs = (rows: string[]): boolean => rows.length < ORG_LIMITS.sameAsMax;
/** 去空行、去重（按规范化后的地址）后要提交的列表；不合格的行原样带上，让后端报 sameAs.<n> */
export function sameAsPayload(rows: string[]): { list: string[]; rowOf: number[] } {
  const st = sameAsRows(rows);
  const list: string[] = []; const rowOf: number[] = [];
  st.forEach((s, i) => {
    if (s.state === 'empty' || s.state === 'duplicate') return;
    list.push(s.state === 'ok' ? rows[i].trim() : rows[i]); rowOf.push(i);
  });
  return { list, rowOf };
}

// ───────────────────────── 成立时间 ─────────────────────────
/**
 * UX 定稿：只有一个「年份」输入框，保存为 YYYY（后端 isValidFoundingDate：YYYY 或 YYYY-MM-DD，1800 至今）。
 * 库里已有 YYYY-MM-DD（例如以前用接口直接写入的）：输入框只显示年份；不改这个字段就原样提交（不丢日期、不编造日期），
 * 改了输入框（哪怕改回同一年）就按输入的 YYYY 保存。
 */
const FULL_DATE_RE = /^(\d{4})-\d{2}-\d{2}$/;
/** 输入框里显示的值：完整日期只显示年份，其他原样 */
export const foundingYearInput = (stored: string): string => FULL_DATE_RE.exec(stored)?.[1] ?? stored;
/** 年份是否合格（空 = 不填，合格） */
export function isValidFoundingYear(s: string, now = new Date()): boolean {
  const t = s.trim();
  if (!t) return true;
  if (FULL_DATE_RE.test(t)) return true; // 未改动的旧值，交给后端判断
  if (!/^\d{4}$/.test(t)) return false;
  const y = Number(t);
  return y >= FOUNDING_YEAR_MIN && y <= now.getFullYear();
}

// ───────────────────────── 校验 ─────────────────────────
export const ORG_ERR = {
  tooLong: (n: number, max: number) => `超出上限：${n} / ${max}`,
  email: '邮箱格式不正确',
  telephone: '电话格式不正确，请带国家区号，只用数字、空格和 + ( ) - .',
  logo: '仅支持站内路径 /… 或 https:// 链接',
  sameAs: '仅支持 https:// 链接',
  sameAsMax: `最多 ${ORG_LIMITS.sameAsMax} 条`,
  date: '成立时间不正确',
  year: `请填 4 位年份（${FOUNDING_YEAR_MIN} 年至今）`,
  generic: '内容不符合要求，请检查',
} as const;

/** 字段错误：key 是字段名，sameAs 的行用 `sameAs.<行号>`（界面行号，从 0 开始） */
export type OrgErrors = Partial<Record<OrgTextField | 'sameAs' | `sameAs.${number}`, string>>;

/** 前端提前检查（= 后端会 400 的情况）。有任何一条就禁用保存 */
export function orgDraftErrors(d: OrgDraft): OrgErrors {
  const e: OrgErrors = {};
  for (const f of ORG_TEXT_FIELDS) {
    const n = countChars(d[f]);
    if (n > MAX[f]) e[f] = ORG_ERR.tooLong(n, MAX[f]);
  }
  const email = d.email.trim();
  if (!e.email && email && !ORG_EMAIL_RE.test(email)) e.email = ORG_ERR.email;
  const tel = d.telephone.trim();
  if (!e.telephone && tel && !ORG_TELEPHONE_RE.test(tel)) e.telephone = ORG_ERR.telephone;
  if (!e.logo && d.logo.trim() && !normalizeOrgUrl(d.logo, true)) e.logo = ORG_ERR.logo;
  if (!e.foundingDate && !isValidFoundingYear(d.foundingDate)) e.foundingDate = ORG_ERR.year;
  if (d.sameAs.length > ORG_LIMITS.sameAsMax) e.sameAs = ORG_ERR.sameAsMax;
  sameAsRows(d.sameAs).forEach((r, i) => { if (r.state === 'invalid') e[`sameAs.${i}`] = ORG_ERR.sameAs; });
  return e;
}

const SERVER_MSG: Record<string, string> = {
  invalid_url: '', invalid_telephone: ORG_ERR.telephone, invalid_date: ORG_ERR.date,
};
/**
 * 后端字段级错误 → 字段下方的文案。后端 #367 用 400 { error: 'invalid', issues: [{ path, message }] }（不是 422）；
 * 这里 400 和 422 都认。sameAs.<n> 的 n 是提交列表里的下标，用 rowOf 换回界面行号。认不出的字段返回 rest，走顶部错误条。
 */
export function mapServerIssues(issues: { path: string; message: string }[], rowOf: number[] = []): { fields: OrgErrors; rest: string[] } {
  const fields: OrgErrors = {}; const rest: string[] = [];
  for (const i of issues) {
    const [head, idx] = String(i.path ?? '').split('.');
    const msg = String(i.message ?? '');
    if (head === 'sameAs') {
      if (idx !== undefined && /^\d+$/.test(idx)) {
        const row = rowOf[Number(idx)] ?? Number(idx);
        fields[`sameAs.${row}`] ??= ORG_ERR.sameAs;
      } else fields.sameAs ??= /at most|too_big|max/i.test(msg) ? ORG_ERR.sameAsMax : ORG_ERR.generic;
      continue;
    }
    if ((ORG_TEXT_FIELDS as readonly string[]).includes(head)) {
      const f = head as OrgTextField;
      const m = /max (\d+)/.exec(msg);
      const text = SERVER_MSG[msg] || (m ? `超出上限（最多 ${m[1]} 字）`
        : f === 'email' ? ORG_ERR.email : f === 'logo' ? ORG_ERR.logo : f === 'telephone' ? ORG_ERR.telephone : f === 'foundingDate' ? ORG_ERR.date : ORG_ERR.generic);
      fields[f] ??= text;
      continue;
    }
    rest.push(issueLine(i));
  }
  return { fields, rest };
}

// ───────────────────────── 改动 ─────────────────────────
export function orgDirtyFields(saved: OrgDraft, draft: OrgDraft): OrgField[] {
  return ([...ORG_TEXT_FIELDS, 'sameAs'] as OrgField[]).filter((f) => (f === 'sameAs' ? JSON.stringify(saved.sameAs) !== JSON.stringify(draft.sameAs) : saved[f] !== draft[f]));
}
/** 保存条「有未保存的修改（联系方式）」：按分组名列出 */
export function orgDirtySummary(saved: OrgDraft, draft: OrgDraft): string {
  const fs = orgDirtyFields(saved, draft);
  return ORG_GROUPS.filter((g) => g.fields.some((f) => fs.includes(f))).map((g) => g.label).join('、');
}

// ───────────────────────── 接口层 ─────────────────────────
type View = Partial<Record<OrgTextField, string>> & { version?: number; sameAs?: string[]; updatedAt?: string | null; updatedByName?: string | null };
export const orgFromView = (v: View): OrgData => {
  const draft = emptyOrgDraft();
  for (const f of ORG_TEXT_FIELDS) if (typeof v[f] === 'string') draft[f] = v[f] as string;
  draft.sameAs = Array.isArray(v.sameAs) ? v.sameAs.filter((x): x is string => typeof x === 'string') : [];
  return { draft, version: typeof v.version === 'number' ? v.version : 0, updatedAt: v.updatedAt ?? null, updatedByName: v.updatedByName ?? null };
};

/** PUT 请求体：字段名和后端 OrganizationPutInput（.strict）一一对应；整份替换，空串 = 不设置。expectedVersion = 读取时的 version */
export function orgPutBody(d: OrgDraft, expectedVersion: number): { body: Record<string, unknown>; rowOf: number[] } {
  const { list, rowOf } = sameAsPayload(d.sameAs);
  const body: Record<string, unknown> = { expectedVersion };
  for (const f of ORG_TEXT_FIELDS) body[f] = f === 'description' ? d[f] : d[f].trim();
  body.sameAs = list;
  return { body, rowOf };
}

export type OrgSaveResult =
  | { ok: true; data: OrgData }
  | { ok: false; code: string; currentVersion?: number; fieldErrors?: OrgErrors; rest?: string[] };
export const isOrgConflict = (r: OrgSaveResult): boolean => !r.ok && r.code === VERSION_CONFLICT;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export const ORG_API = '/api/admin/site-settings/organization';

export function createOrgSettingsApi(f: Fetch) {
  const call = async (init?: RequestInit): Promise<{ ok: true; body: unknown } | { ok: false; status: number; body: Record<string, unknown> }> => {
    let res: Response;
    try { res = await f(ORG_API, { credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...init }); }
    catch { return { ok: false, status: 0, body: { error: 'network' } }; }
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return res.ok ? { ok: true, body } : { ok: false, status: res.status, body };
  };
  const codeOf = (r: { status: number; body: Record<string, unknown> }) => (r.status === 401 ? 'unauthorized' : typeof r.body.error === 'string' && r.body.error ? r.body.error : r.status ? `http_${r.status}` : 'network');
  return {
    async load(): Promise<OrgData> {
      const r = await call();
      if (!r.ok) throw new Error(codeOf(r));
      return orgFromView(r.body as View);
    },
    /** 带读取时的 version；409 原样返回 code，currentVersion 绝不用来自动重交 */
    async save(d: OrgDraft, expectedVersion: number): Promise<OrgSaveResult> {
      const { body, rowOf } = orgPutBody(d, expectedVersion);
      const r = await call({ method: 'PUT', body: JSON.stringify(body) });
      if (r.ok) return { ok: true, data: orgFromView(((r.body as { content?: View }).content ?? {}) as View) };
      const code = codeOf(r);
      if (code === VERSION_CONFLICT) return { ok: false, code, ...(typeof r.body.currentVersion === 'number' ? { currentVersion: r.body.currentVersion } : {}) };
      if ((r.status === 400 || r.status === 422) && Array.isArray(r.body.issues) && r.body.issues.length) {
        const m = mapServerIssues(r.body.issues as { path: string; message: string }[], rowOf);
        return { ok: false, code, fieldErrors: m.fields, rest: m.rest };
      }
      return { ok: false, code };
    },
  };
}
export type OrgSettingsApi = ReturnType<typeof createOrgSettingsApi>;

/**
 * 保存失败时页面怎么显示：能对上字段的放字段下方；对不上字段的 issue、400 / 422 没带 issues、其他错误，
 * 一律进顶部错误条（alert），不会悄悄丢掉。409 不走这里（conflictStep）。
 */
export function saveFailureView(r: Extract<OrgSaveResult, { ok: false }>): { fieldErrors: OrgErrors; alert: string | null } {
  const fieldErrors = r.fieldErrors ?? {};
  const rest = r.rest ?? [];
  if (rest.length) return { fieldErrors, alert: issuesAlertText(r.code, rest) };
  return { fieldErrors, alert: Object.keys(fieldErrors).length ? null : issuesAlertText(r.code) };
}
export const orgSettingsApi: OrgSettingsApi = createOrgSettingsApi((input, init) => fetch(input, init));
export const orgErrorText = settingsErrorText;
