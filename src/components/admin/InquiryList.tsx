'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { adminApi, REVIEW_THRESHOLD, STATUS_LABEL, type InquiryQuery, type InquiryStatus, type InquirySummary, type Page } from '@/lib/admin/api';
import StatusBadge from './StatusBadge';
import { PRODUCT_LABEL, productName, relTime } from './format';

const TABS: (InquiryStatus | 'REVIEW' | '')[] = ['', 'NEW', 'FOLLOWING', 'QUOTED', 'WON', 'INVALID', 'REVIEW'];
const tabLabel = (t: (typeof TABS)[number]) => (t === '' ? '全部' : t === 'REVIEW' ? `待核实（<${REVIEW_THRESHOLD} 分）` : STATUS_LABEL[t]);

export default function InquiryList() {
  const sp = useSearchParams();
  const router = useRouter();
  // 筛选条件放在 URL 里，刷新、分享链接都能保留
  const query: InquiryQuery = {
    status: (sp.get('status') as InquiryQuery['status']) || undefined, q: sp.get('q') || undefined,
    from: sp.get('from') || undefined, to: sp.get('to') || undefined, product: sp.get('product') || undefined,
    mine: sp.get('mine') === '1', page: Number(sp.get('page') || 1), pageSize: 10
  };
  const key = sp.toString();
  const [data, setData] = useState<Page<InquirySummary>>();
  const [error, setError] = useState<string>();
  const [q, setQ] = useState(query.q ?? '');
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
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <h1>询盘管理{data ? ` (${data.total})` : ''}</h1>
      <div className="adm-tabs" role="group" aria-label="状态">
        {TABS.map((t) => <button key={t} type="button" aria-pressed={(query.status ?? '') === t} onClick={() => set({ status: t || undefined })}>{tabLabel(t)}</button>)}
      </div>
      <form className="adm-filters" onSubmit={(e) => { e.preventDefault(); set({ q: q.trim() || undefined }); }}>
        <input type="search" placeholder="搜索公司 / 邮箱 / 编号" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索" />
        <label className="muted">从 <input type="date" value={query.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} /></label>
        <label className="muted">到 <input type="date" value={query.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} /></label>
        <select value={query.product ?? ''} onChange={(e) => set({ product: e.target.value || undefined })} aria-label="产品">
          <option value="">产品：全部</option>
          {Object.entries(PRODUCT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="adm-row muted"><input type="checkbox" checked={!!query.mine} onChange={(e) => set({ mine: e.target.checked ? '1' : undefined })} /> 只看分给我的</label>
        <button className="adm-btn" type="submit">搜索</button>
        {key && <button className="adm-btn" type="button" onClick={() => { setQ(''); router.replace('/admin/inquiries'); }}>清除筛选</button>}
      </form>
      <div className="adm-card">
        <table>
          <thead><tr><th>编号</th><th>公司 · 国家</th><th>产品</th><th>可信度</th><th>状态</th><th>负责人</th><th>时间</th></tr></thead>
          <tbody>
            {error && <tr><td colSpan={7} className="warn">加载失败：{error}</td></tr>}
            {!data && !error && <tr><td colSpan={7} className="muted">加载中…</td></tr>}
            {data?.items.length === 0 && <tr><td colSpan={7} className="muted">没有符合条件的询盘</td></tr>}
            {data?.items.map((r) => (
              <tr key={r.id} onClick={() => router.push(`/admin/inquiries/${r.id}`)}>
                <td><Link href={`/admin/inquiries/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.ref}</Link></td>
                <td>{r.contact.company ?? r.contact.email.split('@')[1]} · {r.contact.region}</td>
                <td>{productName(r.products[0]?.productSlug ?? '')}{r.products.length > 1 ? ` +${r.products.length - 1}` : ''}</td>
                <td className={r.trustScore < REVIEW_THRESHOLD ? 'warn' : undefined}>{r.trustScore}{r.trustScore < REVIEW_THRESHOLD ? ' ⚠' : ''}</td>
                <td><StatusBadge status={r.status} /></td>
                <td className="muted">{r.assignee?.name ?? '—'}</td>
                <td className="muted" title={r.createdAt}>{relTime(r.createdAt)}</td>
              </tr>
            ))}
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
