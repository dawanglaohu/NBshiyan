'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminApi, REVIEW_THRESHOLD, SOURCE_LABEL, STATUS_LABEL, type AdminUser, type InquiryDetail, type InquiryStatus } from '@/lib/admin/api';
import StatusBadge from './StatusBadge';
import { fmtDate, productName } from './format';

/** 去掉所有 HTML 标签，只显示纯文本（询盘内容一律不渲染 HTML、链接不可点击，见 PRD 第 9 节） */
const plain = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');

export default function InquiryDetailView({ id }: { id: string }) {
  const [inq, setInq] = useState<InquiryDetail | null>();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    adminApi.getInquiry(id).then((d) => { setInq(d); if (d) setSubject(`Re: ${d.ref}`); }).catch((e) => setErr(String(e.message ?? e)));
    adminApi.listUsers().then(setUsers).catch(() => {});
  }, [id]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(undefined);
    try { await fn(); setInq(await adminApi.getInquiry(id)); } catch (e) { setErr(String((e as Error).message ?? e)); } finally { setBusy(false); }
  };

  if (inq === undefined) return <p className="muted">{err ? `加载失败：${err}` : '加载中…'}</p>;
  if (inq === null) return <p>找不到这条询盘。 <Link href="/admin/inquiries">返回列表</Link></p>;
  const c = inq.contact;
  return (
    <>
      <p style={{ margin: '0 0 8px' }}><Link href="/admin/inquiries" className="muted">← 询盘列表</Link></p>
      <div className="adm-row" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>{inq.ref} · {c.company ?? c.name}</h1>
        <StatusBadge status={inq.status} />
        {inq.trustScore < REVIEW_THRESHOLD && <span className="badge INVALID">待核实</span>}
      </div>
      {err && <p className="warn">操作失败：{err}</p>}
      <div className="adm-detail">
        <div>
          <section className="adm-sec">
            <h2>客户信息</h2>
            <dl className="adm-kv">
              <dt>姓名</dt><dd>{c.name}</dd>
              <dt>邮箱</dt><dd>{c.email}</dd>
              {c.company && (<><dt>公司</dt><dd>{c.company}</dd></>)}
              {c.phone && (<><dt>电话</dt><dd>{c.phone}</dd></>)}
              <dt>国家</dt><dd>{c.region}{inq.ipCountry && inq.ipCountry !== c.region ? <span className="warn">（IP 国家 {inq.ipCountry}）</span> : null}</dd>
              <dt>语言</dt><dd>{inq.locale.toUpperCase()} → 回复用 {inq.locale.toUpperCase()}</dd>
              <dt>来源</dt><dd>{SOURCE_LABEL[inq.source]}{inq.attribution?.page && <> · <span className="adm-plain-url">{inq.attribution.page}</span></>}</dd>
              {inq.attribution?.utm && (<><dt>关键词</dt><dd>{Object.entries(inq.attribution.utm).map(([k, v]) => `${k}=${v}`).join(' · ')}</dd></>)}
              <dt>可信度</dt><dd><b className={inq.trustScore < REVIEW_THRESHOLD ? 'warn' : undefined}>{inq.trustScore}</b>
                <span className="muted"> · {inq.trustReasons.map((r) => `${r.label} ${r.delta > 0 ? '+' : ''}${r.delta}`).join('，')}</span></dd>
            </dl>
          </section>
          <section className="adm-sec">
            <h2>产品明细（{inq.items.length}）</h2>
            <table><thead><tr><th>产品</th><th>数量</th><th>规格</th><th>定制方案</th></tr></thead><tbody>
              {inq.items.map((it, i) => (
                <tr key={i} style={{ cursor: 'default' }}>
                  <td>{productName(it.productSlug)}</td><td>{it.quantity?.toLocaleString('en-US') ?? '—'}</td>
                  <td className="muted">{it.config ? Object.values(it.config).map(String).join(' · ') : '—'}</td>
                  <td>{it.designId ? <span className="adm-plain-url">/s/{it.designId}</span> : '—'}</td>
                </tr>))}
            </tbody></table>
          </section>
          <section className="adm-sec">
            <h2>客户留言</h2>
            {/* 纯文本显示，链接显示为完整网址、不可点击 */}
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }} className="adm-plain-text">{inq.message ?? '—'}</p>
          </section>
          <section className="adm-sec">
            <h2>附件 / Logo</h2>
            {inq.attachments.length === 0 ? <p className="muted" style={{ margin: 0 }}>无附件</p> : (
              <div className="adm-row">
                {inq.attachments.map((a) => (
                  <div key={a.id} className="adm-row">
                    {/* TODO: 后端鉴权查看接口就绪后，Logo 用重新编码后的文件显示；其他附件只提供下载，不在页面内预览 */}
                    <div className="adm-logo">{a.kind === 'logo' ? 'Logo 预览\n（待接鉴权接口）' : '仅下载'}</div>
                    <div><div>{a.filename}</div><div className="muted">{a.mime} · {(a.sizeBytes / 1024).toFixed(0)} KB</div></div>
                  </div>))}
              </div>)}
          </section>
          <section className="adm-sec">
            <h2>往来记录</h2>
            {inq.messages.map((m) => (
              <div key={m.id} className={`adm-msg ${m.direction}`}>
                <div className="meta">{m.direction === 'INBOUND' ? '客户' : `我们${m.author ? ` · ${m.author}` : ''}`} · {fmtDate(m.createdAt)} · {m.subject}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{plain(m.bodyHtml)}</div>
              </div>))}
          </section>
          <section className="adm-sec">
            <h2>回复客户（{inq.locale === 'ru' ? '俄语' : '英语'}）</h2>
            <form onSubmit={(e) => { e.preventDefault(); if (!body.trim()) return; run(async () => { await adminApi.reply(inq.id, { subject, bodyHtml: body.split('\n').map((l) => `<p>${l.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]!)}</p>`).join('') }); setBody(''); }); }}>
              <div className="adm-row" style={{ marginBottom: 8 }}>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="主题" style={{ flex: 1 }} />
                <select aria-label="插入模板" value="" onChange={(e) => { if (e.target.value) setBody((b) => b + e.target.value); }}>
                  <option value="">插入模板 ▾</option>
                  <option value={inq.locale === 'ru' ? 'Здравствуйте! Спасибо за запрос. Направляем коммерческое предложение во вложении.\n' : 'Hi, thanks for your inquiry. Please find our quotation attached.\n'}>报价单</option>
                  <option value={inq.locale === 'ru' ? 'Уточните, пожалуйста, размеры и материал коробки.\n' : 'Could you confirm the box dimensions and material?\n'}>确认规格</option>
                </select>
              </div>
              <textarea rows={5} style={{ width: '100%' }} value={body} onChange={(e) => setBody(e.target.value)} aria-label="回复内容" placeholder="回复内容（纯文本，发送前转义）" />
              <div className="adm-row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
                <span className="muted">附件：待后端上传接口（只发送，不在后台预览）</span>
                <button className="adm-btn primary" disabled={busy || !body.trim()}>发送</button>
              </div>
            </form>
          </section>
        </div>
        <aside>
          <section className="adm-sec">
            <h2>处理</h2>
            <label className="muted" htmlFor="st">状态</label>
            <select id="st" style={{ width: '100%', margin: '4px 0 10px' }} value={inq.status} disabled={busy}
              onChange={(e) => run(() => adminApi.updateInquiry(inq.id, { status: e.target.value as InquiryStatus }))}>
              {(Object.keys(STATUS_LABEL) as InquiryStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <label className="muted" htmlFor="as">负责人</label>
            <select id="as" style={{ width: '100%', marginTop: 4 }} value={inq.assignee?.id ?? ''} disabled={busy}
              onChange={(e) => run(() => adminApi.updateInquiry(inq.id, { assigneeId: e.target.value || null }))}>
              <option value="">未分配</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </section>
          <section className="adm-sec">
            <h2>内部备注</h2>
            {inq.notes.map((n) => <p key={n.id} style={{ margin: '0 0 8px' }}><b>{n.author}</b> <span className="muted">{fmtDate(n.createdAt)}</span><br />{n.body}</p>)}
            <form onSubmit={(e) => { e.preventDefault(); if (note.trim()) run(async () => { await adminApi.addNote(inq.id, note.trim()); setNote(''); }); }}>
              <textarea rows={3} style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="只有团队可见，可 @ 同事" aria-label="内部备注" />
              <button className="adm-btn" disabled={busy || !note.trim()} style={{ marginTop: 6 }}>添加备注</button>
            </form>
          </section>
          <section className="adm-sec">
            <h2>操作历史</h2>
            <ul className="adm-hist">
              {[...inq.history].reverse().map((h) => <li key={h.id}><span className="muted">{fmtDate(h.at)}</span><br />{h.actor ? `${h.actor}：` : ''}{h.action}</li>)}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
