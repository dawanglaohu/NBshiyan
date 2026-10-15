'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { adminApi, REVIEW_THRESHOLD, STATUS_LABEL, type AdminUser, type InquiryQuery, type InquiryStatus, type InquirySummary, type Page } from '@/lib/admin/api';
import StatusBadge from './StatusBadge';
import DateRange from './DateRange';
import { DeletedTag, filterAnonymized, isAnonymized, needsReview, parseIncludeAnon, piiField } from './anonymized';
import { PRODUCT_LABEL, errorText, loginHref, productName, relTime } from './format';

const TABS: (InquiryStatus | 'REVIEW' | '')[] = ['', 'NEW', 'FOLLOWING', 'QUOTED', 'WON', 'INVALID', 'REVIEW'];
const tabLabel = (t: (typeof TABS)[number]) => (t === '' ? '全部' : t === 'REVIEW' ? `待核实（<${REVIEW_THRESHOLD} 分）` : STATUS_LABEL[t]);

export default function InquiryList() {
  const sp = useSearchParams();
  const router = useRouter();
  // 筛选条件放在 URL 里，刷新、分享链接都能保留
  const query: InquiryQuery = {
    status: (sp.get('status') as InquiryQuery['status']) || undefined, q: sp.get('q') || undefined,
    from: sp.get('from') || undefined, to: sp.get('to') || undefined, product: sp.get('product') || undefined,
    assignee: sp.get('assignee') || undefined, page: Number(sp.get('page') || 1), pageSize: 10
  };
  // 「含已匿名化」默认关：打开时传 includeAnonymized=true（关时不传）；后端参数上线前，另在当前页客户端过滤兜底
  const includeAnon = parseIncludeAnon(sp.get('anon'));
  if (includeAnon) query.includeAnonymized = true;
  const key = sp.toString();
  const [data, setData] = useState<Page<InquirySummary>>();
  const [error, setError] = useState<string>();
  const [q, setQ] = useState(query.q ?? '');
  // 可信度 <40 的询盘默认折叠到「待核实」分组（#85 第 2 条）
  const [reviewOpen, setReviewOpen] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  useEffect(() => { adminApi.listUsers().then(setUsers).catch(() => {}); }, []);
  useEffect(() => {
    let live = true; setError(undefined);
    adminApi.listInquiries(query).then((d) => live && setData(d)).catch((e) => live && setError(String(e.message ?? e)));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (patch: Record<string, string | undefined>) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    if (!('page' in patch)) n.delete('page');
    router.replace(`/admin/inquiries${n.size ? `?${n}` : ''}`);
  };
  const row = (r: InquirySummary) => {
    const cls = ['row', needsReview(r) ? 'review' : r.status === 'NEW' && !r.assignee ? 'unassigned' : ''].join(' ').trim();
    const go = () => router.push(`/admin/inquiries/${r.id}`);
    return (
      <tr key={r.id} className={cls} tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
        title={r.status === 'NEW' && !r.assignee ? '未分配，请尽快分配负责人' : undefined}>
        <td><Link href={`/admin/inquiries/${r.id}`} onClick={(e) => e.stopPropagation()} tabIndex={-1}>{r.ref}</Link></td>
        <td>{isAnonymized(r) ? piiField(r, null) : r.contact.company ?? r.contact.email.split('@')[1]} · {r.contact.region}</td>
        <td>{r.products.length ? <>{productName(r.products[0].productSlug)}{r.products.length > 1 ? ` +${r.products.length - 1}` : ''}</> : r.itemCount ? `${r.itemCount} 个产品` : '—'}</td>
        <td className={needsReview(r) ? 'warn' : undefined}>{r.trustScore}{needsReview(r) ? ' ⚠' : ''}</td>
        <td><StatusBadge status={r.status} />{isAnonymized(r) && <DeletedTag />}</td>
        <td className="muted">{r.assignee?.name ?? '—'}</td>
        <td className="muted" title={r.createdAt}>{relTime(r.createdAt)}</td>
      </tr>
    );
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <h1>询盘管理{data ? ` (${data.total})` : ''}</h1>
      <div className="adm-tabs" role="group" aria-label="状态">
        {TABS.map((t) => <button key={t} type="button" aria-pressed={(query.status ?? '') === t} onClick={() => set({ status: t || undefined })}>{tabLabel(t)}</button>)}
      </div>
      <form className="adm-filters" onSubmit={(e) => { e.preventDefault(); set({ q: q.trim() || undefined }); }}>
        <input type="search" placeholder="搜索公司 / 邮箱 / 编号" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索" />
        <DateRange from={query.from} to={query.to} onChange={(from, to) => set({ from, to })} />
        <select value={query.product ?? ''} onChange={(e) => set({ product: e.target.value || undefined })} aria-label="产品">
          <option value="">产品：全部</option>
          {Object.entries(PRODUCT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={query.assignee ?? ''} onChange={(e) => set({ assignee: e.target.value || undefined })} aria-label="负责人">
          <option value="">负责人：全部</option><option value="me">分给我的</option><option value="none">未分配</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <button className="adm-btn" type="submit">搜索</button>
        <label className="muted"><input type="checkbox" checked={includeAnon} onChange={(e) => set({ anon: e.target.checked ? '1' : undefined, page: query.page && query.page > 1 ? String(query.page) : undefined })} /> 含已匿名化</label>
        {sp.size > 0 && <button className="adm-btn" type="button" onClick={() => { setQ(''); router.replace('/admin/inquiries'); }}>清除筛选</button>}
      </form>
      <div className="adm-card">
        <table>
          <thead><tr><th>编号</th><th>公司 · 国家</th><th>产品</th><th>可信度</th><th>状态</th><th>负责人</th><th>时间</th></tr></thead>
          <tbody>
            {error && <tr><td colSpan={7} className="warn">{errorText(error)}{error === 'unauthorized' && <> <a href={loginHref()}>去登录</a></>}</td></tr>}
            {!data && !error && <tr><td colSpan={7} className="muted">加载中…</td></tr>}
            {data && data.items.length > 0 && filterAnonymized(data.items, includeAnon).length === 0 && <tr><td colSpan={7} className="muted">本页都是已匿名化询盘，勾选「含已匿名化」可查看</td></tr>}
            {data?.items.length === 0 && <tr><td colSpan={7} className="muted">没有符合条件的询盘</td></tr>}
            {data && (() => {
              const items = filterAnonymized(data.items, includeAnon);
              const isReview = (r: InquirySummary) => needsReview(r);
              const review = query.status === 'REVIEW' ? [] : items.filter(isReview);
              const main = query.status === 'REVIEW' ? items : items.filter((r) => !isReview(r));
              return (<>
                {main.map(row)}
                {review.length > 0 && (
                  <tr className="group" onClick={() => setReviewOpen(!reviewOpen)}>
                    <td colSpan={7}><button type="button" aria-expanded={reviewOpen}>{reviewOpen ? '▾' : '▸'} 待核实（可信度 &lt;{REVIEW_THRESHOLD}）· 本页 {review.length} 条</button></td>
                  </tr>)}
                {reviewOpen && review.map(row)}
              </>);
            })()}
          </tbody>
        </table>
        <div className="adm-pager">
          <span className="muted">第 {query.page} / {pages} 页</span>
          <button className="adm-btn" disabled={(query.page ?? 1) <= 1} onClick={() => set({ page: String((query.page ?? 1) - 1) })}>上一页</button>
          <button className="adm-btn" disabled={(query.page ?? 1) >= pages} onClick={() => set({ page: String((query.page ?? 1) + 1) })}>下一页</button>
        </div>
      </div>
    </>
  );
}
