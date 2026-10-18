import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma, type Role, type User } from '@prisma/client';
import { routing } from '@/i18n/routing';
import { cleanPlainText, sanitizeAboutHtml } from './sanitize-about';
import { aboutBodyText, countChars } from '@/lib/site-settings/about-rules';
import {
  ABOUT_ENABLED_KEY, ABOUT_LIMITS as L, IMAGE_ID_RE, aboutKey, parseStoredAbout, parseStoredEnabled, storedVersion,
  ORGANIZATION_KEY, ORG_EMAIL_RE, ORG_LIMITS as OL, ORG_TEXT_FIELDS, ORG_TELEPHONE_RE, isValidFoundingDate, parseStoredOrganization, safeOrgUrl,
  type StoredAbout, type StoredEnabled, type OrganizationFields, type StoredOrganization,
} from './site-settings-model';

/**
 * #350 站点设置后台接口（about 文字部分）。路由文件只负责接线，逻辑在这里，依赖可注入，测试不连库。
 * 顺序：requireAdmin(['ADMIN']) → assertSameOrigin → enforceAdminRateLimit → 校验 → 事务内比对 version 后写入 → 审计 → 刷新缓存。
 */
export const SITE_SETTINGS_ROLES: Role[] = ['ADMIN']; // SALES / EDITOR 403
export const NO_STORE = { 'Cache-Control': 'no-store' } as const;
export const AUDIT_ABOUT_UPDATE = 'site.about.update';
export const AUDIT_ABOUT_VISIBILITY = 'site.about.visibility';
export const AUDIT_ORGANIZATION_UPDATE = 'site.organization.update';
export const MAX_BODY_BYTES = 64 * 1024;

const err = (error: string, status: number, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
const invalid = (issues: { path: string; message: string }[]) => err('invalid', 400, { issues });

export const isSiteLocale = (v: string): boolean => (routing.locales as readonly string[]).includes(v);

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
// 字数按 code point（和 about-rules.ts 一致）
const text = (max: number) => z.string().refine((s) => countChars(s) <= max, { message: `max ${max} chars` });

/** PUT /about/[locale] 请求体：整份替换该语言内容。多余字段一律 400（.strict）。长度按定稿 v1.0。 */
export const AboutPutInput = z.object({
  expectedVersion: z.number().int().min(0),
  title: text(L.titleMax),
  summary: text(L.summaryMax).default(''),
  bodyHtml: z.string().refine((s) => bytes(s) <= L.bodyHtmlBytes, { message: `max ${L.bodyHtmlBytes} bytes` }),
  stats: z.array(z.object({ label: text(L.statLabelMax).refine((s) => s.length > 0, { message: 'empty' }), value: text(L.statValueMax).refine((s) => s.length > 0, { message: 'empty' }) }).strict()).max(L.statsMax).default([]),
  home: z.object({ title: text(L.homeTitleMax), intro: text(L.homeIntroMax) }).strict().default({ title: '', intro: '' }),
  imageMeta: z.record(z.string().regex(IMAGE_ID_RE), z.object({ alt: text(L.imageAltMax), caption: text(L.imageCaptionMax).default('') }).strict())
    .refine((m) => Object.keys(m).length <= L.imagesMax, { message: `max ${L.imagesMax} images` }).default({}),
}).strict();
export type AboutPutInput = z.infer<typeof AboutPutInput>;

export const EnabledPutInput = z.object({ enabled: z.boolean(), expectedVersion: z.number().int().min(0).optional() }).strict();

export type AboutFields = Omit<StoredAbout, 'version' | 'updatedAt' | 'updatedBy'>;
export const ABOUT_FIELDS = ['title', 'summary', 'bodyHtml', 'stats', 'home', 'imageMeta'] as const;

/**
 * 净化 + 第二道校验（净化后的纯文本长度、标题最少 2 字、关键数字不能被清空）。
 * 保存只看上限（ABOUT_LIMITS），允许存不完整的草稿（标题可空、正文可 <50 字）；「完整」只决定前台是否显示，规则在 about-rules.ts。
 */
export function normalizeAboutInput(i: AboutPutInput): { ok: true; fields: AboutFields } | { ok: false; issues: { path: string; message: string }[] } {
  const issues: { path: string; message: string }[] = [];
  const title = cleanPlainText(i.title);
  if (countChars(title) > 0 && countChars(title) < L.titleMin) issues.push({ path: 'title', message: 'too_short' });
  const bodyHtml = sanitizeAboutHtml(i.bodyHtml);
  if (countChars(aboutBodyText(bodyHtml)) > L.bodyTextMax) issues.push({ path: 'bodyHtml', message: 'too_long' });
  const stats = i.stats.map((s, n) => {
    const out = { label: cleanPlainText(s.label), value: cleanPlainText(s.value) };
    if (!out.label || !out.value) issues.push({ path: `stats.${n}`, message: 'empty' });
    return out;
  });
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    fields: {
      title, summary: cleanPlainText(i.summary), bodyHtml, stats,
      home: { title: cleanPlainText(i.home.title), intro: cleanPlainText(i.home.intro, true) },
      imageMeta: Object.fromEntries(Object.entries(i.imageMeta).map(([k, m]) => [k, { alt: cleanPlainText(m.alt), caption: cleanPlainText(m.caption) }])),
    },
  };
}

