'use client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AdminTime from '@/components/admin/AdminTime';
import { ABOUT_LIMITS } from '@/lib/site-settings/about-rules';
import {
  aboutSettingsApi, bodyTooShortNote, canSave, conflictStep, dirtyFields, dirtySummary, draftChecklist, draftCompleteness, draftErrors, emptyDraft, fieldCount, isAllowedAboutHref,
  isVersionConflict, saveFailureView, SETTINGS_TEXT as T, settingsErrorText, writesBlocked, type AboutDraft, type AboutFieldErrors, type AboutSettingsData, type ConflictEvent, type ConflictPhase, type DraftField,
} from '@/lib/admin/site-settings';
import ConfirmDialog from './ConfirmDialog';
import SettingsSections from './SettingsSections';
import './settings.css';

type Notice = { kind: 'ok' | 'err'; text: string } | null;
type Props = { locales: string[]; publishedLocales: string[] };

/** 编辑器输出统一成白名单里的标签名（b→strong、i→em、div→p）。只是整理格式，不是净化——安全由服务端 sanitizeAboutHtml 负责 */
const normalizeEditorHtml = (html: string) => html
  .replace(/<(\/?)b(\s|>)/gi, '<$1strong$2').replace(/<(\/?)i(\s|>)/gi, '<$1em$2').replace(/<(\/?)div(\s|>)/gi, '<$1p$2')
  .replace(/^(<br\s*\/?>|\s)+$/i, '');

function Counter({ n, max, min, id }: { n: number; max: number; min?: number; id: string }) {
  const bad = n > max || (min !== undefined && n > 0 && n < min);
  return <span id={id} className={`st-count${bad ? ' bad' : ''}`}>{n.toLocaleString('en-US')} / {max.toLocaleString('en-US')}</span>;
}

