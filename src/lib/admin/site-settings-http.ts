import { mapAboutServerIssues, type AboutDraft, type AboutSettingsApi, type AboutSettingsData, type SaveResult } from './site-settings';

/**
 * #350 后台「公司介绍」接口（后端 #367，仅 ADMIN，同源 cookie）：
 * - GET  /api/admin/site-settings/about → { enabled, enabledMeta: { version, updatedAt, updatedBy, updatedByName }, locales: { <l>: AdminAboutView | null } }
 * - PUT  /api/admin/site-settings/about/<locale>  body { expectedVersion, title, summary, bodyHtml, stats, home: { title, intro }, imageMeta }（.strict，多余字段 400）
 *        → { locale, changed, content: AdminAboutView }
 * - PUT  /api/admin/site-settings/about/enabled   body { enabled, expectedVersion? } → { enabled, version, changed, updatedAt }
 * - 409 只有一种：{ error: 'version_conflict', currentVersion }。这里原样把 code 交给页面，currentVersion 不用来重交。
 * - 其他错误体 { error }：invalid（带 issues）/ invalid_locale / too_large / rate_limited / forbidden_origin …
 */
type View = {
  version: number; title: string; summary: string; bodyHtml: string;
  stats: { label: string; value: string }[]; home: { title: string; intro: string };
  imageMeta: Record<string, { alt: string; caption: string }>;
  updatedAt: string; updatedByName: string | null;
};
type GetAbout = { enabled: boolean; enabledMeta: { version: number }; locales: Record<string, View | null> };

const BASE = '/api/admin/site-settings/about';

export const draftFromView = (v: View | null | undefined): AboutDraft => (v
  ? { title: v.title, summary: v.summary, bodyHtml: v.bodyHtml, stats: v.stats.map((s) => ({ value: s.value, label: s.label })), homeHeading: v.home.title, homeIntro: v.home.intro, version: v.version, imageMeta: v.imageMeta ?? {}, updatedAt: v.updatedAt || null, updatedByName: v.updatedByName }
  : { title: '', summary: '', bodyHtml: '', stats: [], homeHeading: '', homeIntro: '', version: 0, imageMeta: {}, updatedAt: null, updatedByName: null });

/** PUT 请求体：字段名和后端 AboutPutInput 一一对应；两项都空的数据条不发（后端会当成 empty 400） */
export const putBody = (d: AboutDraft) => ({
  expectedVersion: d.version ?? 0,
  title: d.title,
  summary: d.summary,
  bodyHtml: d.bodyHtml,
  stats: d.stats.filter((s) => s.value.trim() || s.label.trim()).map((s) => ({ label: s.label, value: s.value })),
  home: { title: d.homeHeading, intro: d.homeIntro },
  imageMeta: d.imageMeta ?? {},
});

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Fail = Extract<SaveResult, { ok: false }>;

async function send(f: Fetch, path: string, init?: RequestInit, draft?: AboutDraft): Promise<{ ok: true; body: unknown } | Fail> {
  let res: Response;
  try {
    res = await f(path, { credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...init });
  } catch { return { ok: false, code: 'network' }; }
  const body = await res.json().catch(() => ({})) as { error?: unknown; currentVersion?: unknown; issues?: unknown };
  if (res.ok) return { ok: true, body };
  if (res.status === 401) return { ok: false, code: 'unauthorized' };
  const code = typeof body.error === 'string' && body.error ? body.error : `http_${res.status}`;
  // 400 / 422：能对上字段的进 fieldErrors，对不上的进 rest（顶部错误条）；和 organization 同一套 saveFailureView
  if ((res.status === 400 || res.status === 422) && Array.isArray(body.issues) && body.issues.length) {
    const raw = (body.issues as { path?: unknown; message?: unknown }[]).map((i) => ({ path: typeof i.path === 'string' ? i.path : '', message: typeof i.message === 'string' ? i.message : '' }));
    const m = mapAboutServerIssues(raw, draft); // too_long →「超出上限：n / max」按这次提交的草稿算
    return { ok: false, code, fieldErrors: m.fields, rest: m.rest };
  }
  return code === 'version_conflict' && typeof body.currentVersion === 'number' ? { ok: false, code, currentVersion: body.currentVersion } : { ok: false, code };
}

export function createAboutSettingsApi(f: Fetch): AboutSettingsApi {
  return {
    async load(locales) {
      const r = await send(f, BASE);
      if (!r.ok) throw new Error(r.code);
      const b = r.body as GetAbout;
      return { enabled: b.enabled === true, enabledVersion: b.enabledMeta?.version ?? 0, locales: Object.fromEntries(locales.map((l) => [l, draftFromView(b.locales?.[l])])) };
    },
    async save(changes, base) {
      let data: AboutSettingsData = { ...base, locales: { ...base.locales } };
      for (const [l, d] of Object.entries(changes)) {
        const r = await send(f, `${BASE}/${encodeURIComponent(l)}`, { method: 'PUT', body: JSON.stringify(putBody(d)) }, d);
        if (!r.ok) {
          const done = Object.keys(changes).indexOf(l) > 0;
          return { ...r, ...(done ? { saved: data } : {}) } satisfies SaveResult;
        }
        data = { ...data, locales: { ...data.locales, [l]: draftFromView((r.body as { content: View }).content) } };
      }
      return { ok: true, data };
    },
    async setEnabled(enabled, expectedVersion) {
      const r = await send(f, `${BASE}/enabled`, { method: 'PUT', body: JSON.stringify(expectedVersion === null ? { enabled } : { enabled, expectedVersion }) });
      if (!r.ok) return r;
      const b = r.body as { enabled: boolean; version: number };
      return { ok: true, data: { enabled: b.enabled, enabledVersion: b.version, locales: {} } };
    },
  };
}

export const aboutSettingsApi: AboutSettingsApi = createAboutSettingsApi((input, init) => fetch(input, init));
