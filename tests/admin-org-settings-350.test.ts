import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canAddSameAs, countChars, createOrgSettingsApi, descriptionCounter, emptyOrgDraft, foundingYearInput, FOUNDING_YEAR_MIN, isValidFoundingYear, mapServerIssues,
  normalizeOrgUrl, ORG_EMAIL_RE as C_EMAIL, ORG_ERR, ORG_FIELD_TEXT, ORG_LIMITS as C_LIMITS, ORG_PLACEHOLDER, ORG_TELEPHONE_RE as C_TEL, ORG_TEXT, ORG_TEXT_FIELDS as C_FIELDS,
  orgDirtySummary, orgDraftErrors, orgFromView, orgPutBody, sameAsPayload, saveFailureView, sameAsRows, type OrgDraft,
} from '../src/lib/admin/org-settings';
import { canSave, conflictStep, SETTINGS_TEXT, type ConflictPhase } from '../src/lib/admin/site-settings';
import { ORG_EMAIL_RE, ORG_LIMITS, ORG_TELEPHONE_RE, ORG_TEXT_FIELDS, isValidFoundingDate, safeOrgUrl } from '../src/lib/server/site-settings-model';
import { OrganizationPutInput, normalizeOrganizationInput } from '../src/lib/server/site-settings-admin';
import { sectionFrom } from '../src/components/admin/settings/SettingsSections';

// #350 后台「组织信息」表单（字段说明 v1.0、spec §9、字段上限 23:00 PT）× 后端 #367 /api/admin/site-settings/organization
const draft = (over: Partial<OrgDraft> = {}): OrgDraft => ({ ...emptyOrgDraft(), ...over });
const issuesOf = (body: unknown) => {
  const p = OrganizationPutInput.safeParse(body);
  if (!p.success) return p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const n = normalizeOrganizationInput(p.data);
  return n.ok ? [] : n.issues;
};

test('前端抄的上限 / 正则 / 字段表和后端 site-settings-model.ts 完全一致（后端改了这里先红）', () => {
  assert.deepEqual({ ...C_LIMITS }, { ...ORG_LIMITS });
  assert.equal(C_EMAIL.source, ORG_EMAIL_RE.source);
  assert.equal(C_TEL.source, ORG_TELEPHONE_RE.source);
  assert.deepEqual([...C_FIELDS], [...ORG_TEXT_FIELDS]);
  assert.equal(isValidFoundingDate(String(FOUNDING_YEAR_MIN)), true);
  assert.equal(isValidFoundingDate(String(FOUNDING_YEAR_MIN - 1)), false);
});

test('一句话介绍计数：按 code point（[...s].length），emoji / 代理对算 1；n/300，剩 ≤30 提醒色，超出 over', () => {
  assert.equal('😀'.length, 2);
  assert.equal(countChars('😀'), 1);
  assert.equal(countChars('𠮷a'), 2);
  assert.deepEqual(descriptionCounter(''), { n: 0, max: 300, text: '0/300', state: 'ok' });
  assert.equal(descriptionCounter('a'.repeat(269)).state, 'ok');
  assert.equal(descriptionCounter('a'.repeat(270)).state, 'warn'); // 剩 30
  assert.equal(descriptionCounter('😀'.repeat(300)).state, 'warn'); // 600 个 UTF-16 单元，但只有 300 个字
  assert.equal(descriptionCounter('😀'.repeat(300)).text, '300/300');
  assert.equal(descriptionCounter('😀'.repeat(301)).state, 'over');
  assert.equal(orgDraftErrors(draft({ description: '😀'.repeat(300) })).description, undefined);
  assert.equal(orgDraftErrors(draft({ description: '😀'.repeat(301) })).description, ORG_ERR.tooLong(301, 300));
  // 和后端判断一致：300 个 emoji 通过，301 个 400
  assert.deepEqual(issuesOf(orgPutBody(draft({ description: '😀'.repeat(300) }), 0).body), []);
  assert.equal(issuesOf(orgPutBody(draft({ description: '😀'.repeat(301) }), 0).body)[0].path, 'description');
});

test('超出上限就禁用保存（canSave 和 about 共用）', () => {
  const anyErrors = Object.keys(orgDraftErrors(draft({ description: 'x'.repeat(301) }))).length > 0;
  assert.equal(canSave({ busy: false, dirty: true, anyErrors, conflict: 'none' }), false);
  assert.equal(canSave({ busy: false, dirty: true, anyErrors: false, conflict: 'none' }), true);
});

