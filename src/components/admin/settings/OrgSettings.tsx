'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import AdminTime from '@/components/admin/AdminTime';
import { canSave, conflictStep, SETTINGS_TEXT as T, type ConflictEvent, type ConflictPhase } from '@/lib/admin/site-settings';
import {
  canAddSameAs, composeFoundingDate, descriptionCounter, emptyOrgDraft, FOUNDING_MONTH_SUPPORTED, foundingYears, isOrgConflict, ORG_FIELD_TEXT, ORG_GROUPS,
  ORG_LIMITS, ORG_PLACEHOLDER, ORG_TEXT, orgDirtyFields, orgDirtySummary, orgDraftErrors, orgErrorText, orgSettingsApi, parseFoundingDate, sameAsRows,
  type OrgData, type OrgDraft, type OrgErrors, type OrgSettingsApi, type OrgTextField,
} from '@/lib/admin/org-settings';
import ConfirmDialog from './ConfirmDialog';
import SettingsSections from './SettingsSections';
import './settings.css';

type Notice = { kind: 'ok' | 'err'; text: string } | null;
type Props = { siteUrl: string; descriptionPlaceholder: string; api?: OrgSettingsApi };
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

/**
 * #350 站点设置 ·「组织信息」（字段说明 v1.0、spec §9；稿件 settings-org-*）。单栏，三组：基本信息 / 联系方式 / 其他 + 只读网站地址。
 * 保存条、成功提示、409 冲突（横幅 +「刷新」→ 确认「未保存的修改将丢弃」→ 读最新内容和 version）和 about 完全一样，
 * 状态机直接用 site-settings.ts 的 conflictStep / canSave。冲突期间字段可编辑、可复制，但保存禁用，不会带旧 version 重交。
 */