/** 哪些字段变了（只给审计用字段名，不记内容） */
export function changedFields(before: StoredAbout | null, after: AboutFields): string[] {
  return ABOUT_FIELDS.filter((f) => JSON.stringify(before ? before[f] : emptyFields[f]) !== JSON.stringify(after[f]));
}
const emptyFields: AboutFields = { title: '', summary: '', bodyHtml: '', stats: [], home: { title: '', intro: '' }, imageMeta: {} };

// ---------- 存储 ----------
export type CasResult = { status: 'ok'; value: unknown; changed: boolean } | { status: 'conflict'; currentVersion: number };
export interface SiteSettingsStore {
  readMany(keys: string[]): Promise<Record<string, unknown>>;
  /**
   * 事务内：锁行读当前值 → 比对 version（expected=null 表示不比对）→ build 返回新值写入；build 返回 null 表示没有变化、不写。
   * 并发新建同一个键时，后到的一方按 409 处理。
   */
  compareAndSet(key: string, expected: number | null, build: (current: unknown | null) => Prisma.InputJsonValue | null): Promise<CasResult>;
}

type Db = {
  siteSetting: { findMany(a: { where: { key: { in: string[] } } }): Promise<{ key: string; value: unknown }[]>; findUnique(a: { where: { key: string } }): Promise<{ key: string; value: unknown } | null> };
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
};

export function prismaSiteSettingsStore(db: Db): SiteSettingsStore {
  return {
    async readMany(keys) {
      const rows = await db.siteSetting.findMany({ where: { key: { in: keys } } });
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    async compareAndSet(key, expected, build) {
      try {
        return await db.$transaction(async (tx) => {
          // SELECT … FOR UPDATE：同一个键的并发保存在这里排队，后到的读到新 version 后返回 409
          const rows = await tx.$queryRaw<{ value: string }[]>`SELECT "value"::text AS "value" FROM "SiteSetting" WHERE "key" = ${key} FOR UPDATE`;
          const current: unknown = rows.length ? JSON.parse(rows[0].value) : null;
          const v = storedVersion(current);
          if (expected !== null && v !== expected) return { status: 'conflict', currentVersion: v } as const;
          const next = build(current);
          if (next === null) return { status: 'ok', value: current, changed: false } as const;
          if (rows.length) await tx.siteSetting.update({ where: { key }, data: { value: next } });
          else await tx.siteSetting.create({ data: { key, value: next } });
          return { status: 'ok', value: next, changed: true } as const;
        });
      } catch (e) {
        // 两个请求同时新建同一个键（都带 expectedVersion 0）：主键冲突的一方按版本冲突处理
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const row = await db.siteSetting.findUnique({ where: { key } });
          return { status: 'conflict', currentVersion: storedVersion(row?.value ?? null) };
        }
        throw e;
      }
    },
  };
}