test('社交主页：只收 https，去重（按规范化地址），空行忽略；不合格的行标在那一行', () => {
  const rows = ['https://example.com/sample-1', '', 'http://example.com/a', 'https://EXAMPLE.com/sample-1', 'javascript:alert(1)', 'https://u:p@example.com/', 'https://example.com/sample-2'];
  assert.deepEqual(sameAsRows(rows).map((r) => r.state), ['ok', 'empty', 'invalid', 'duplicate', 'invalid', 'invalid', 'ok']);
  const e = orgDraftErrors(draft({ sameAs: rows }));
  assert.deepEqual(Object.keys(e).sort(), ['sameAs.2', 'sameAs.4', 'sameAs.5']);
  assert.equal(e['sameAs.2'], ORG_ERR.sameAs);
  const ok = ['https://example.com/sample-1', 'https://example.com/sample-1/', ' https://example.com/sample-1 ', '', 'https://example.com/sample-2'];
  const p = sameAsPayload(ok);
  // 规范化用 URL.toString()（和后端 safeOrgUrl 一样）：首尾空格的是重复；路径 sample-1 和 sample-1/ 不同，两条都保留
  assert.deepEqual(p.list, ['https://example.com/sample-1', 'https://example.com/sample-1/', 'https://example.com/sample-2']);
  assert.deepEqual(p.rowOf, [0, 1, 4]);
  for (const r of ['https://example.com', 'https://example.com/', 'http://x.com', 'https://x.com/a b', 'https://x.com\\a', 'ftp://x.com', 'https://u@x.com']) {
    assert.equal(normalizeOrgUrl(r), safeOrgUrl(r), r);
  }
  for (const r of ['/logo.png', '//evil.com/x', '/%2fevil', '/a/../b', '/a/%2e%2e/b', 'https://x.com/l.png', 'http://x.com/l.png']) {
    assert.equal(normalizeOrgUrl(r, true), safeOrgUrl(r, true), r);
  }
  // 后端收到的列表和自动去重后的一样
  const body = orgPutBody(draft({ sameAs: ['https://example.com/a', 'https://example.com/a', '', 'https://example.com/b'] }), 2).body;
  assert.deepEqual(body.sameAs, ['https://example.com/a', 'https://example.com/b']);
  const n = normalizeOrganizationInput(OrganizationPutInput.parse(body));
  assert.ok(n.ok && n.fields.sameAs.length === 2);
});

test('社交主页最多 10 条：满 10 条「添加链接」禁用，提示「最多 10 条」；10 条能通过后端，11 条前端就报错', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `https://example.com/sample-${i + 1}`);
  assert.equal(canAddSameAs(ten.slice(0, 9)), true);
  assert.equal(canAddSameAs(ten), false);
  assert.equal(ORG_TEXT.sameAsMaxHint, '最多 10 条');
  assert.equal(ORG_TEXT.sameAsAdd, '＋ 添加链接');
  assert.deepEqual(issuesOf(orgPutBody(draft({ sameAs: ten }), 0).body), []);
  assert.equal(orgDraftErrors(draft({ sameAs: [...ten, 'https://example.com/x'] })).sameAs, '最多 10 条');
  // 10 行里有重复：提交时只发去重后的
  assert.equal((orgPutBody(draft({ sameAs: [...ten.slice(0, 9), ten[0]] }), 0).body.sameAs as string[]).length, 9);
});

test('邮箱 / 电话 / Logo 的前端检查和后端一致', () => {
  assert.equal(orgDraftErrors(draft({ email: 'example@example' })).email, '邮箱格式不正确');
  assert.equal(orgDraftErrors(draft({ email: 'example@example.com' })).email, undefined);
  assert.equal(orgDraftErrors(draft({ telephone: '+86 000 0000 0000' })).telephone, undefined);
  assert.ok(orgDraftErrors(draft({ telephone: 'call me' })).telephone);
  assert.ok(orgDraftErrors(draft({ logo: 'http://x.com/l.png' })).logo);
  assert.equal(orgDraftErrors(draft({ logo: '/og/logo.png' })).logo, undefined);
  for (const [f, v] of [['email', 'example@example'], ['telephone', 'call me'], ['logo', 'http://x.com/l.png']] as const) {
    assert.ok(issuesOf(orgPutBody(draft({ [f]: v }), 0).body).some((i) => i.path === f), f);
  }
});