/** 富文本编辑器：工具栏只有 H2、H3、加粗、斜体、链接、项目符号、编号、清除格式（= sanitizeAboutHtml 白名单） */
function BodyEditor({ initial, dir, onChange, invalid, describedBy }: { initial: string; dir: 'ltr' | 'rtl'; onChange: (html: string) => void; invalid: boolean; describedBy: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null);
  const [link, setLink] = useState<string | null>(null);
  // 只在挂载（切换语言时按 key 重建）时写入一次初始内容；之后由浏览器维护，避免 React 打断光标。
  // initial 是从后台接口读回来的、已由服务端净化过的 HTML
  useEffect(() => { if (ref.current) ref.current.innerHTML = initial; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const emit = () => onChange(normalizeEditorHtml(ref.current?.innerHTML ?? ''));
  const cmd = (c: string, v?: string) => { ref.current?.focus(); document.execCommand(c, false, v); emit(); };
  const openLink = () => {
    const sel = window.getSelection();
    range.current = sel && sel.rangeCount && ref.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    setLink('');
  };
  const linkOk = link !== null && isAllowedAboutHref(link);
  const applyLink = () => {
    if (!linkOk || link === null) return;
    const sel = window.getSelection();
    ref.current?.focus();
    if (range.current && sel) { sel.removeAllRanges(); sel.addRange(range.current); }
    document.execCommand('createLink', false, link.trim());
    setLink(null); emit();
  };
  // UX #373 P3-3：平的、分组的工具栏（稿件 .ss-tb）：H2 H3 | B I 链接 | 列表 | 清除格式；加粗 / 斜体按选区显示 aria-pressed
  const [pressed, setPressed] = useState({ bold: false, italic: false });
  useEffect(() => {
    const h = () => {
      const sel = window.getSelection();
      if (!sel || !ref.current?.contains(sel.anchorNode)) return;
      setPressed({ bold: document.queryCommandState('bold'), italic: document.queryCommandState('italic') });
    };
    document.addEventListener('selectionchange', h);
    return () => document.removeEventListener('selectionchange', h);
  }, []);
  type Tool = { label: React.ReactNode; name: string; fn: () => void; pressed?: boolean };
  const groups: Tool[][] = [
    [{ label: 'H2', name: '二级标题', fn: () => cmd('formatBlock', '<h2>') }, { label: 'H3', name: '三级标题', fn: () => cmd('formatBlock', '<h3>') }],
    [{ label: <b>B</b>, name: '加粗', fn: () => cmd('bold'), pressed: pressed.bold }, { label: <i>I</i>, name: '斜体', fn: () => cmd('italic'), pressed: pressed.italic }, { label: '🔗', name: '链接', fn: openLink }],
    [{ label: '• ≡', name: '项目符号列表', fn: () => cmd('insertUnorderedList') }, { label: '1. ≡', name: '编号列表', fn: () => cmd('insertOrderedList') }],
    [{ label: 'Tx', name: '清除格式', fn: () => { cmd('removeFormat'); cmd('unlink'); cmd('formatBlock', '<p>'); } }],
  ];
  return (
    <div className={`st-editor${invalid ? ' bad' : ''}`}>
      <div className="st-tools" role="toolbar" aria-label="正文格式">
        {groups.map((g, gi) => (
          <Fragment key={gi}>
            {gi > 0 && <span className="sep" aria-hidden="true" />}
            {g.map((t) => <button key={t.name} type="button" className="st-tb-btn" aria-label={t.name} title={t.name} aria-pressed={t.pressed === undefined ? undefined : t.pressed} onMouseDown={(e) => e.preventDefault()} onClick={t.fn}>{t.label}</button>)}
          </Fragment>
        ))}
      </div>
      {link !== null && (
        <div className="st-link">
          <label htmlFor="st-link-in">{T.linkLabel}</label>
          <input id="st-link-in" autoFocus value={link} dir="ltr" aria-invalid={link && !linkOk ? true : undefined} aria-describedby={link && !linkOk ? 'st-link-e' : undefined}
            onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink(); } if (e.key === 'Escape') { e.preventDefault(); setLink(null); } }} />
          <button type="button" className="adm-btn primary" disabled={!linkOk} onClick={applyLink}>{T.linkOk}</button>
          <button type="button" className="adm-btn" onClick={() => setLink(null)}>{T.linkCancel}</button>
          {link && !linkOk && <p id="st-link-e" className="st-ferr">{T.linkError}</p>}
        </div>
      )}
      <div ref={ref} className="st-rich" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="正文" dir={dir}
        aria-invalid={invalid || undefined} aria-describedby={describedBy}
        onInput={emit}
        // 粘贴只保留纯文本：去掉颜色、字号、图片、表格
        onPaste={(e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); emit(); }} />
    </div>
  );
}

