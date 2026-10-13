'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminApi, REVIEW_THRESHOLD, SOURCE_LABEL, STATUS_LABEL, type AdminUser, type InquiryDetail, type InquiryStatus } from '@/lib/admin/api';
import StatusBadge from './StatusBadge';
import { errorText, loginHref, fmtDate, productName, relTime } from './format';

/** 去掉所有 HTML 标签，只显示纯文本 */
// 服务端存的是转义后的 HTML（换行为 <br>）：先还原换行、去标签，再解码实体，整体按纯文本显示
const plain = (html: string) => html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))).replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
const URL_RE = /(https?:\/\/[^\s<>"]+)/g;
/** 链接一律显示为完整纯文本网址、不可点击（PRD 第 9 节 / #85） */
function PlainText({ text }: { text: string }) {
  return <>{text.split(URL_RE).map((part, i) => (i % 2 ? <span key={i} className="adm-url">{part}</span> : part))}</>;
}
const LANG = { en: '英语', ru: '俄语' } as const;
const draftKey = (id: string) => `pj-admin-draft:${id}`;

export default function InquiryDetailView({ id }: { id: string }) {
  const [inq, setInq] = useState<InquiryDetail | null>();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [body, setBody] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string>();
  const [logoErr, setLogoErr] = useState(false);

  useEffect(() => {
    adminApi.getInquiry(id).then(setInq).catch((e) => setErr(String(e.message ?? e)));
    adminApi.listUsers().then(setUsers).catch(() => {});
    setBody(localStorage.getItem(draftKey(id)) ?? '');
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

  // 后端：SALES 调 /users 只拿到自己，且不能改分配；列表里没有 ADMIN 即视为业务员视角（服务端仍会拒绝）
  const canAssign = users.some((u) => u.role === 'ADMIN');
  if (inq === undefined) return <p className="muted">{err ? errorText(err) : '加载中…'}</p>;
  if (inq === null) return <p>找不到这条询盘，或你没有查看权限。 <Link href="/admin/inquiries">返回列表</Link></p>;
  const c = inq.contact;
  const score = inq.trustScore;
  const ringColor = score < REVIEW_THRESHOLD ? 'var(--err)' : score < 70 ? 'var(--warn-c)' : 'var(--ok)';
  const sendAndFollow = () => run(async () => {
    await adminApi.reply(inq.id, { subject: `Re: ${inq.ref}`, body });
    if (inq.status === 'NEW') await adminApi.updateInquiry(inq.id, { status: 'FOLLOWING' });
    localStorage.removeItem(draftKey(inq.id)); setBody('');
  });

  return (
    <>
      <div className="adm-crumb"><Link href="/admin/inquiries">询盘</Link> / {inq.ref}</div>
      <div className="adm-hd">
        <h1>{c.company ?? c.name}</h1>
        <StatusBadge status={inq.status} />
        {score < REVIEW_THRESHOLD && <span className="badge REVIEW">待核实</span>}
        <span className="muted">· {c.region} · {relTime(inq.createdAt)}</span>
        <span className="sp" />
        <label className="muted">状态：<select value={inq.status} disabled={busy} onChange={(e) => run(() => adminApi.updateInquiry(inq.id, { status: e.target.value as InquiryStatus }))} aria-label="状态">
          {(Object.keys(STATUS_LABEL) as InquiryStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select></label>
        <label className="muted">负责人：<select value={inq.assignee?.id ?? ''} disabled={busy || !canAssign} title={canAssign ? undefined : '只有管理员可以改分配'} onChange={(e) => run(() => adminApi.updateInquiry(inq.id, { assigneeId: e.target.value || null }))} aria-label="负责人">
          <option value="">未分配</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select></label>
        <button type="button" className="adm-btn sq" disabled={busy || inq.status === 'INVALID'}
          onClick={() => { if (confirm('确定标记为无效询盘？')) run(() => adminApi.updateInquiry(inq.id, { status: 'INVALID' })); }}>标记无效</button>
      </div>
      {err && <p className="warn" role="alert">{errorText(err, '操作失败')}{err === 'unauthorized' && <> <a href={loginHref()}>去登录</a></>}</p>}

      <div className="adm-g2">
        <div>
          <section className="adm-sec">
            <h2>往来记录 <span className="muted">{inq.messages.length + inq.attachments.length} 条</span></h2>
            {inq.message && (
              <div className="adm-msg2 INBOUND"><div className="meta">客户 · {c.name} · {fmtDate(inq.createdAt)}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}><PlainText text={inq.message} /></div></div>)}
            {inq.messages.map((m) => (
              <div key={m.id} className={`adm-msg2 ${m.direction}`}>
                <div className="meta">{m.direction === 'INBOUND' ? `客户 · ${c.name}` : `我们${m.author ? ` · ${m.author}` : ''}`} · {fmtDate(m.createdAt)} · {m.subject}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}><PlainText text={plain(m.bodyHtml)} /></div>
              </div>))}
            {inq.attachments.map((a) => (
              <div key={a.id} className="adm-msg2 INBOUND">
                <div className="meta">客户 · 附件</div>
                📎 {a.filename} · {(a.sizeBytes / 1024 / 1024).toFixed(1)}MB ·{' '}
                {a.scan === 'clean' ? <span className="adm-scan">扫描通过</span> : <span className="warn">{a.scan === 'infected' ? '发现风险，已拦截' : '扫描中'}</span>}
                {' · '}{a.scan === 'clean' && a.downloadUrl ? <a href={a.downloadUrl} download rel="noopener">下载</a> : <span className="muted">下载</span>}
                <span className="muted">（不在页面预览）</span>
              </div>))}
          </section>

          <section className="adm-sec">
            <h2>回复客户 <span className="muted">将以{LANG[inq.locale]}发送</span></h2>
            <textarea rows={5} style={{ width: '100%' }} value={body} onChange={(e) => { setBody(e.target.value); setSaved(false); }} aria-label="回复内容"
              placeholder={inq.locale === 'ru' ? `Здравствуйте, ${c.name}!` : `Dear ${c.name.split(' ')[0]}, thank you for…`} />
            <div className="adm-row" style={{ marginTop: 8 }}>
              <select aria-label="插入模板" value="" onChange={(e) => { if (e.target.value) setBody((b) => b + e.target.value); }}>
                <option value="">插入模板 ▾</option>
                <option value={inq.locale === 'ru' ? 'Спасибо за запрос. Коммерческое предложение во вложении.\n' : 'Thanks for your inquiry. Please find our quotation attached.\n'}>报价单</option>
                <option value={inq.locale === 'ru' ? 'Уточните, пожалуйста, размеры и материал.\n' : 'Could you confirm the dimensions and material?\n'}>确认规格</option>
              </select>
              <button type="button" className="adm-btn sq" disabled title="附件上传接口待后端提供">📎 附件</button>
              <span className="sp" style={{ flex: 1 }} />
              <button type="button" className="adm-btn sq" disabled={!body.trim()} onClick={() => { localStorage.setItem(draftKey(inq.id), body); setSaved(true); }}>{saved ? '草稿已保存' : '保存草稿'}</button>
              <button type="button" className="adm-btn primary sq" disabled={busy || !body.trim()} onClick={sendAndFollow}>
                {inq.status === 'NEW' ? '发送并改为“跟进中”' : '发送'}
              </button>
            </div>
          </section>

          <section className="adm-sec">
            <h2>内部备注 <span className="muted">仅团队可见</span></h2>
            {inq.notes.map((n) => <p key={n.id} style={{ margin: '0 0 8px' }}><b>{n.author}</b> <span className="muted">{fmtDate(n.createdAt)}</span><br />{n.body}</p>)}
            <form onSubmit={(e) => { e.preventDefault(); if (note.trim()) run(async () => { await adminApi.addNote(inq.id, note.trim()); setNote(''); }); }}>
              <textarea rows={2} style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="@同事 …" aria-label="内部备注" />
              <button className="adm-btn sq" disabled={busy || !note.trim()} style={{ marginTop: 6 }}>添加备注</button>
            </form>
          </section>

          <section className="adm-sec">
            <h2>操作历史</h2>
            <ul className="adm-hist">
              {[...inq.history].reverse().map((h) => <li key={h.id}><span className="muted">{fmtDate(h.at)}</span> · {h.actor ? `${h.actor}：` : ''}{h.action}</li>)}
            </ul>
          </section>
        </div>

        <aside>
          <section className="adm-sec">
            <h2>可信度</h2>
            <div className="adm-row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <div className="adm-ring" style={{ background: `conic-gradient(${ringColor} 0 ${score}%, #eee 0)` }} aria-label={`可信度 ${score}`}><b>{score}</b></div>
              <ul className="adm-chk">
                {inq.trustReasons.map((r, i) => <li key={i} style={{ color: r.delta < 0 ? 'var(--err)' : undefined }}>{r.delta >= 0 ? '✓' : '−'} {r.label}</li>)}
              </ul>
            </div>
          </section>
          <section className="adm-sec">
            <h2>客户信息</h2>
            <dl className="adm-kv">
              <dt>联系人</dt><dd>{c.name}</dd>
              <dt>邮箱</dt><dd>{c.email}</dd>
              {c.company && (<><dt>公司</dt><dd>{c.company}</dd></>)}
              {c.phone && (<><dt>电话</dt><dd>{c.phone}</dd></>)}
              <dt>国家</dt><dd>{c.region} · 回复用{LANG[inq.locale]}{inq.ipCountry && inq.ipCountry !== c.region ? <span className="warn">（IP 国家 {inq.ipCountry}）</span> : null}</dd>
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
                  {it.designId && <div className="muted">定制方案 <span className="adm-url">/s/{it.designId}</span></div>}
                </div>
              </div>))}
          </section>
        </aside>
      </div>
    </>
  );
}