test('PUT 请求体能通过后端 OrganizationPutInput（.strict），空串 = 不设置，带读取时的 expectedVersion', () => {
  const { body } = orgPutBody(draft({ legalName: ' 示例文字 Sample Co., Ltd. ', email: '', foundingDate: '2001' }), 7);
  assert.equal(OrganizationPutInput.safeParse(body).success, true);
  assert.equal(body.expectedVersion, 7);
  assert.equal(body.legalName, '示例文字 Sample Co., Ltd.');
  assert.deepEqual(Object.keys(body).sort(), ['expectedVersion', ...ORG_TEXT_FIELDS, 'sameAs'].sort());
  const n = normalizeOrganizationInput(OrganizationPutInput.parse(body));
  assert.ok(n.ok);
  assert.deepEqual(Object.keys(n.fields).sort(), ['foundingDate', 'legalName', 'sameAs']);
});

test('后端字段级错误（400 invalid issues；422 也认）映射到字段下方；sameAs.<n> 换回界面行号', () => {
  const d = draft({ email: 'a@b', telephone: 'xx', foundingDate: '1700', logo: '//evil', description: 'x'.repeat(301), sameAs: ['', 'https://ok.example/', 'https://ok.example/', 'http://bad.example'] });
  const { body, rowOf } = orgPutBody(d, 1);
  assert.deepEqual(body.sameAs, ['https://ok.example/', 'http://bad.example']);
  assert.deepEqual(rowOf, [1, 3]);
  // 两轮：zod 先报 email / description；改好后 normalize 再报 telephone / foundingDate / logo / sameAs
  const first = mapServerIssues(issuesOf(body), rowOf);
  assert.equal(first.fields.email, '邮箱格式不正确');
  assert.match(first.fields.description ?? '', /超出上限（最多 300 字）/);
  const second = mapServerIssues(issuesOf({ ...body, email: 'a@b.co', description: 'ok' }), rowOf);
  assert.deepEqual(Object.keys(second.fields).sort(), ['foundingDate', 'logo', 'sameAs.3', 'telephone']);
  assert.equal(second.fields['sameAs.3'], ORG_ERR.sameAs);
  assert.equal(second.fields.foundingDate, ORG_ERR.date);
  const other = mapServerIssues([{ path: '', message: 'Unrecognized key(s) in object: capacity' }]);
  assert.deepEqual(other.fields, {});
  assert.equal(other.rest.length, 1);
});