// ---------- 接口 ----------
export type SiteSettingsDeps = {
  requireAdmin(req: Request, roles: Role[]): Promise<{ user: User; ip: string | null } | Response>;
  assertSameOrigin(req: Request): Response | null;
  enforceAdminRateLimit(req: Request, key: string, limit?: number): Promise<Response | null>;
  readJson(req: Request, max: number): Promise<unknown>;
  store: SiteSettingsStore;
  audit(e: { actorId: string; action: string; target: string; meta: Prisma.InputJsonValue; ip: string | null }): Promise<void>;
  revalidate(): void;
  userNames(ids: string[]): Promise<Record<string, string>>;
  now(): Date;
};
const TOO_LARGE = Symbol.for('too_large');

const zodIssues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

export type AdminAboutView = StoredAbout & { updatedByName: string | null };
const adminView = (s: StoredAbout, names: Record<string, string>): AdminAboutView => ({ ...s, updatedByName: s.updatedBy ? names[s.updatedBy] ?? null : null });

/** GET /api/admin/site-settings/about：所有站点语言（routing.locales，含未发布的预览语言）的当前内容 */
export async function handleGetAbout(req: Request, d: SiteSettingsDeps): Promise<Response> {
  const ctx = await d.requireAdmin(req, SITE_SETTINGS_ROLES);
  if (ctx instanceof Response) return ctx;
  const limited = await d.enforceAdminRateLimit(req, 'site_settings.view');
  if (limited) return limited;
  const locales = [...routing.locales];
  const raw = await d.store.readMany([ABOUT_ENABLED_KEY, ...locales.map(aboutKey)]);
  const enabled = parseStoredEnabled(raw[ABOUT_ENABLED_KEY]);
  const stored = Object.fromEntries(locales.map((l) => [l, parseStoredAbout(raw[aboutKey(l)])])) as Record<string, StoredAbout | null>;
  const ids = [...new Set([enabled.updatedBy, ...Object.values(stored).map((s) => s?.updatedBy)].filter((x): x is string => !!x))];
  const names = ids.length ? await d.userNames(ids) : {};
  return NextResponse.json({
    enabled: enabled.enabled,
    enabledMeta: { version: enabled.version, updatedAt: enabled.updatedAt, updatedBy: enabled.updatedBy, updatedByName: enabled.updatedBy ? names[enabled.updatedBy] ?? null : null },
    locales: Object.fromEntries(locales.map((l) => [l, stored[l] ? adminView(stored[l]!, names) : null])),
  }, { headers: NO_STORE });
}

/** PUT /api/admin/site-settings/about/[locale] */
export async function handlePutAboutLocale(req: Request, locale: string, d: SiteSettingsDeps): Promise<Response> {
  const ctx = await d.requireAdmin(req, SITE_SETTINGS_ROLES);
  if (ctx instanceof Response) return ctx;
  const blocked = d.assertSameOrigin(req) ?? (await d.enforceAdminRateLimit(req, 'site_settings.update', 30));
  if (blocked) return blocked;
  if (!isSiteLocale(locale)) return err('invalid_locale', 400);
  const json = await d.readJson(req, MAX_BODY_BYTES);
  if (json === TOO_LARGE) return err('too_large', 413);
  const p = AboutPutInput.safeParse(json);
  if (!p.success) return invalid(zodIssues(p.error));
  const n = normalizeAboutInput(p.data);
  if (!n.ok) return invalid(n.issues);
  const key = aboutKey(locale);
  let fields: string[] = [];
  const r = await d.store.compareAndSet(key, p.data.expectedVersion, (cur) => {
    const before = parseStoredAbout(cur);
    fields = changedFields(before, n.fields);
    if (before && fields.length === 0) return null; // 没有改动：不写、不加版本、不记审计
    const next: StoredAbout = { ...n.fields, version: storedVersion(cur) + 1, updatedAt: d.now().toISOString(), updatedBy: ctx.user.id };
    return next as unknown as Prisma.InputJsonValue;
  });
  if (r.status === 'conflict') return err('version_conflict', 409, { currentVersion: r.currentVersion });
  const saved = parseStoredAbout(r.value)!;
  if (r.changed) {
    await d.audit({ actorId: ctx.user.id, action: AUDIT_ABOUT_UPDATE, target: key, meta: { locale, fields, version: saved.version }, ip: ctx.ip });
    d.revalidate();
  }
  const names = saved.updatedBy === ctx.user.id ? { [ctx.user.id]: ctx.user.name } : saved.updatedBy ? await d.userNames([saved.updatedBy]) : {};
  return NextResponse.json({ locale, changed: r.changed, content: adminView(saved, names) }, { headers: NO_STORE });
}

