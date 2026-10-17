'use client';
// #74 未归类收件箱（仅 ADMIN；8.4 / 8.9 / 8.10 / 8.5 / 8.6）。规格：ux-spec.md B 节。
import { useCallback, useEffect, useRef, useState } from 'react';
import { mailApi, MailError, type AssignLookup, type UnassignedDetail, type UnassignedPage } from '@/lib/admin/mail/api';
import { ALREADY_HANDLED, ASSIGN_HINT, assignErrorText, DELETED, expiresText, fmtCountdown, REF_RE, showUnverified, subjectText, UNVERIFIED } from '@/lib/admin/mail/logic';
import { AttachmentCard, FlagBanners, FlagChips, MailBody, Unverified, useCountdown } from './MailParts';
import AdminTime from '../AdminTime';

type Tab = 'UNASSIGNED' | 'IGNORED';

export default function UnassignedInbox() {
  const [tab, setTab] = useState<Tab>('UNASSIGNED');
  const [page, setPage] = useState<UnassignedPage>();
  const [sel, setSel] = useState<string>();
  const [detail, setDetail] = useState<UnassignedDetail | null>();
  const [notice, setNotice] = useState<string>();
  const [toast, setToast] = useState<{ id: string }>();
  const [err, setErr] = useState<string>();

  const load = useCallback(async (t: Tab = tab) => {
    try { setPage(await mailApi.listUnassigned(t)); setErr(undefined); } catch (e) { setErr(e instanceof MailError ? e.code : 'unknown'); }
  }, [tab]);
  useEffect(() => { void load(tab); }, [tab, load]);
  useEffect(() => {
    if (!sel) { setDetail(undefined); return; }
    let live = true; setDetail(undefined);
    mailApi.getUnassigned(sel).then((d) => live && setDetail(d)).catch((e) => {
      if (!live) return;
      if (e instanceof MailError && e.code === 'not_found') { setNotice(ALREADY_HANDLED); setSel(undefined); void load(); } else setDetail(null);
    });
    return () => { live = false; };
  }, [sel, load]);

  const handled = () => { setNotice(ALREADY_HANDLED); setSel(undefined); void load(); };
  const ignore = async (id: string) => {
    try { await mailApi.ignore(id); setSel(undefined); setToast({ id }); await load(); }
    catch (e) { if (e instanceof MailError && e.code === 'not_unassigned') handled(); }
  };
  const unignore = async (id: string) => {
    try { await mailApi.unignore(id); setToast(undefined); setSel(undefined); await load(); }
    catch (e) { if (e instanceof MailError && e.code === 'not_unassigned') handled(); }
  };

  return (
    <div className="ml">
      <h1>未归类邮件</h1>
      <p className="muted">匹配不到询盘的来信。只有管理员能看，收到满 90 天自动删除（忽略不改期限）。</p>
      {notice && <div className="ml-banner" role="status">ⓘ {notice} <button type="button" className="ml-btn" onClick={() => setNotice(undefined)}>知道了</button></div>}
      {err && <p className="warn" role="alert">加载失败：{err}</p>}
      <div className="adm-tabs" role="group" aria-label="分类">
        <button type="button" aria-pressed={tab === 'UNASSIGNED'} onClick={() => { setTab('UNASSIGNED'); setSel(undefined); }}>待处理 ({page?.counts.unassigned ?? '…'})</button>
        <button type="button" aria-pressed={tab === 'IGNORED'} onClick={() => { setTab('IGNORED'); setSel(undefined); }}>已忽略 ({page?.counts.ignored ?? '…'})</button>
      </div>
      <div className={`ml-inbox${sel ? ' has-sel' : ''}`}>
        <ul className="ml-list" aria-label="邮件列表">
          {page?.items.map((r) => {
            const ex = expiresText(r.expiresAt);
            const subj = subjectText(r);
            return (
              <li key={r.id}>
                <button type="button" aria-current={sel === r.id ? 'true' : undefined} onClick={() => setSel(r.id)}>
                  <span className="ml-row sb"><b className="ml-from">{r.redacted ? '—' : r.from}</b><AdminTime iso={r.receivedAt} className="muted" /></span>
                  <span className={`s${subj === r.subject ? '' : ' ph'}`}>{r.redacted ? DELETED : subj}</span>
                  {r.snippet && <span className="muted snip">{r.snippet}</span>}
                  <span className="ml-row">
                    <FlagChips flags={r.flags} />
                    {r.senderVerified === false && !r.redacted && <span className="ml-chip" title={UNVERIFIED}>未验证</span>}
                    {r.attachmentCount > 0 && <span className="muted">📎 {r.attachmentCount}</span>}
                    {r.suggestedInquiryRef && <span className="muted">可能是 {r.suggestedInquiryRef}</span>}
                    <span className={`ml-exp${ex.soon ? ' soon' : ''}`}>{ex.text}</span>
                  </span>
                </button>
              </li>);
          })}
          {page && !page.items.length && <li className="ml-empty">{tab === 'UNASSIGNED' ? '没有待处理的未归类邮件。' : '没有已忽略的邮件。'}</li>}
        </ul>
        <div className="ml-detail">
          {sel && <button type="button" className="ml-btn ml-back" onClick={() => setSel(undefined)}>← 返回列表</button>}
          {!sel && <p className="muted ml-pick">选择左侧的一封邮件查看。</p>}
          {sel && detail === undefined && <p className="muted">加载中…</p>}
          {sel && detail === null && <p className="warn" role="alert">加载失败，请刷新页面。</p>}
          {detail && <Detail d={detail} onIgnore={() => ignore(detail.id)} onUnignore={() => unignore(detail.id)} onAssigned={() => { setSel(undefined); void load(); }} onHandled={handled} />}
        </div>
      </div>
      {toast && <div className="ml-toast" role="status">已忽略 · <button type="button" onClick={() => unignore(toast.id)}>撤销</button> <button type="button" aria-label="关闭" onClick={() => setToast(undefined)}>×</button></div>}
    </div>
  );
}