export default function AboutSettings({ locales, publishedLocales }: Props) {
  const [saved, setSaved] = useState<AboutSettingsData | null>(null);
  const [draft, setDraft] = useState<Record<string, AboutDraft>>({});
  const [tab, setTab] = useState(locales[0]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [serverErr, setServerErr] = useState<AboutFieldErrors>({});
  const [confirm, setConfirm] = useState<null | boolean>(null);
  const [epoch, setEpoch] = useState(0); // 放弃修改 / 冲突后刷新时重建编辑器
  const [conflict, setConflict] = useState<ConflictPhase>('none');
  const conflictRef = useRef<ConflictPhase>('none');
  const step = (e: ConflictEvent) => { const r = conflictStep(conflictRef.current, e); conflictRef.current = r.next; setConflict(r.next); return r; };
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    aboutSettingsApi.load(locales).then((d) => { setSaved(d); setDraft(structuredClone(d.locales)); }).catch((e: Error) => setNotice({ kind: 'err', text: settingsErrorText(e.message) }));
  }, [locales]);

  const d = draft[tab] ?? emptyDraft();
  const savedLocales = useMemo(() => saved?.locales ?? {}, [saved]);
  const summary = useMemo(() => dirtySummary(savedLocales, draft), [savedLocales, draft]);
  const dirty = summary.length > 0;
  const clientErr = draftErrors(d);
  const errors: AboutFieldErrors = { ...clientErr, ...serverErr }; // 后端字段错误优先盖住前端检查
  const anyErrors = locales.some((l) => Object.keys(draftErrors(draft[l] ?? emptyDraft())).length > 0); // 后端字段错误不挡再保存（同组织信息）
  const dir: 'ltr' | 'rtl' = tab === 'ar' ? 'rtl' : 'ltr';

  // 离开页面提醒（路由内跳转由浏览器 beforeunload 覆盖刷新 / 关闭；后台内链接切换另见 TODO）
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

  const set = useCallback(<K extends keyof AboutDraft>(k: K, v: AboutDraft[K]) => {
    setDraft((p) => ({ ...p, [tab]: { ...(p[tab] ?? emptyDraft()), [k]: v } }));
    if ((['title', 'summary', 'bodyHtml', 'stats', 'homeHeading', 'homeIntro'] as DraftField[]).includes(k as DraftField)) {
      setServerErr((p) => { if (!(k in p)) return p; const n = { ...p }; delete n[k as DraftField]; return n; });
    }
  }, [tab]);

  const saveAllowed = canSave({ busy, dirty, anyErrors, conflict });
  const save = async () => {
    if (!canSave({ busy, dirty, anyErrors, conflict: conflictRef.current })) return;
    const changes = Object.fromEntries(locales.filter((l) => draft[l] && dirtyFields(savedLocales[l] ?? emptyDraft(), draft[l]).length).map((l) => [l, draft[l]]));
    setBusy(true); setNotice(null); setServerErr({});
    if (!saved) return;
    const r = await aboutSettingsApi.save(changes, saved);
    setBusy(false);
    if (r.ok) { setSaved(r.data); setDraft(structuredClone(r.data.locales)); setServerErr({}); setNotice({ kind: 'ok', text: T.saved(Object.keys(changes)) }); return; }
    if (isVersionConflict(r)) {
      // 409：编辑器里的文字原样保留（不清空、不覆盖），保存被禁用；只能点「刷新」→ 确认后读最新内容。绝不拿 409 返回的新版本号自动重交。
      // 冲突前已保存成功的语言只更新「已保存」基线，不动草稿
      if (r.saved) setSaved(r.saved);
      step('conflict');
      return;
    }
    const v = saveFailureView(r);
    setServerErr(v.fieldErrors);
    if (v.alert) setNotice({ kind: 'err', text: v.alert });
    // 焦点移到第一个出错的字段（和组织信息一样）
    const order: DraftField[] = ['title', 'summary', 'bodyHtml', 'stats', 'homeHeading', 'homeIntro'];
    const first = order.find((k) => v.fieldErrors[k]);
    if (first) {
      window.requestAnimationFrame(() => {
        const el = first === 'bodyHtml' ? document.querySelector<HTMLElement>('.st-rich')
          : first === 'stats' ? document.querySelector<HTMLElement>('.st-stats input')
          : document.getElementById(`st-${first}`);
        el?.focus();
      });
    }
  };

  const discard = () => { if (!saved) return; setDraft(structuredClone(saved.locales)); setEpoch((n) => n + 1); setServerErr({}); };

  const applyToggle = async (to: boolean) => {
    setConfirm(null);
    if (writesBlocked(conflictRef.current)) return;
    setBusy(true); setNotice(null); setServerErr({});
    const r = await aboutSettingsApi.setEnabled(to, saved?.enabledVersion ?? null);
    setBusy(false);
    if (r.ok) { setSaved((p) => (p ? { ...p, enabled: r.data.enabled, enabledVersion: r.data.enabledVersion } : r.data)); return; }
    if (isVersionConflict(r)) { step('conflict'); return; }
    const v = saveFailureView(r);
    if (v.alert) setNotice({ kind: 'err', text: v.alert });
    else if (Object.keys(v.fieldErrors).length) setNotice({ kind: 'err', text: settingsErrorText(r.code) }); // enabled 路径通常对不上字段
  };

  /** 冲突后「刷新」→ 确认「未保存的修改将丢弃」→ 读最新内容和版本号，丢弃本地修改 */
  const confirmRefresh = async () => {
    if (!step('confirm').reload) return;
    try {
      const fresh = await aboutSettingsApi.load(locales);
      setSaved(fresh); setDraft(structuredClone(fresh.locales)); setEpoch((n) => n + 1); setServerErr({}); setNotice(null);
      step('reloaded');
    } catch (e) {
      step('reload_failed');
      setNotice({ kind: 'err', text: settingsErrorText(e instanceof Error ? e.message : 'unknown') });
    }
  };

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? locales.length - 1 : null;
    if (n === null) return;
    e.preventDefault();
    const l = locales[(n + locales.length) % locales.length];
    setTab(l); tabRefs.current[l]?.focus();
  };

  // 前台状态：开关开 + 该语言完整 + 已上线。完整与否以后端结果为准（TODO(backend #350)：接口返回 complete）
  const comp = (l: string) => draftCompleteness(savedLocales[l] ?? emptyDraft());
  const shownLocales = saved?.enabled ? locales.filter((l) => publishedLocales.includes(l) && comp(l).state === 'complete') : [];

  if (!saved) return <div className="st-page"><p>{notice?.text ?? '加载中…'}</p></div>;

  const field = (f: 'title' | 'summary' | 'homeHeading' | 'homeIntro', label: string, opts: { required?: boolean; hint?: string; multiline?: boolean } = {}) => {
    const c = fieldCount(f, d);
    const id = `st-${f}`;
    const err = errors[f];
    const desc = [`${id}-c`, opts.hint ? `${id}-h` : '', err ? `${id}-e` : ''].filter(Boolean).join(' ');
    const common = { id, dir, value: d[f], 'aria-invalid': err ? true : undefined, 'aria-describedby': desc, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(f, e.target.value) };
    return (
      <div className="st-f">
        <div className="st-lab"><label htmlFor={id}>{label}{opts.required && <b aria-hidden="true"> *</b>}</label><Counter id={`${id}-c`} {...c} /></div>
        {opts.multiline ? <textarea rows={4} {...common} /> : <input type="text" {...common} />}
        {opts.hint && <p id={`${id}-h`} className="st-hint">{opts.hint}</p>}
        {err && <p id={`${id}-e`} className="st-ferr">{err}</p>}
      </div>
    );
  };
  const bodyC = fieldCount('bodyHtml', d);

  return (
    <div className="st-page">
      <p className="st-crumb">{T.crumb}</p>
      <SettingsSections current="about" />
      <div className="st-hd">
        <div>
          <h1>{T.h1}</h1>
          {d.updatedAt && <p className="st-audit">{T.lastEdited}{d.updatedByName ?? '—'} · <AdminTime iso={d.updatedAt} /></p>}
        </div>
        {/* UX 定稿：只在当前语言前台可见（开关开 + 已上线 + 已保存的内容完整）时给链接；否则灰字说明，不放死链接 */}
        {shownLocales.includes(tab)
          ? <a className="adm-btn st-preview" href={`/${tab}/about`} target="_blank" rel="noopener">{T.preview}</a>
          : <span className="st-unpub">{T.unpublished}</span>}
      </div>
      {notice?.kind === 'ok' && <p className="st-ok" role="status">{notice.text}</p>}
      {notice?.kind === 'err' && <p className="st-err" role="alert">{notice.text}</p>}
      {conflict !== 'none' && (
        <div className="st-err st-conflict" role="alert">
          <span>{T.conflict}</span>
          <button type="button" className="adm-btn" disabled={conflict === 'loading'} aria-busy={conflict === 'loading' || undefined} onClick={() => step('refresh')}>{T.conflictRefresh}</button>
        </div>
      )}

      <div className="st-grid">
        <div className="st-main">
          <section className="adm-card st-card" aria-labelledby="st-vis-h">
            <div className="st-vis">
              <h2 id="st-vis-h">{T.visibility}</h2>
              <button type="button" role="switch" aria-checked={saved.enabled} aria-labelledby="st-vis-h" className="st-switch" disabled={busy || writesBlocked(conflict)} onClick={() => setConfirm(!saved.enabled)}><i aria-hidden="true" /></button>
            </div>
            <p className="st-hint">{saved.enabled ? T.visibilityOn(shownLocales) : T.visibilityOff}</p>
          </section>

          <section className="adm-card st-card">
            <div className="st-tabs" role="tablist" aria-label="语言">
              {locales.map((l, i) => {
                const c = comp(l);
                return (
                  <button key={l} ref={(el) => { tabRefs.current[l] = el; }} type="button" role="tab" id={`st-tab-${l}`} aria-selected={tab === l} aria-controls="st-panel" tabIndex={tab === l ? 0 : -1}
                    onClick={() => setTab(l)} onKeyDown={(e) => onTabKey(e, i)}>
                    {l.toUpperCase()} <span className={`st-dot ${c.state}`} aria-hidden="true" /><span className="st-dotl">{c.label}</span>
                  </button>
                );
              })}
            </div>
            <div id="st-panel" role="tabpanel" aria-labelledby={`st-tab-${tab}`}>
              {field('title', '标题', { required: true, hint: T.titleHint })}
              {field('summary', T.summaryLabel)}
              <div className="st-f">
                <div className="st-lab"><span id="st-body-l">正文<b aria-hidden="true"> *</b></span><Counter id="st-body-c" {...bodyC} /></div>
                <BodyEditor key={`${tab}-${epoch}`} initial={d.bodyHtml} dir={dir} invalid={!!errors.bodyHtml} describedBy={`st-body-c st-body-h${errors.bodyHtml ? ' st-body-e' : bodyTooShortNote(d) ? ' st-body-s' : ''}`} onChange={(html) => set('bodyHtml', html)} />
                <p id="st-body-h" className="st-hint">{T.bodyHint}</p>
                {!errors.bodyHtml && bodyTooShortNote(d) && <p id="st-body-s" className="st-warn">{bodyTooShortNote(d)}</p>}
                {errors.bodyHtml && <p id="st-body-e" className="st-ferr">{errors.bodyHtml}</p>}
              </div>

              <fieldset className="st-f st-stats">
                <legend>{T.statsLabel} <span className="st-count">{d.stats.length} / {ABOUT_LIMITS.statsMax}</span></legend>
                {d.stats.map((s, i) => (
                  <div key={i} className="st-stat">
                    <input aria-label={`${T.statValue}（第 ${i + 1} 条）`} placeholder={T.statValue} dir={dir} maxLength={ABOUT_LIMITS.statValueMax * 2} value={s.value} onChange={(e) => set('stats', d.stats.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                    <input aria-label={`${T.statLabel}（第 ${i + 1} 条）`} placeholder={T.statLabel} dir={dir} maxLength={ABOUT_LIMITS.statLabelMax * 2} value={s.label} onChange={(e) => set('stats', d.stats.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                    {i > 0 && <button type="button" className="adm-btn sq st-up" aria-label={`上移第 ${i + 1} 条`} onClick={() => { const n = [...d.stats]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; set('stats', n); }}>↑</button>}
                    <button type="button" className="adm-btn sq" aria-label={`删除第 ${i + 1} 条`} onClick={() => set('stats', d.stats.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                {d.stats.length < ABOUT_LIMITS.statsMax && <button type="button" className="adm-btn" onClick={() => set('stats', [...d.stats, { value: '', label: '' }])}>{T.statAdd}</button>}
                <p className="st-hint">{T.statHint}</p>
                {errors.stats && <p className="st-ferr" role="alert">{errors.stats}</p>}
              </fieldset>
              {/* 图片列表等 PublicAsset PR（安全审）后另开 PR 接入：JPG / PNG / WebP，单张 ≤ 10 MB（413 file_too_large） */}
            </div>
          </section>

          <section className="adm-card st-card" aria-labelledby="st-home-h">
            <h2 id="st-home-h">{T.homeTitle(tab)}</h2>
            <p className="st-hint">{T.homeHint}</p>
            {field('homeHeading', T.homeHeading)}
            {field('homeIntro', T.homeIntro, { multiline: true })}
          </section>
        </div>

        <aside className="st-side">
          <section className="adm-card st-card" aria-labelledby="st-chk-h">
            <h2 id="st-chk-h">{T.checklist(tab)}</h2>
            <ul className="st-chk">
              {draftChecklist(d).map((c) => (
                <li key={c.key}><span className={`i ${c.state}`} aria-hidden="true">{c.state === 'ok' ? '✓' : c.state === 'missing' ? '!' : '–'}</span>
                  <span>{c.label}<span className="sr-only">{c.state === 'ok' ? '（已满足）' : c.state === 'missing' ? '（未满足）' : '（选填）'}</span></span></li>
              ))}
            </ul>
          </section>
          <section className="adm-card st-card">
            <h2>{T.localeStatus}</h2>
            <ul className="st-status">
              {locales.map((l) => {
                const shown = shownLocales.includes(l);
                const why = !saved.enabled ? '前台显示已关闭' : !publishedLocales.includes(l) ? '语言未上线' : comp(l).label;
                return <li key={l}><code>/{l}/about</code> <span className={shown ? 'on' : 'off'}>{shown ? T.shown : T.hidden(why)}</span></li>;
              })}
            </ul>
            <p className="st-hint">{T.newLocalesNote}</p>
          </section>
        </aside>
      </div>

      {dirty && (
        <div className="st-bar" role="region" aria-label="保存">
          <span className="st-bar-msg">{T.dirty}{conflict !== 'none' ? <small>{T.conflictBar}</small> : <small>（{summary}）</small>}</span>
          <button type="button" className="adm-btn" disabled={busy || conflict !== 'none'} onClick={discard}>{T.discard}</button>
          <button type="button" className="adm-btn primary" disabled={!saveAllowed} title={conflict !== 'none' ? T.conflictSaveTitle : undefined} aria-busy={busy || undefined} onClick={save}>{busy ? T.saving : T.save}</button>
        </div>
      )}

      {conflict === 'confirm' && (
        <ConfirmDialog title={T.conflictConfirmTitle} confirmLabel={T.conflictConfirmOk} danger onCancel={() => step('cancel')} onConfirm={confirmRefresh}>
          {dirty && <p>{summary}</p>}
        </ConfirmDialog>
      )}

      {confirm !== null && (
        <ConfirmDialog
          title={confirm ? T.onTitle : T.offTitle} confirmLabel={confirm ? T.onConfirm : T.offConfirm} danger={!confirm}
          onCancel={() => setConfirm(null)} onConfirm={() => applyToggle(confirm)}
        >
          {confirm ? (
            <>
              <p>{T.onShown}{locales.filter((l) => publishedLocales.includes(l) && comp(l).state === 'complete').map((l) => l.toUpperCase()).join('、') || '无'}</p>
              <p>{T.onHidden}{locales.filter((l) => !(publishedLocales.includes(l) && comp(l).state === 'complete')).map((l) => l.toUpperCase()).join('、') || '无'}</p>
            </>
          ) : (
            <>
              <p>{T.offLead}</p>
              <ul><li>{locales.map((l) => `/${l}/about`).join('、')} {T.off404}</li><li>{T.offNav}</li><li>{T.offSitemap}</li></ul>
              <p>{T.offKeep}</p>
            </>
          )}
          {dirty && <p className="st-warn">{T.unsavedNotPublished}</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}