/** PUT /api/admin/site-settings/about/enabled：「前台显示」开关，单独保存。带 expectedVersion 时同样比对版本。 */
export async function handlePutAboutEnabled(req: Request, d: SiteSettingsDeps): Promise<Response> {
  const ctx = await d.requireAdmin(req, SITE_SETTINGS_ROLES);
  if (ctx instanceof Response) return ctx;
  const blocked = d.assertSameOrigin(req) ?? (await d.enforceAdminRateLimit(req, 'site_settings.update', 30));
  if (blocked) return blocked;
  const json = await d.readJson(req, 1024);
  if (json === TOO_LARGE) return err('too_large', 413);
  const p = EnabledPutInput.safeParse(json);
  if (!p.success) return invalid(zodIssues(p.error));
  const r = await d.store.compareAndSet(ABOUT_ENABLED_KEY, p.data.expectedVersion ?? null, (cur) => {
    const before = cur === null ? null : parseStoredEnabled(cur);
    if (before && before.enabled === p.data.enabled) return null;
    const next: StoredEnabled = { enabled: p.data.enabled, version: storedVersion(cur) + 1, updatedAt: d.now().toISOString(), updatedBy: ctx.user.id };
    return next as unknown as Prisma.InputJsonValue;
  });
  if (r.status === 'conflict') return err('version_conflict', 409, { currentVersion: r.currentVersion });
  const saved = parseStoredEnabled(r.value);
  if (r.changed) {
    await d.audit({ actorId: ctx.user.id, action: AUDIT_ABOUT_VISIBILITY, target: ABOUT_ENABLED_KEY, meta: { fields: ['enabled'], enabled: saved.enabled, version: saved.version }, ip: ctx.ip });
    d.revalidate();
  }
  return NextResponse.json({ enabled: saved.enabled, version: saved.version, changed: r.changed, updatedAt: saved.updatedAt }, { headers: NO_STORE });
}

// ---------- 组织信息 ----------
/** 可选纯文本字段：空串 / 只有空白 = 不设置（不存、不返回） */
const optText = (max: number) => text(max).optional();

/**
 * PUT /api/admin/site-settings/organization 请求体：整份替换。.strict()，多余字段 400。
 * 没有产能、面积、人数、认证、交期这类字段，也没有默认值（默认值由 SEO 的 buildOrganizationJsonLd 补）。
 */
export const OrganizationPutInput = z.object({
  expectedVersion: z.number().int().min(0),
  name: optText(OL.nameMax),
  alternateName: optText(OL.alternateNameMax),
  legalName: optText(OL.legalNameMax),
  description: optText(OL.descriptionMax),
  logo: optText(OL.urlMax),
  email: z.union([z.literal(''), z.string().trim().max(OL.emailMax).regex(ORG_EMAIL_RE)]).optional(),
  telephone: optText(OL.telephoneMax),
  address: optText(OL.addressMax), // 单行纯文本，换行会被去掉
  foundingDate: optText(10),
  sameAs: z.array(z.string().max(OL.urlMax)).max(OL.sameAsMax).default([]),
}).strict();
export type OrganizationPutInput = z.infer<typeof OrganizationPutInput>;

