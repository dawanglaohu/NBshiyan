'use client';
// #74 邮件界面的共用小组件：正文 iframe、附件卡、flags 标签、发件人未验证提示、复制正文、倒计时、提示滚进视口。
import { useEffect, useState } from 'react';
import { mailApi, MailError, type MailAttachment } from '@/lib/admin/mail/api';
import { buildSrcdoc, clampHeight, estimateHeight, frameMax, FRAME_MIN, resizeByKey, FLAG_HINT, FLAG_LABEL, fmtSize, IFRAME_SANDBOX, knownFlags, linkExpired, REMOTE_IMAGES, fmtCountdown, rateLimitText, secondsLeft, startCountdown, typeBadge, UNVERIFIED } from '@/lib/admin/mail/logic';
import { prefersReducedMotion, scrollBehaviorFor } from '@/lib/a11y/focus';

/** 正文：服务端净化后的 HTML 放进沙箱 iframe（只有 allow-popups 两项，srcdoc 内再加 CSP）。没有 HTML 时按纯文本显示。 */
export function MailBody({ html, text, hasRemoteImages, title }: { html: string | null; text: string | null; hasRemoteImages: boolean; title: string }) {
  return (
    <>
      {hasRemoteImages && <div className="ml-banner" role="note" data-testid="remote-images">{REMOTE_IMAGES}</div>}
      {html
        ? <ResizableFrame html={html} text={text} title={title} />
        : text ? <div className="ml-text">{text}</div> : null}
    </>
  );
}

/** 正文 iframe：高度 240px–70vh，内容在 iframe 内滚动；底部把手可拖动或用方向键调整 */
export function ResizableFrame({ html, text, title }: { html: string; text: string | null; title: string }) {
  const [h, setH] = useState(() => estimateHeight(text, 630));
  const [max, setMax] = useState(630);
  useEffect(() => { const m = frameMax(); setMax(m); setH(estimateHeight(text, m)); }, [text]);
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const y0 = e.clientY, h0 = h; const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setH(clampHeight(h0 + ev.clientY - y0, frameMax()));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  return (
    <div className="ml-frame-wrap">
      <iframe className="ml-frame" title={title} sandbox={IFRAME_SANDBOX} referrerPolicy="no-referrer" srcDoc={buildSrcdoc(html)} style={{ height: h }} />
      <div className="ml-resize" role="separator" tabIndex={0} aria-orientation="horizontal" aria-label="调整正文高度"
        aria-valuemin={FRAME_MIN} aria-valuemax={max} aria-valuenow={h} onPointerDown={drag}
        onKeyDown={(e) => { const n = resizeByKey(e.key, h, frameMax()); if (n !== null) { e.preventDefault(); setH(n); } }}><span aria-hidden="true" /></div>
    </div>
  );
}

export function FlagChips({ flags }: { flags: readonly string[] }) {
  const list = knownFlags(flags);
  if (!list.length) return null;
  return <>{list.map((f) => <span key={f} className="ml-chip" title={FLAG_HINT[f]} data-flag={f}>{FLAG_LABEL[f]}</span>)}</>;
}
export function FlagBanners({ flags }: { flags: readonly string[] }) {
  return <>{knownFlags(flags).map((f) => <div key={f} className="ml-banner" role="note"><b>{FLAG_LABEL[f]}</b>：{FLAG_HINT[f]}</div>)}</>;
}
export function Unverified() { return <div className="ml-unv" role="note" data-testid="unverified">{UNVERIFIED}</div>; }

/** 附件卡：点击前已过期或下载返回 403 expired → 静默刷新该 id 一次再下载；仍失败 / 在 missing 里 → 「下载链接已失效」；410 → 「附件已删除」 */
export function AttachmentCard({ a }: { a: MailAttachment }) {
  const [link, setLink] = useState({ url: a.downloadUrl, exp: a.expiresAt });
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = (blob: Blob) => {
    const u = URL.createObjectURL(blob); const el = document.createElement('a');
    el.href = u; el.download = a.filename; el.rel = 'noopener'; document.body.appendChild(el); el.click(); el.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10_000);
  };
  const refresh = async () => {
    const r = await mailApi.refreshLinks([a.id]);
    const l = r.links.find((x) => x.id === a.id);
    if (!l) throw new MailError('missing', 0);
    setLink({ url: l.downloadUrl, exp: l.expiresAt }); return l.downloadUrl;
  };
  const go = async () => {
    setBusy(true); setMsg(undefined);
    let refreshed = false;
    try {
      let url = link.url;
      if (linkExpired(link.exp)) { url = await refresh(); refreshed = true; }
      try { save(await mailApi.download(url)); }
      catch (e) {
        if (e instanceof MailError && e.code === 'expired' && !refreshed) { refreshed = true; save(await mailApi.download(await refresh())); }
        else throw e;
      }
    } catch (e) {
      setMsg(e instanceof MailError && e.code === 'deleted' ? '附件已删除' : '下载链接已失效，请刷新页面');
    } finally { setBusy(false); }
  };
  return (
    <div className="ml-att-wrap">
      <button type="button" className="ml-att" onClick={go} disabled={busy} title={a.filename} aria-label={`下载 ${a.filename}（${fmtSize(a.size)}）`}>
        <span className="ico" aria-hidden="true">{typeBadge(a.sniffedType)}</span><span className="n">{a.filename}</span><span className="sz">{fmtSize(a.size)}</span><span className="dl">{busy ? '下载中…' : '下载'}</span>
      </button>
      {msg && <span className="ml-note" role="status">{msg}</span>}
    </div>
  );
}

export function CopyBody({ text }: { text: string | null }) {
  const [done, setDone] = useState<boolean>();
  if (!text) return null;
  return <button type="button" className="ml-btn" onClick={() => navigator.clipboard?.writeText(text).then(() => setDone(true), () => setDone(false))}>
    {done === true ? '已复制' : done === false ? '复制失败，请手动选择' : '复制正文'}</button>;
}

/** 剩余秒数（到 0 停）；until 为毫秒时间戳。计时逻辑在 logic.ts startCountdown（有假时钟单测） */
export function useCountdown(until: number | undefined) {
  const [left, setLeft] = useState(() => secondsLeft(until, Date.now()));
  useEffect(() => {
    if (!until) { setLeft(0); return; }
    return startCountdown(until, setLeft);
  }, [until]);
  return left;
}

/**
 * #74：提示出现 / 变化时滚进视口（390 手机上发送按钮下面的提示常在屏幕外）。
 * key 为 null 不滚；block:'nearest' 已在视口内就不动；减少动态效果时瞬间滚动。
 */
export function useRevealOnChange(ref: React.RefObject<HTMLElement | null>, key: string | null) {
  useEffect(() => {
    if (key === null || !ref.current) return;
    ref.current.scrollIntoView?.({ block: 'nearest', behavior: scrollBehaviorFor(prefersReducedMotion(window)) });
  }, [ref, key]);
}

/** 429 文案：倒计时插在句中原位（「00:42 后可以再发」），倒计时本身 aria-live=off，不每秒打断读屏 */
export function RateText({ scope, limit, left }: { scope?: string; limit?: number; left: number }) {
  const [before, after = ''] = rateLimitText(scope, limit, '\u0000').split('\u0000');
  return <>{before}<span aria-live="off">{fmtCountdown(left)}</span>{after}</>;
}