function Detail({ d, onIgnore, onUnignore, onAssigned, onHandled }: { d: UnassignedDetail; onIgnore: () => void; onUnignore: () => void; onAssigned: () => void; onHandled: () => void }) {
  const ex = expiresText(d.expiresAt);
  const subj = subjectText(d);
  return (
    <article className="ml-msg in wide" aria-label="未归类邮件">
      <div className="ml-meta">{!d.redacted && <b>{d.from}</b>}{d.to && <span>→ {d.to}</span>}<AdminTime iso={d.receivedAt} />{d.redacted && <span className="ml-pill">已删除</span>}<span className={`ml-exp${ex.soon ? ' soon' : ''}`}>{ex.text}</span></div>
      {showUnverified(d) && <Unverified />}
      {!d.redacted && <FlagBanners flags={d.flags} />}
      {subj !== null && <div className={`ml-subj${subj === d.subject ? '' : ' ph'}`}>{subj}</div>}
      {d.redacted ? <div className="ml-deleted">{DELETED}</div> : <>
        <MailBody html={d.bodyHtml} text={d.bodyText} hasRemoteImages={d.hasRemoteImages} title={`邮件正文：${subj ?? ''}`} />
        {d.attachments.map((a) => <AttachmentCard key={a.id} a={a} />)}
      </>}
      {d.status === 'UNASSIGNED' ? <Assign d={d} onIgnore={onIgnore} onAssigned={onAssigned} onHandled={onHandled} />
        : <div className="ml-row" style={{ marginTop: 16 }}><button type="button" className="ml-btn" onClick={onUnignore}>移回待处理</button></div>}
    </article>
  );
}