export function normalizeOrganizationInput(i: OrganizationPutInput): { ok: true; fields: OrganizationFields } | { ok: false; issues: { path: string; message: string }[] } {
  const issues: { path: string; message: string }[] = [];
  const fields: OrganizationFields = { sameAs: [] };
  for (const f of ORG_TEXT_FIELDS) {
    const raw = i[f];
    if (raw === undefined) continue;
    if (f === 'logo') {
      if (!raw.trim()) continue;
      const u = safeOrgUrl(raw, true);
      if (!u) issues.push({ path: 'logo', message: 'invalid_url' }); else fields.logo = u;
      continue;
    }
    const t = cleanPlainText(raw);
    if (!t) continue;
    if (f === 'telephone' && !ORG_TELEPHONE_RE.test(t)) { issues.push({ path: f, message: 'invalid_telephone' }); continue; }
    if (f === 'foundingDate' && !isValidFoundingDate(t)) { issues.push({ path: f, message: 'invalid_date' }); continue; }
    fields[f] = t;
  }
  const seen = new Set<string>();
  i.sameAs.forEach((raw, n) => {
    if (!raw.trim()) return;
    const u = safeOrgUrl(raw);
    if (!u) { issues.push({ path: `sameAs.${n}`, message: 'invalid_url' }); return; }
    if (!seen.has(u)) { seen.add(u); fields.sameAs.push(u); }
  });
  if (issues.length) return { ok: false, issues };
  return { ok: true, fields };
}

const ORG_FIELDS = [...ORG_TEXT_FIELDS, 'sameAs'] as const;
export function changedOrganizationFields(before: StoredOrganization | null, after: OrganizationFields): string[] {
  return ORG_FIELDS.filter((f) => JSON.stringify(before?.[f] ?? (f === 'sameAs' ? [] : null)) !== JSON.stringify(after[f] ?? (f === 'sameAs' ? [] : null)));
}


/** GET /api/admin/site-settings/organization：只返回后台存过的值（没有默认值），没存过时 version 0 */
export async function handleGetOrganization(req: Request, d: SiteSettingsDeps): Promise<Response> {
  const ctx = await d.requireAdmin(req, SITE_SETTINGS_ROLES);
  if (ctx instanceof Response) return ctx;
  const limited = await d.enforceAdminRateLimit(req, 'site_settings.view');
  if (limited) return limited;
  const raw = await d.store.readMany([ORGANIZATION_KEY]);
  const s = parseStoredOrganization(raw[ORGANIZATION_KEY]);
  if (!s) return NextResponse.json({ version: 0, sameAs: [], updatedAt: null, updatedBy: null, updatedByName: null }, { headers: NO_STORE });
  const names = s.updatedBy ? await d.userNames([s.updatedBy]) : {};
  return NextResponse.json({ ...s, updatedByName: s.updatedBy ? names[s.updatedBy] ?? null : null }, { headers: NO_STORE });
}

/** PUT /api/admin/site-settings/organization */
export async function handlePutOrganization(req: Request, d: SiteSettingsDeps): Promise<Response> {
  const ctx = await d.requireAdmin(req, SITE_SETTINGS_ROLES);
  if (ctx instanceof Response) return ctx;
  const blocked = d.assertSameOrigin(req) ?? (await d.enforceAdminRateLimit(req, 'site_settings.update', 30));
  if (blocked) return blocked;
  const json = await d.readJson(req, 16 * 1024);
  if (json === TOO_LARGE) return err('too_large', 413);
  const p = OrganizationPutInput.safeParse(json);
  if (!p.success) return invalid(zodIssues(p.error));
  const n = normalizeOrganizationInput(p.data);
  if (!n.ok) return invalid(n.issues);
  let fields: string[] = [];
  const r = await d.store.compareAndSet(ORGANIZATION_KEY, p.data.expectedVersion, (cur) => {
    const before = parseStoredOrganization(cur);
    fields = changedOrganizationFields(before, n.fields);
    if (before && fields.length === 0) return null;
    const next: StoredOrganization = { ...n.fields, version: storedVersion(cur) + 1, updatedAt: d.now().toISOString(), updatedBy: ctx.user.id };
    return next as unknown as Prisma.InputJsonValue;
  });
  if (r.status === 'conflict') return err('version_conflict', 409, { currentVersion: r.currentVersion });
  const saved = parseStoredOrganization(r.value)!;
  if (r.changed) {
    // 只记字段名，不记内容（邮箱、电话、地址都不进审计）
    await d.audit({ actorId: ctx.user.id, action: AUDIT_ORGANIZATION_UPDATE, target: ORGANIZATION_KEY, meta: { fields, version: saved.version }, ip: ctx.ip });
    d.revalidate();
  }
  return NextResponse.json({ changed: r.changed, content: { ...saved, updatedByName: saved.updatedBy === ctx.user.id ? ctx.user.name : null } }, { headers: NO_STORE });
}