type Call = { url: string; method: string; body: unknown };
function fake(responses: ((c: Call) => { status: number; body: unknown })[]) {
  const calls: Call[] = [];
  const api = createOrgSettingsApi(async (url, init) => {
    const c = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = responses[calls.length - 1](c);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
  return { api, calls };
}
const view = { version: 4, legalName: '示例文字 Sample Co., Ltd.', sameAs: ['https://example.com/sample-1'], updatedAt: '2026-10-17T21:00:00.000Z', updatedBy: 'u1', updatedByName: '王示例' };

test('load：GET /api/admin/site-settings/organization；没存过 version 0、字段全空（不预填默认值）', async () => {
  const { api, calls } = fake([() => ({ status: 200, body: view }), () => ({ status: 200, body: { version: 0, sameAs: [], updatedAt: null, updatedBy: null, updatedByName: null } })]);
  const a = await api.load();
  assert.deepEqual(calls[0], { url: '/api/admin/site-settings/organization', method: 'GET', body: undefined });
  assert.equal(a.version, 4); assert.equal(a.draft.legalName, view.legalName); assert.equal(a.updatedByName, '王示例');
  const b = await api.load();
  assert.equal(b.version, 0);
  assert.deepEqual(b.draft, emptyOrgDraft());
  await assert.rejects(fake([() => ({ status: 404, body: {} })]).api.load(), /http_404/);
});

test('409：返回 version_conflict，只发一次请求（不自动重交、不拿 currentVersion 重试）；之后保存禁用，刷新要确认', async () => {
  const { api, calls } = fake([() => ({ status: 409, body: { error: 'version_conflict', currentVersion: 9 } })]);
  const d = orgFromView(view);
  const r = await api.save({ ...d.draft, email: 'example@example.com' }, d.version);
  assert.equal(calls.length, 1);
  assert.equal((calls[0].body as { expectedVersion: number }).expectedVersion, 4);
  assert.ok(!r.ok && r.code === 'version_conflict' && r.currentVersion === 9);
  // 和 about 同一个状态机：conflict → 刷新 → confirm（取消回 conflict）→ 确认 → loading（读最新）→ none
  let s: ConflictPhase = conflictStep('none', 'conflict').next;
  assert.equal(canSave({ busy: false, dirty: true, anyErrors: false, conflict: s }), false);
  s = conflictStep(s, 'refresh').next; assert.equal(s, 'confirm');
  assert.equal(conflictStep(s, 'cancel').next, 'conflict');
  const c = conflictStep(s, 'confirm'); assert.deepEqual(c, { next: 'loading', reload: true });
  assert.equal(canSave({ busy: false, dirty: true, anyErrors: false, conflict: c.next }), false);
  assert.equal(conflictStep('loading', 'reloaded').next, 'none');
  assert.equal(SETTINGS_TEXT.conflict, '内容已被他人修改，请刷新后重新编辑');
  assert.equal(SETTINGS_TEXT.conflictConfirmTitle, '未保存的修改将丢弃');
  assert.equal(SETTINGS_TEXT.conflictConfirmOk, '丢弃并刷新');
  assert.equal(SETTINGS_TEXT.cancel, '取消');
});

test('save 成功：用返回的 content 作为新基线（新 version）；400 / 422 带 issues → fieldErrors；其他错误给 code', async () => {
  const { api } = fake([
    (c) => ({ status: 200, body: { changed: true, content: { ...view, ...(c.body as object), version: 5 } } }),
    () => ({ status: 400, body: { error: 'invalid', issues: [{ path: 'sameAs.0', message: 'invalid_url' }] } }),
    () => ({ status: 422, body: { error: 'invalid', issues: [{ path: 'email', message: 'Invalid' }] } }),
    () => ({ status: 429, body: { error: 'rate_limited' } }),
  ]);
  const d = orgFromView(view).draft;
  const ok = await api.save(d, 4);
  assert.ok(ok.ok && ok.data.version === 5);
  const bad = await api.save({ ...d, sameAs: ['', 'https://example.com/x'] }, 5);
  assert.ok(!bad.ok && bad.fieldErrors?.['sameAs.1'] === ORG_ERR.sameAs);
  const bad2 = await api.save(d, 5);
  assert.ok(!bad2.ok && bad2.fieldErrors?.email === '邮箱格式不正确');
  const rl = await api.save(d, 5);
  assert.ok(!rl.ok && rl.code === 'rate_limited' && !rl.fieldErrors);
});

test('成立时间（UX 定稿）：只填年份，保存 YYYY；已存的 YYYY-MM-DD 显示年份，不改原样提交，改了就存 YYYY', () => {
  assert.equal(ORG_FIELD_TEXT.foundingDate.hint, '填年份，例如 2012');
  assert.equal(foundingYearInput('2005-06-15'), '2005');
  assert.equal(foundingYearInput('2005'), '2005');
  assert.equal(foundingYearInput(''), '');
  // 没动这个字段：PUT 里原样是 YYYY-MM-DD，后端照收
  const keep = orgPutBody(draft({ foundingDate: '2005-06-15' }), 1).body;
  assert.equal(keep.foundingDate, '2005-06-15');
  assert.deepEqual(issuesOf(keep), []);
  // 改了（输入框 onChange 写入输入的年份）：存 YYYY
  const edited = orgPutBody(draft({ foundingDate: '2006' }), 1).body;
  assert.equal(edited.foundingDate, '2006');
  assert.deepEqual(issuesOf(edited), []);
  const now = new Date('2026-10-18T00:00:00Z');
  for (const ok of ['', '1800', '2012', '2026', '2005-06-15']) assert.equal(isValidFoundingYear(ok, now), true, ok);
  for (const bad of ['1799', '2027', '12', '20a2', '2012-06', '２０１２']) assert.equal(isValidFoundingYear(bad, now), false, bad);
  assert.equal(orgDraftErrors(draft({ foundingDate: '2012-06' })).foundingDate, ORG_ERR.year);
  assert.equal(orgDraftErrors(draft({ foundingDate: '2012' })).foundingDate, undefined);
  // 前端判断和后端一致
  for (const y of ['1799', '1800', '2012', String(new Date().getFullYear() + 1)]) {
    assert.equal(isValidFoundingYear(y), isValidFoundingDate(y), y);
  }
  const src = readFileSync('src/components/admin/settings/OrgSettings.tsx', 'utf8') + readFileSync('src/lib/admin/org-settings.ts', 'utf8');
  assert.doesNotMatch(src, /FOUNDING_MONTH_SUPPORTED|月（可选）|<select/);
});

test('文案照字段说明 v1.0；邮箱 / 电话 / 地址标「公开」；占位和默认值里没有数字，也没有数字类字段', () => {
  assert.equal(ORG_FIELD_TEXT.name.label, '公司名称（对外）');
  assert.equal(ORG_FIELD_TEXT.description.hint, '不填就用默认的 manufacturer 那句');
  assert.deepEqual(Object.entries(ORG_FIELD_TEXT).filter(([, t]) => t.public).map(([f]) => f), ['email', 'telephone', 'address']);
  assert.equal(ORG_TEXT.intro, '这些信息会出现在搜索引擎的结构化数据里，不确定的就不要填。');
  assert.equal(ORG_TEXT.saved, '已保存，前台约 1 分钟内生效');
  for (const v of Object.values(ORG_PLACEHOLDER)) assert.doesNotMatch(v!, /\d/);
  assert.deepEqual(emptyOrgDraft(), { name: '', alternateName: '', legalName: '', description: '', email: '', telephone: '', address: '', foundingDate: '', logo: '', sameAs: [] });
  for (const k of Object.keys(ORG_FIELD_TEXT)) assert.doesNotMatch(k, /capacity|area|employee|headcount|cert|lead|moq/i);
});

test('保存条摘要按分组名；分区导航 ?section=org，其他值都回到「关于我们」', () => {
  assert.equal(orgDirtySummary(draft(), draft({ email: 'a@b.co' })), '联系方式');
  assert.equal(orgDirtySummary(draft(), draft({ name: 'X', sameAs: ['https://x.com/'] })), '基本信息、其他');
  assert.equal(sectionFrom('org'), 'org');
  for (const v of [undefined, 'about', 'ORG', ['org'], '../org']) assert.equal(sectionFrom(v as string | undefined), 'about');
});

test('组织信息组件是 use client，只调同源 /api/admin/site-settings/organization，不 import about.ts / server 模块', () => {
  const src = readFileSync('src/components/admin/settings/OrgSettings.tsx', 'utf8');
  const lib = readFileSync('src/lib/admin/org-settings.ts', 'utf8');
  assert.match(src, /^'use client';/);
  const specs = (t: string) => [...t.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]);
  for (const s of [src, lib]) for (const spec of specs(s)) assert.doesNotMatch(spec, /seo\/about|lib\/server|sanitize-html|prisma/, spec);
  assert.ok(specs(src).includes('@/lib/admin/org-settings'));
  const page = readFileSync('src/app/admin/settings/page.tsx', 'utf8');
  assert.ok(page.indexOf("await enforceAdminPage(['ADMIN']") < page.indexOf('sectionFrom('), '先做 ADMIN 页面检查，再看分区');
});

test('错误条：对不上字段的 issue、400 / 422 没带 issues 都进顶部 alert，不会悄悄丢掉；能对上的只放字段下方', async () => {
  const { api } = fake([
    () => ({ status: 400, body: { error: 'invalid', issues: [{ path: 'capacity', message: 'Unrecognized key' }, { path: 'email', message: 'Invalid' }] } }),
    () => ({ status: 400, body: { error: 'invalid', issues: [{ path: 'expectedVersion', message: 'Required' }] } }),
    () => ({ status: 400, body: { error: 'invalid' } }),
    () => ({ status: 422, body: {} }),
    () => ({ status: 422, body: { error: 'invalid', issues: [] } }),
    () => ({ status: 400, body: { error: 'invalid', issues: [{ path: 'telephone', message: 'invalid_telephone' }] } }),
  ]);
  const d = emptyOrgDraft();
  const fail = async () => { const r = await api.save(d, 0); assert.ok(!r.ok); return saveFailureView(r as Extract<typeof r, { ok: false }>); };
  const a = await fail();
  assert.equal(a.fieldErrors.email, '邮箱格式不正确');
  assert.equal(a.alert, '参数不正确，请检查后重试。（capacity：Unrecognized key）');
  const b = await fail();
  assert.deepEqual(b.fieldErrors, {});
  assert.equal(b.alert, '参数不正确，请检查后重试。（expectedVersion：Required）');
  assert.equal((await fail()).alert, '参数不正确，请检查后重试。'); // 400 没带 issues
  assert.equal((await fail()).alert, '保存失败：http_422'); // 422 没 body
  assert.equal((await fail()).alert, '参数不正确，请检查后重试。'); // 422 issues 为空
  const f = await fail();
  assert.equal(f.alert, null);
  assert.equal(f.fieldErrors.telephone, ORG_ERR.telephone);
});