function Assign({ d, onIgnore, onAssigned, onHandled }: { d: UnassignedDetail; onIgnore: () => void; onAssigned: () => void; onHandled: () => void }) {
  const [ref, setRef] = useState(d.suggestedInquiryRef ?? '');
  const [err, setErr] = useState<string>();
  const [hit, setHit] = useState<AssignLookup>();
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState<number>();
  const left = useCountdown(until);
  const opener = useRef<HTMLButtonElement>(null);
  const fail = (e: unknown, r: string) => {
    const err = e instanceof MailError ? e : new MailError('unknown', 0);
    if (err.code === 'rate_limited') { setUntil(Date.now() + (err.body.retryAfterSec ?? 60) * 1000); setErr(undefined); return; }
    if (err.code === 'not_unassigned' || (err.code === 'not_found' && hit)) { setHit(undefined); onHandled(); return; }
    setErr(assignErrorText(err.code, r)); setHit(undefined);
  };
  const lookup = async () => {
    const r = ref.trim().toUpperCase(); setErr(undefined);
    if (!REF_RE.test(r)) return setErr(assignErrorText('invalid', r));
    setBusy(true);
    try { setHit(await mailApi.assignLookup(r)); } catch (e) { fail(e, r); } finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!hit) return; setBusy(true);
    try { await mailApi.assign(d.id, hit.ref); setHit(undefined); onAssigned(); } catch (e) { fail(e, hit.ref); } finally { setBusy(false); }
  };
  const close = () => { setHit(undefined); opener.current?.focus(); };
  return (
    <div className="ml-assign">
      <label htmlFor="ml-ref">归到询盘</label>
      {d.suggestedInquiryRef && <p className="muted">{ASSIGN_HINT}</p>}
      <div className="ml-row">
        <input id="ml-ref" type="text" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="PJ-2026-0001" aria-invalid={!!err} aria-describedby={err ? 'ml-ref-err' : undefined} />
        <button ref={opener} type="button" className="ml-btn primary" disabled={busy || left > 0} onClick={lookup}>归到询盘</button>
        <button type="button" className="ml-btn" disabled={busy} onClick={onIgnore}>忽略</button>
      </div>
      {err && <div id="ml-ref-err" className="ml-ferr">{err}</div>}
      {left > 0 && <div className="ml-status" role="status">ⓘ 查询太频繁，请 <span aria-live="off">{fmtCountdown(left)}</span> 后再试。</div>}
      {hit && <ConfirmDialog hit={hit} unverified={d.senderVerified === false} busy={busy} onCancel={close} onConfirm={confirm} />}
    </div>
  );
}

function ConfirmDialog({ hit, unverified, busy, onCancel, onConfirm }: { hit: AssignLookup; unverified: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const box = useRef<HTMLDivElement>(null); const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
    if (e.key !== 'Tab') return;
    const f = box.current?.querySelectorAll<HTMLElement>('button:not([disabled])'); if (!f?.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="ml-overlay">
      <div ref={box} className="ml-dialog" role="dialog" aria-modal="true" aria-labelledby="ml-dlg-t" onKeyDown={onKey}>
        <h3 id="ml-dlg-t">归到询盘 {hit.ref}？</h3>
        <dl>
          <dt>客户</dt><dd>{hit.customer.name}{hit.customer.company ? ` · ${hit.customer.company}` : ''}</dd>
          <dt>邮箱</dt><dd>{hit.customer.emailMasked}</dd>
          <dt>创建</dt><dd><AdminTime iso={hit.createdAt} /></dd>
        </dl>
        {unverified && <Unverified />}
        <p className="muted">归档后这封信会出现在该询盘的往来记录里，跟随询盘的 730 天保留期。</p>
        <div className="ml-row end">
          <button ref={cancel} type="button" className="ml-btn" onClick={onCancel}>取消</button>
          <button type="button" className="ml-btn primary" disabled={busy} onClick={onConfirm}>确认归档</button>
        </div>
      </div>
    </div>
  );
}
