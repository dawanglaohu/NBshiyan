'use client';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { adminApi } from '@/lib/admin/api';
import {
  actorView, HISTORY_ICON, HISTORY_PAGE_SIZE, HISTORY_TEXT, historyErrorText, historyReducer, initialHistory, loadMoreText, nextCursor, rateLimited, remaining,
  type HistoryItem, type HistoryState,
} from '@/lib/admin/history';
import { loginHref } from './format';
import AdminTime from './AdminTime';

/**
 * #331：询盘详情「操作历史」。GET /api/admin/inquiries/:id/history，新的在前，每页 10 条，
 * 「加载更早记录（剩 N 条）」按 before=<cursor> 取下一页；不做无限滚动、不轮询。
 * refreshKey 变化（回复、改状态、改分配之后）→ 重新拉第一页。
 */
export default function InquiryHistory({ inquiryId, refreshKey = 0 }: { inquiryId: string; refreshKey?: number }) {
  const [s, dispatch] = useReducer(historyReducer, initialHistory);
  // 每次拉第一页都换一个序号：旧的第一页 / 翻页响应回来时直接丢掉，不会覆盖新数据
  const gen = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  const loadFirst = useCallback(async () => {
    const g = ++gen.current;
    dispatch({ t: 'load' });
    try {
      const page = await adminApi.getHistory(inquiryId, { limit: HISTORY_PAGE_SIZE });
      if (g === gen.current) dispatch({ t: 'loaded', page });
    } catch (e) {
      if (g === gen.current) dispatch({ t: 'failed', code: codeOf(e), now: Date.now() });
    }
  }, [inquiryId]);

  useEffect(() => { void loadFirst(); }, [loadFirst, refreshKey]);

  // 429：一分钟内禁用重试 / 加载更早，到点自动恢复（只是一次性定时器，不是轮询）
  useEffect(() => {
    if (!s.rateUntil) return;
    const t = setTimeout(() => { setNow(Date.now()); dispatch({ t: 'rateOver' }); }, Math.max(0, s.rateUntil - Date.now()));
    setNow(Date.now());
    return () => clearTimeout(t);
  }, [s.rateUntil]);

  const loadMore = async () => {
    const before = nextCursor(s);
    if (!before) return;
    const g = gen.current;
    dispatch({ t: 'moreLoad' });
    try {
      const page = await adminApi.getHistory(inquiryId, { limit: HISTORY_PAGE_SIZE, before });
      if (g === gen.current) dispatch({ t: 'moreLoaded', page });
    } catch (e) {
      if (g !== gen.current) return;
      const code = codeOf(e);
      // 游标失效（比如记录被清理）：回到第一页重新开始
      if (code === 'bad_cursor') void loadFirst();
      else dispatch({ t: 'moreFailed', code, now: Date.now() });
    }
  };

  return <HistoryView s={s} limited={rateLimited(s, now)} onRetry={() => void loadFirst()} onMore={() => void loadMore()} />;
}

const codeOf = (e: unknown) => String((e as Error)?.message ?? e);

/** 纯展示：给测试直接渲染 */
export function HistoryView({ s, limited, onRetry, onMore }: { s: HistoryState; limited: boolean; onRetry: () => void; onMore: () => void }) {
  const left = remaining(s);
  return (
    <section className="adm-sec" aria-busy={s.phase === 'loading' || s.more === 'loading'} data-testid="inquiry-history">
      <h2>操作历史</h2>
      {s.phase === 'loading' && <HistorySkeleton />}
      {s.phase === 'error' && <HistoryError code={s.error} limited={limited} onRetry={onRetry} />}
      {s.phase === 'ready' && s.items.length === 0 && <p className="adm-empty-note" data-testid="empty-note">{HISTORY_TEXT.empty}</p>}
      {s.phase === 'ready' && s.items.length > 0 && <>
        <ol className="adm-hist adm-tl">{s.items.map((h) => <HistoryRow key={h.cursor} item={h} />)}</ol>
        {s.more === 'error' && <HistoryError code={s.moreError} limited={limited} onRetry={onMore} />}
        {left > 0 && s.more !== 'error' && (
          <button type="button" className="adm-btn sq adm-tl-more" disabled={s.more === 'loading' || limited} onClick={onMore}>
            {s.more === 'loading' ? HISTORY_TEXT.loadingMore : loadMoreText(left)}
          </button>)}
      </>}
    </section>
  );
}

/** summary、操作人都只作为 React 文本输出（后端已转纯文本、实体已解码），不用 innerHTML、不再解码 */
export function HistoryRow({ item }: { item: HistoryItem }) {
  const who = actorView(item);
  return (
    <li className={`adm-tl-row ${item.type}`}>
      <span className="adm-tl-ic" aria-hidden="true">{HISTORY_ICON[item.type]}</span>
      <div className="adm-tl-body">
        <div className="adm-tl-sum">{item.summary}</div>
        <div className="muted adm-tl-meta">{who.gone ? <span className="adm-tl-gone" data-testid="actor-gone">{who.text}</span> : who.text} · <AdminTime iso={item.at} /></div>
      </div>
    </li>
  );
}

/** 3 行骨架（不读屏；读屏用 aria-busy + 隐藏文字） */
export function HistorySkeleton() {
  return <>
    <span className="sr-only" role="status">{HISTORY_TEXT.loadingLabel}</span>
    <ol className="adm-hist adm-tl" aria-hidden="true" data-testid="history-skeleton">
      {[0, 1, 2].map((i) => <li key={i} className="adm-tl-row adm-tl-skel"><span className="adm-tl-ic" /><div className="adm-tl-body"><i /><i /></div></li>)}
    </ol>
  </>;
}

function HistoryError({ code, limited, onRetry }: { code?: string; limited: boolean; onRetry: () => void }) {
  return (
    <p className="adm-tl-err" role="alert" data-testid="history-error">
      {historyErrorText(code)}{' '}
      {code === 'unauthorized'
        ? <a href={loginHref()}>去登录</a>
        : <button type="button" className="adm-btn sq" disabled={limited} onClick={onRetry}>{HISTORY_TEXT.retry}</button>}
    </p>
  );
}