export default function OrgSettings({ siteUrl, descriptionPlaceholder, api = orgSettingsApi }: Props) {
  const [saved, setSaved] = useState<OrgData | null>(null);
  const [draft, setDraft] = useState<OrgDraft>(emptyOrgDraft());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [serverErr, setServerErr] = useState<OrgErrors>({});
  const [conflict, setConflict] = useState<ConflictPhase>('none');
  const conflictRef = useRef<ConflictPhase>('none');
  const step = (e: ConflictEvent) => { const r = conflictStep(conflictRef.current, e); conflictRef.current = r.next; setConflict(r.next); return r; };
  const years = useMemo(() => foundingYears(), []);

  useEffect(() => {
    api.load().then((d) => { setSaved(d); setDraft(structuredClone(d.draft)); }).catch((e: Error) => setNotice({ kind: 'err', text: orgErrorText(e.message) }));
  }, [api]);

  const base = saved?.draft ?? emptyOrgDraft();
  const dirty = orgDirtyFields(base, draft).length > 0;
  const summary = orgDirtySummary(base, draft);
  const clientErr = orgDraftErrors(draft);
  const anyErrors = Object.keys(clientErr).length > 0;
  const saveAllowed = canSave({ busy, dirty, anyErrors, conflict });

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = T.leave; return T.leave; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  useEffect(() => {
    if (notice?.kind !== 'ok') return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /** 字段下方显示的错误：后端返回的优先；前端检查在离开输入框后显示（超出字数上限马上显示） */
  const errOf = (k: keyof OrgErrors): string | undefined => {
    if (serverErr[k]) return serverErr[k];
    const c = clientErr[k];
    if (!c) return undefined;
    return touched.has(k) || c.startsWith('超出上限') || k === 'sameAs' ? c : undefined;
  };
  const touch = (k: string) => setTouched((p) => (p.has(k) ? p : new Set(p).add(k)));
  const clearServer = (k: string) => setServerErr((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k as keyof OrgErrors]; return n; });
  const set = (f: OrgTextField, v: string) => { setDraft((p) => ({ ...p, [f]: v })); clearServer(f); };
  const setRows = (rows: string[]) => { setDraft((p) => ({ ...p, sameAs: rows })); setServerErr((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('sameAs')))); };

  const save = async () => {
    if (!saved || !canSave({ busy, dirty, anyErrors, conflict: conflictRef.current })) return;
    setBusy(true); setNotice(null);
    const r = await api.save(draft, saved.version);
    setBusy(false);
    if (r.ok) { setSaved(r.data); setDraft(structuredClone(r.data.draft)); setServerErr({}); setTouched(new Set()); setNotice({ kind: 'ok', text: `✓ ${ORG_TEXT.saved}` }); return; }
    if (isOrgConflict(r)) { step('conflict'); return; } // 409：输入原样保留，保存禁用；只能「刷新」
    if (r.fieldErrors && Object.keys(r.fieldErrors).length) {
      setServerErr(r.fieldErrors);
      // 焦点移到第一个出错的字段
      const first = [...ORG_GROUPS.flatMap((g) => g.fields)].flatMap((f) => (f === 'sameAs' ? draft.sameAs.map((_, i) => `sameAs.${i}`).concat('sameAs') : [f])).find((k) => r.fieldErrors![k as keyof OrgErrors]);
      if (first) window.requestAnimationFrame(() => document.getElementById(fieldId(first))?.focus());
      if (r.rest?.length) setNotice({ kind: 'err', text: orgErrorText(r.code) });
      return;
    }
    setNotice({ kind: 'err', text: orgErrorText(r.code) });
  };

  const discard = () => { if (!saved) return; setDraft(structuredClone(saved.draft)); setServerErr({}); setTouched(new Set()); };

  const confirmRefresh = async () => {
    if (!step('confirm').reload) return;
    try {
      const fresh = await api.load();
      setSaved(fresh); setDraft(structuredClone(fresh.draft)); setServerErr({}); setTouched(new Set()); setNotice(null);
      step('reloaded');
    } catch (e) {
      step('reload_failed');
      setNotice({ kind: 'err', text: orgErrorText(e instanceof Error ? e.message : 'unknown') });
    }
  };

  if (!saved) return <div className="st-page"><p>{notice?.text ?? '加载中…'}</p></div>;

  const textField = (f: Exclude<OrgTextField, 'foundingDate'>) => {
    const id = fieldId(f);
    const err = errOf(f);
    const counter = f === 'description' ? descriptionCounter(draft.description) : null;
    const desc = [counter ? `${id}-c` : '', err ? `${id}-e` : '', `${id}-h`].filter(Boolean).join(' ');
    const placeholder = f === 'description' ? descriptionPlaceholder : ORG_PLACEHOLDER[f];
    const common = {
      id, value: draft[f], placeholder, 'aria-invalid': err ? true : undefined, 'aria-describedby': desc,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(f, e.target.value), onBlur: () => touch(f),
    };
    return (
      <div className="st-f" key={f}>
        <div className="st-lab">
          <label htmlFor={id}>{ORG_FIELD_TEXT[f].label}{ORG_FIELD_TEXT[f].public && <span className="st-pub">{ORG_TEXT.publicTag}</span>}</label>
          {counter && <span id={`${id}-c`} className={`st-count${counter.state === 'over' ? ' bad' : counter.state === 'warn' ? ' warn' : ''}`}>{counter.text}</span>}
        </div>
        {f === 'description' ? <textarea rows={3} dir="ltr" {...common} />
          : <input type={f === 'email' ? 'email' : f === 'telephone' ? 'tel' : 'text'} dir={f === 'email' || f === 'telephone' || f === 'logo' ? 'ltr' : undefined} autoComplete="off" {...common} />}
        {err && <p id={`${id}-e`} className="st-ferr">{err}</p>}
        <p id={`${id}-h`} className="st-hint">{ORG_FIELD_TEXT[f].hint}</p>
      </div>
    );
  };

  const fd = parseFoundingDate(draft.foundingDate);
  const dateErr = errOf('foundingDate');
  const dateField = (
    <fieldset className="st-f" key="foundingDate" aria-describedby={`${fieldId('foundingDate')}-h${dateErr ? ` ${fieldId('foundingDate')}-e` : ''}`}>
      <legend className="st-lab">{ORG_FIELD_TEXT.foundingDate.label}</legend>
      <div className="st-date">
        <select id={fieldId('foundingDate')} aria-label={ORG_TEXT.year} value={fd.year} aria-invalid={dateErr ? true : undefined}
          onChange={(e) => set('foundingDate', composeFoundingDate(draft.foundingDate, e.target.value, e.target.value === fd.year ? fd.month : ''))}>
          <option value="">{ORG_TEXT.year}</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select aria-label={ORG_TEXT.month} value={fd.month} disabled={!FOUNDING_MONTH_SUPPORTED || !fd.year}
          onChange={(e) => set('foundingDate', composeFoundingDate(draft.foundingDate, fd.year, e.target.value))}>
          <option value="">{ORG_TEXT.month}</option>
          {MONTHS.map((m) => <option key={m} value={m}>{Number(m)} 月</option>)}
        </select>
      </div>
      {dateErr && <p id={`${fieldId('foundingDate')}-e`} className="st-ferr">{dateErr}</p>}
      <p id={`${fieldId('foundingDate')}-h`} className="st-hint">{ORG_FIELD_TEXT.foundingDate.hint}{!FOUNDING_MONTH_SUPPORTED && <><br />{ORG_TEXT.monthPending}</>}</p>
    </fieldset>
  );

  const rows = sameAsRows(draft.sameAs);
  const addOk = canAddSameAs(draft.sameAs);
  const listErr = errOf('sameAs');
  const sameAsField = (
    <fieldset className="st-f" key="sameAs" aria-describedby={`${fieldId('sameAs')}-h`}>
      <legend className="st-lab st-lab-full"><span>{ORG_FIELD_TEXT.sameAs.label}</span><span className="st-count">{draft.sameAs.length} / {ORG_LIMITS.sameAsMax}</span></legend>
      {draft.sameAs.map((v, i) => {
        const k = `sameAs.${i}` as const;
        const err = errOf(k);
        const dup = rows[i]?.state === 'duplicate';
        return (
          <div key={i} className="st-same">
            <input id={fieldId(k)} type="url" dir="ltr" inputMode="url" placeholder="https://" value={v} aria-label={ORG_TEXT.sameAsItem(i + 1)} aria-invalid={err ? true : undefined}
              aria-describedby={err ? `${fieldId(k)}-e` : dup ? `${fieldId(k)}-d` : undefined}
              onChange={(e) => setRows(draft.sameAs.map((x, j) => (j === i ? e.target.value : x)))} onBlur={() => touch(k)} />
            <button type="button" className="adm-btn sq" aria-label={ORG_TEXT.sameAsRemove(i + 1)} onClick={() => setRows(draft.sameAs.filter((_, j) => j !== i))}>✕</button>
            {err && <p id={`${fieldId(k)}-e`} className="st-ferr">{err}</p>}
            {!err && dup && <p id={`${fieldId(k)}-d`} className="st-hint">{ORG_TEXT.sameAsDuplicate}</p>}
          </div>
        );
      })}
      <div className="st-same-add">
        <button type="button" className="adm-btn" disabled={!addOk} aria-describedby={addOk ? undefined : `${fieldId('sameAs')}-max`} onClick={() => setRows([...draft.sameAs, ''])}>{ORG_TEXT.sameAsAdd}</button>
        {!addOk && <span id={`${fieldId('sameAs')}-max`} className="st-hint">{ORG_TEXT.sameAsMaxHint}</span>}
      </div>
      {listErr && <p className="st-ferr" role="alert">{listErr}</p>}
      <p id={`${fieldId('sameAs')}-h`} className="st-hint">{ORG_FIELD_TEXT.sameAs.hint}</p>
    </fieldset>
  );

  return (
    <div className="st-page st-org">
      <p className="st-crumb">{ORG_TEXT.crumb}</p>
      <SettingsSections current="org" />
      <h1>{ORG_TEXT.h1}</h1>
      {saved.updatedAt && <p className="st-audit">{T.lastEdited}{saved.updatedByName ?? '—'} · <AdminTime iso={saved.updatedAt} /></p>}
      {notice?.kind === 'ok' && <p className="st-ok" role="status">{notice.text}</p>}
      {notice?.kind === 'err' && <p className="st-err" role="alert">{notice.text}</p>}
      {conflict !== 'none' && (
        <div className="st-err st-conflict" role="alert">
          <span>{T.conflict}</span>
          <button type="button" className="adm-btn" disabled={conflict === 'loading'} aria-busy={conflict === 'loading' || undefined} onClick={() => step('refresh')}>{T.conflictRefresh}</button>
        </div>
      )}

      <div className="st-orgcol">
        <p className="st-note">{ORG_TEXT.intro}</p>
        {ORG_GROUPS.map((g) => (
          <section key={g.id} className="adm-card st-card" aria-labelledby={`st-org-${g.id}`}>
            <h2 id={`st-org-${g.id}`}>{g.label}</h2>
            {g.fields.map((f) => (f === 'foundingDate' ? dateField : f === 'sameAs' ? sameAsField : textField(f)))}
            {g.id === 'other' && (
              <div className="st-f">
                <div className="st-lab"><label htmlFor="st-org-url">{ORG_TEXT.urlLabel}</label></div>
                <input id="st-org-url" className="st-ro" value={siteUrl} readOnly aria-readonly="true" dir="ltr" aria-describedby="st-org-url-h" />
                <p id="st-org-url-h" className="st-hint">{ORG_TEXT.urlHint}</p>
              </div>
            )}
          </section>
        ))}
      </div>

      {dirty && (
        <div className="st-bar" role="region" aria-label="保存">
          <span>{T.dirty}{summary && <small>（{summary}）</small>}</span>
          <button type="button" className="adm-btn" disabled={busy} onClick={discard}>{T.discard}</button>
          <button type="button" className="adm-btn primary" disabled={!saveAllowed} aria-busy={busy || undefined} onClick={save}>{busy ? T.saving : T.save}</button>
        </div>
      )}

      {conflict === 'confirm' && (
        <ConfirmDialog title={T.conflictConfirmTitle} confirmLabel={T.conflictConfirmOk} danger onCancel={() => step('cancel')} onConfirm={confirmRefresh}>
          <p>{ORG_TEXT.conflictConfirmBody}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function fieldId(k: string): string { return `st-org-${k.replace('.', '-')}`; }
