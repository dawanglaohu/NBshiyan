'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminApi, REVIEW_THRESHOLD, SOURCE_LABEL, STATUS_LABEL, type AdminUser, type InquiryDetail, type InquiryStatus } from '@/lib/admin/api';
import InquiryNotFound from './InquiryNotFound';
import MailThread from './mail/MailThread';
import StatusBadge from './StatusBadge';
import { AnonTag, DeletedBody, AnonConflictNotice, anonymizedNotice, detailControls, isAnonConflict, isAnonymized, piiField, StatusText } from './anonymized';
import { errorText, loginHref, fmtDate, productName, relTime } from './format';

const URL_RE = /(https?:\/\/[^\s<>"]+)/g;
/** 链接一律显示为完整纯文本网址、不可点击（PRD 第 9 节 / #85） */
function PlainText({ text }: { text: string }) {
  return <>{text.split(URL_RE).map((part, i) => (i % 2 ? <span key={i} className="adm-url">{part}</span> : part))}</>;
}
const LANG = { en: '英语', ru: '俄语' } as const;

/** role：当前登录账号的角色，由服务端页面从会话里读出后传入（#225） */
export default function InquiryDetailView({ id, role }: { id: string; role?: string }) {
  const [inq, setInq] = useState<InquiryDetail | null>();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [logoUrl, setLogoUrl] = useState<string>();
  const [logoErr, setLogoErr] = useState(false);

  useEffect(() => {
    adminApi.getInquiry(id).then(setInq).catch((e) => setErr(String(e.message ?? e)));
    adminApi.listUsers().then(setUsers).catch(() => {});
  }, [id]);
  // Logo 预览走鉴权接口 GET /api/admin/uploads/:id（mock 模式下为示例图）
  useEffect(() => {
    if (!inq?.logoUploadId) return;
    let url: string | undefined; let live = true;
    adminApi.logoPreview(inq.logoUploadId).then((u) => { url = u; if (live) setLogoUrl(u); }).catch(() => live && setLogoErr(true));
    return () => { live = false; if (url?.startsWith('blob:')) URL.revokeObjectURL(url); };
  }, [inq?.logoUploadId]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(undefined);
    try { await fn(); setInq(await adminApi.getInquiry(id)); } catch (e) { setErr(String((e as Error).message ?? e)); } finally { setBusy(false); }
  };

  // #225：只有当前登录的 ADMIN 能改分配；SALES 看不到下拉框，只显示负责人名字（服务端改分配仍返回 403）
  if (inq === undefined) return <p className="muted">{err ? <>{errorText(err)} <Link href="/admin/inquiries">返回列表</Link></> : '加载中…'}</p>;
  if (inq === null) return <InquiryNotFound />;
  const c = inq.contact;
  const anon = isAnonymized(inq);
  // 已匿名化：回复区、分配下拉框直接隐藏（服务端另有 409 拦截）
  const ctl = detailControls(inq, role);
  const who: React.ReactNode = anon ? <AnonTag /> : c.name;
  const score = inq.trustScore;
  const ringColor = score < REVIEW_THRESHOLD ? 'var(--err)' : score < 70 ? 'var(--warn-c)' : 'var(--ok)';

  return (
    <>
      <div className="adm-crumb"><Link href="/admin/inquiries">询盘</Link> / {inq.ref}</div>
      <div className="adm-hd">
        <h1>{anon ? `询盘 ${inq.ref}` : c.company ?? c.name}</h1>
        <StatusBadge status={inq.status} />
        {!anon && score < REVIEW_THRESHOLD && <span className="badge REVIEW">待核实</span>}
        <span className="muted">· {c.region} · {relTime(inq.createdAt)}</span>
        <span className="sp" />
        {ctl.statusEditable ? <label className="muted">状态：<select value={inq.status} disabled={busy} onChange={(e) => run(() => adminApi.updateInquiry(inq.id, { status: e.target.value as InquiryStatus }))} aria-label="状态">
          {(Object.keys(STATUS_LABEL) as InquiryStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select></label> : <StatusText label={STATUS_LABEL[inq.status]} />}
        {ctl.showAssign ? (
          <label className="muted">负责人：<select value={inq.assignee?.id ?? ''} disabled={busy} onChange={(e) => run(() => adminApi.updateInquiry(inq.id, { assigneeId: e.target.value || null }))} aria-label="负责人">
            <option value="">未分配</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></label>
        ) : ctl.showAssigneeText ? <span className="muted" data-testid="assignee-text">负责人：{inq.assignee?.name ?? '未分配'}</span> : null}
        {ctl.showInvalidate && <button type="button" className="adm-btn sq" disabled={busy || inq.status === 'INVALID'}
          onClick={() => { if (confirm('确定标记为无效询盘？')) run(() => adminApi.updateInquiry(inq.id, { status: 'INVALID' })); }}>标记无效</button>}
      </div>
      {inq.anonymizedAt && <p data-testid="anon-notice" style={{ color: 'var(--ink-2)', margin: '0 0 12px' }}>{anonymizedNotice(inq.anonymizedAt, fmtDate)}</p>}
      {isAnonConflict(err) && <AnonConflictNotice />}
      {err && !isAnonConflict(err) && <p className="warn" role="alert">{errorText(err, '操作失败')}{err === 'unauthorized' && <> <a href={loginHref()}>去登录</a></>}</p>}

      <div className="adm-g2">
        <div>
          <section className="adm-sec">
            <h2>询盘留言</h2>
            {inq.message && (
              <div className="adm-msg2 INBOUND"><div className="meta">客户 · {who} · {fmtDate(inq.createdAt)}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{anon ? <DeletedBody /> : <PlainText text={inq.message} />}</div></div>)}
            {/* #74：邮件往来（含旧 InquiryMessage，source:"legacy"）和回复框在下面的 MailThread 里，按 8.3 接口渲染 */}
            {/* 附件区整体不显示：后端暂无附件接口（#85），有了再按扫描状态加回 */}
          </section>

          <MailThread inquiryId={inq.id} recipient={anon ? '' : `${c.name} <${c.email}>`}
            onSendAccepted={inq.status === 'NEW' ? () => run(() => adminApi.updateInquiry(inq.id, { status: 'FOLLOWING' })) : undefined}
            onAnonymized={() => { void adminApi.getInquiry(id).then(setInq).catch(() => {}); }} />

          <section className="adm-sec">
            <h2>内部备注 <span className="muted">{anon ? '只读' : '仅团队可见'}</span></h2>
            {inq.notes.map((n) => <p key={n.id} style={{ margin: '0 0 8px' }}><b>{n.author}</b> <span className="muted">{fmtDate(n.createdAt)}</span><br />{anon ? <DeletedBody /> : n.body}</p>)}
            {!anon && <form onSubmit={(e) => { e.preventDefault(); if (note.trim()) run(async () => { await adminApi.addNote(inq.id, note.trim()); setNote(''); }); }}>
              <textarea rows={2} style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="@同事 …" aria-label="内部备注" />
              <button className="adm-btn sq" disabled={busy || !note.trim()} style={{ marginTop: 6 }}>添加备注</button>
            </form>}
          </section>

          <section className="adm-sec">
            <h2>操作历史</h2>
            <ul className="adm-hist">
              {[...inq.history].reverse().map((h) => <li key={h.id}><span className="muted">{fmtDate(h.at)}</span> · {h.actor ? `${h.actor}：` : ''}{h.action}</li>)}
            </ul>
          </section>
        </div>

        <aside>
          {ctl.showTrust && <section className="adm-sec">
            <h2>可信度</h2>
            <div className="adm-row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <div className="adm-ring" style={{ background: `conic-gradient(${ringColor} 0 ${score}%, #eee 0)` }} aria-label={`可信度 ${score}`}><b>{score}</b></div>
              <ul className="adm-chk">
                {inq.trustReasons.map((r, i) => <li key={i} style={{ color: r.delta < 0 ? 'var(--err)' : undefined }}>{r.delta >= 0 ? '✓' : '−'} {r.label}</li>)}
              </ul>
            </div>
          </section>}
          <section className="adm-sec">
            <h2>客户信息</h2>
            <dl className="adm-kv">
              <dt>联系人</dt><dd>{piiField(inq, c.name)}</dd>
              <dt>邮箱</dt><dd>{piiField(inq, c.email)}</dd>
              {(anon || c.company) && (<><dt>公司</dt><dd>{piiField(inq, c.company)}</dd></>)}
              {(anon || c.phone) && (<><dt>电话</dt><dd>{piiField(inq, c.phone)}</dd></>)}
              <dt>国家</dt><dd>{c.region} · 回复用{LANG[inq.locale]}{!anon && inq.ipCountry && inq.ipCountry !== c.region ? <span className="warn">（IP 国家 {inq.ipCountry}）</span> : null}</dd>
              <dt>来源</dt><dd>{SOURCE_LABEL[inq.source]}{inq.attribution?.page && <> · <span className="adm-url">{inq.attribution.page}</span></>}</dd>
              {inq.attribution?.utm && (<><dt>关键词</dt><dd>{Object.entries(inq.attribution.utm).map(([k, v]) => `${k}=${v}`).join(' · ')}</dd></>)}
            </dl>
          </section>
          <section className="adm-sec">
            <h2>产品明细 <span className="muted">{inq.items.length} 项</span></h2>
            {inq.items.map((it, i) => (
              <div key={i} className="adm-prod">
                {inq.logoUploadId && i === 0 ? (logoUrl
                  // eslint-disable-next-line @next/next/no-img-element -- 鉴权接口返回的 blob，不走图片优化
                  ? <img className="adm-logo2" src={logoUrl} alt="客户 Logo" onError={() => { setLogoUrl(undefined); setLogoErr(true); }} />
                  : <span className="adm-logo2">{logoErr ? 'Logo 加载失败' : 'Logo…'}</span>) : null}
                <div>
                  <b>{productName(it.productSlug)} · {it.quantity?.toLocaleString('en-US') ?? '—'} pcs</b>
                  <div className="muted">{it.config ? Object.values(it.config).map(String).join(' · ') : '—'}{inq.logoUploadId && i === 0 ? ' · 附 Logo' : ''}</div>
                  {it.designId && <div className="muted">定制方案 <a className="adm-url" href={`/${inq.locale}/s/${it.designId}`} target="_blank" rel="noopener noreferrer">/{inq.locale}/s/{it.designId}</a></div>}
                </div>
              </div>))}
          </section>
        </aside>
      </div>
    </>
  );
}
