'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AboutDraft } from '@/lib/admin/site-settings';
import {
  ACCEPT, IMAGES_MAX, IMAGES_TEXT as T, aboutImagesApi, addImage, fmtBytes, imageErrorText, isSmallImage, itemFromAsset, localeImageErrors, moveImage,
  precheckFile, removeImage, slotsLeft, uploadAboutImage, type AboutImageItem, type LibraryAsset,
} from '@/lib/admin/about-images';
import './about-images.css';

/**
 * #350 后台「关于我们 · 图片列表」（UX spec v1.0 §3、v1.0.7、v1.0.8；稿件 settings-desktop / settings-link-upload-error / settings-mobile）。
 * - 列表（最多 6 张，各语言共用）：缩略图、序号、左移、右移、从关于页移除；当前语言的替代文字（必填 ≤125）和说明（选填 ≤80）。
 * - 上传：显示进度、可取消；被拒时在原位置显示红框（文件名、大小、原因），429 保留文件、按 Retry-After 之后可重试。
 * - 图片库：已上传的图片（GET /assets）。可以重新加入关于页；没被关于页使用的才能删除（先确认；在用时 409 asset_in_use）。
 * 列表和文字都只改草稿，点保存条的「保存」才提交（见 saveAboutWithImages）。上传和删除是立即生效的（文件操作，不带版本号）。
 */
type Tile = { key: number; name: string; size: number; file: File | null; state: 'uploading' | 'error'; progress: number; message?: string; retryAt?: number; ctrl?: AbortController };

type Props = {
  tab: string; locales: readonly string[]; dir: 'ltr' | 'rtl';
  items: AboutImageItem[]; setItems: React.Dispatch<React.SetStateAction<AboutImageItem[]>>;
  /** 已保存的列表里的 id：这些图在关于页使用中，不能删 */
  savedIds: readonly string[];
  drafts: Record<string, AboutDraft>;
  onMeta: (id: string, field: 'alt' | 'caption', value: string) => void;
  disabled?: boolean;
};

let tileSeq = 0;

export default function AboutImages({ tab, locales, dir, items, setItems, savedIds, drafts, onMeta, disabled }: Props) {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [library, setLibrary] = useState<LibraryAsset[] | null>(null);
  const [libError, setLibError] = useState<string | null>(null);
  const [assetErr, setAssetErr] = useState<Record<string, string>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const fileRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    aboutImagesApi.listAssets().then(setLibrary).catch((e: Error) => { setLibrary([]); setLibError(imageErrorText(e.message, '图片库读取失败')); });
  }, []);
  // 429 倒计时：有等待中的重试时每秒刷新一次
  const waiting = tiles.some((t) => t.retryAt && t.retryAt > now);
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [waiting]);

  const patch = (key: number, p: Partial<Tile> | null) => setTiles((ts) => (p === null ? ts.filter((t) => t.key !== key) : ts.map((t) => (t.key === key ? { ...t, ...p } : t))));

  const start = useCallback((key: number, file: File) => {
    const ctrl = new AbortController();
    setTiles((ts) => ts.map((t) => (t.key === key ? { ...t, state: 'uploading', progress: 0, message: undefined, retryAt: undefined, ctrl } : t)));
    uploadAboutImage(file, { signal: ctrl.signal, onProgress: (p) => patch(key, { progress: p }) }).then((r) => {
      if (r.ok) {
        patch(key, null);
        setLibrary((lib) => (lib && !lib.some((a) => a.id === r.asset.id) ? [r.asset, ...lib] : lib));
        // 200 deduplicated：同一张图传过，后端复用已有记录；已经在列表里就不重复加
        setNotice(r.deduplicated && itemsRef.current.some((x) => x.id === r.asset.id) ? T.duplicate : null);
        setItems((prev) => addImage(prev, itemFromAsset(r.asset)));
        return;
      }
      if (r.code === 'aborted') { patch(key, null); return; }
      // 429：保留已选的文件，Retry-After 之后才能重试；其他错误不保留文件（换一张再传）
      patch(key, { state: 'error', message: r.message, ctrl: undefined, ...(r.code === 'rate_limited' ? { retryAt: Date.now() + (r.retryAfterMs ?? 60_000) } : { file: null }) });
      setNow(Date.now());
    });
  }, [setItems]);

  const uploading = tiles.filter((t) => t.state === 'uploading' || t.file).length;
  const left = slotsLeft(items, uploading);

  const onFiles = (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (fileRef.current) fileRef.current.value = '';
    if (!files.length) return;
    setNotice(files.length > left ? `最多 ${IMAGES_MAX} 张，这次只上传前 ${left} 张。` : null);
    const next: Tile[] = [];
    for (const f of files.slice(0, left)) {
      const key = ++tileSeq;
      const pre = precheckFile(f);
      next.push({ key, name: f.name, size: f.size, file: pre ? null : f, state: pre ? 'error' : 'uploading', progress: 0, ...(pre ? { message: imageErrorText(pre) } : {}) });
    }
    setTiles((ts) => [...ts, ...next]);
    for (const t of next) if (t.file) start(t.key, t.file);
  };

  const askDelete = (id: string) => {
    setAssetErr((m) => { const n = { ...m }; delete n[id]; return n; });
    // 关于页（已保存的列表）正在用：不发请求，直接说明（服务端同样会 409 asset_in_use）
    if (savedIds.includes(id)) { setAssetErr((m) => ({ ...m, [id]: imageErrorText('asset_in_use') })); return; }
    setConfirmId(id);
  };
  const doDelete = async () => {
    const id = confirmId;
    setConfirmId(null);
    if (!id) return;
    const r = await aboutImagesApi.deleteAsset(id);
    if (r.ok || r.code === 'not_found') {
      setLibrary((lib) => (lib ?? []).filter((a) => a.id !== id));
      setItems((prev) => removeImage(prev, id)); // 草稿里加过但还没保存的，也一起去掉
      if (!r.ok) setNotice(imageErrorText('not_found'));
      return;
    }
    setAssetErr((m) => ({ ...m, [id]: imageErrorText(r.code, '删除失败') }));
  };

  const errs = localeImageErrors(drafts[tab], items.map((i) => i.id));
  const others = locales.filter((l) => l !== tab).map((l) => [l, localeImageErrors(drafts[l], items.map((i) => i.id)).missing.length] as const).filter(([, n]) => n > 0);
  const meta = drafts[tab]?.imageMeta ?? {};
  const inList = new Set(items.map((i) => i.id));

  return (
    <div className="st-f st-im">
      <div className="st-lab"><span id="st-im-l">{T.label}</span><span className="st-count">{items.length} / {IMAGES_MAX}</span></div>
      <div className="st-im-grid" role="list" aria-labelledby="st-im-l">
        {items.map((it, i) => {
          const n = i + 1; const id = `st-im-${it.id}`;
          const altE = errs.alt[it.id]; const capE = errs.caption[it.id]; const small = isSmallImage(it.lg);
          return (
            <div key={it.id} role="listitem" className={`st-im-card${altE ? ' bad' : ''}`}>
              <div className="th">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={it.src.sm} width={it.sm.w} height={it.sm.h} alt="" loading="lazy" decoding="async" />
                <span className="n" aria-hidden="true">{n}</span>
              </div>
              <div className="bd">
                <label htmlFor={`${id}-alt`}>{T.alt(tab)}<b aria-hidden="true"> *</b><span className="sr-only">（第 {n} 张）</span></label>
                <input id={`${id}-alt`} type="text" dir={dir} value={meta[it.id]?.alt ?? ''} placeholder={T.altPlaceholder} aria-required="true"
                  aria-invalid={altE ? true : undefined} aria-describedby={altE ? `${id}-alt-e` : undefined} onChange={(e) => onMeta(it.id, 'alt', e.target.value)} />
                {altE && <p id={`${id}-alt-e`} className="st-ferr">{altE}</p>}
                <label htmlFor={`${id}-cap`}>{T.caption}<span className="sr-only">（第 {n} 张）</span></label>
                <input id={`${id}-cap`} type="text" dir={dir} value={meta[it.id]?.caption ?? ''} placeholder={T.captionPlaceholder}
                  aria-invalid={capE ? true : undefined} aria-describedby={capE ? `${id}-cap-e` : undefined} onChange={(e) => onMeta(it.id, 'caption', e.target.value)} />
                {capE && <p id={`${id}-cap-e`} className="st-ferr">{capE}</p>}
                {small && <p className="st-warn st-im-small">{T.small}</p>}
                <div className="acts">
                  <button type="button" className="st-im-ico" aria-label={`${T.left}第 ${n} 张`} title={T.left} disabled={disabled || i === 0} onClick={() => setItems((p) => moveImage(p, i, -1))}>←</button>
                  <button type="button" className="st-im-ico" aria-label={`${T.right}第 ${n} 张`} title={T.right} disabled={disabled || i === items.length - 1} onClick={() => setItems((p) => moveImage(p, i, 1))}>→</button>
                  <span className="sp" />
                  <button type="button" className="st-im-ico" aria-label={`${T.remove}（第 ${n} 张）`} title={T.remove} disabled={disabled} onClick={() => setItems((p) => removeImage(p, it.id))}><span aria-hidden="true">🗑</span></button>
                </div>
              </div>
            </div>
          );
        })}
        {tiles.map((t) => (t.state === 'uploading' ? (
          <div key={t.key} role="listitem" className="st-im-up" aria-busy="true">
            <b role="status">{T.uploading(t.progress)}</b>
            <div className="bar" role="progressbar" aria-label={`上传 ${t.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={t.progress}><i style={{ width: `${t.progress}%` }} /></div>
            <span className="nm">{t.name} · {fmtBytes(t.size)}</span>
            <button type="button" className="adm-btn" onClick={() => t.ctrl?.abort()}>{T.cancel}</button>
          </div>
        ) : (
          <div key={t.key} role="listitem" className="st-im-up bad">
            <div role="alert">
              <b>{T.notUploaded}</b>
              <span className="nm">{t.name} · {fmtBytes(t.size)}</span>
              <span>{t.message}</span>
            </div>
            <div className="btns">
              {t.file && (
                <button type="button" className="adm-btn" disabled={!!t.retryAt && t.retryAt > now} onClick={() => t.file && start(t.key, t.file)}>
                  {t.retryAt && t.retryAt > now ? T.retryIn(Math.ceil((t.retryAt - now) / 1000)) : T.retry}
                </button>
              )}
              <button type="button" className="adm-btn" onClick={() => patch(t.key, null)}>{T.dismiss}</button>
            </div>
          </div>
        )))}
        {left > 0 ? (
          <label role="listitem" className={`st-im-up add${disabled ? ' off' : ''}`}>
            <input ref={fileRef} type="file" accept={ACCEPT} multiple className="st-im-file" disabled={disabled} onChange={(e) => onFiles(e.target.files)} />
            <b>{T.add}</b>
            <span>{T.addRule}</span>
            <span>{T.addRule2(left)}</span>
          </label>
        ) : (
          <div role="listitem" className="st-im-up full"><b>{T.full}</b></div>
        )}
      </div>
      {notice && <p className="st-hint" role="status">{notice}</p>}
      {errs.missing.length > 0 && <p className="st-ferr" role="alert">{T.missingSummary(errs.missing.length)}</p>}
      {others.map(([l, n]) => <p key={l} className="st-ferr">{T.missingOther(l, n)}</p>)}

      <details className="st-im-lib">
        <summary>{T.library(library?.length ?? 0)}</summary>
        <p className="st-hint">{T.libraryHint}</p>
        {libError && <p className="st-ferr" role="alert">{libError}</p>}
        {library && library.length === 0 && !libError && <p className="st-hint">{T.libraryEmpty}</p>}
        <ul className="st-im-libl">
          {(library ?? []).map((a) => {
            const used = savedIds.includes(a.id);
            return (
              <li key={a.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.sm.url} width={a.sm.width} height={a.sm.height} alt="" loading="lazy" decoding="async" />
                <div className="meta">
                  <span>{a.lg.width}×{a.lg.height} · {fmtBytes(a.lg.bytes)}</span>
                  {used && <span className="chip">{T.libraryInUse}</span>}
                  {isSmallImage({ w: a.lg.width, h: a.lg.height }) && <span className="st-warn">{T.small}</span>}
                  {assetErr[a.id] && <span className="st-ferr" role="alert">{assetErr[a.id]}</span>}
                </div>
                <div className="btns">
                  <button type="button" className="adm-btn" disabled={disabled || inList.has(a.id) || items.length >= IMAGES_MAX} onClick={() => setItems((p) => addImage(p, itemFromAsset(a)))}>
                    {inList.has(a.id) ? T.libraryAdded : T.libraryAdd}
                  </button>
                  <button type="button" className="adm-btn st-im-del" disabled={disabled} onClick={() => askDelete(a.id)}>{T.delete}</button>
                </div>
              </li>
            );
          })}
        </ul>
      </details>

      {confirmId && <DeleteDialog onCancel={() => setConfirmId(null)} onConfirm={doDelete} />}
    </div>
  );
}

/** 删除确认（role=alertdialog，Esc / 取消退出，打开时焦点在「取消」；样式沿用 settings.css 的 .st-dialog） */
function DeleteDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('keydown', k); prev?.focus(); };
  }, [onCancel]);
  return (
    <div className="st-mask">
      <div className="st-dialog" role="alertdialog" aria-modal="true" aria-labelledby="st-im-dlg-h" aria-describedby="st-im-dlg-b">
        <h2 id="st-im-dlg-h">{T.deleteTitle}</h2>
        <p id="st-im-dlg-b">{T.deleteBody}</p>
        <div className="st-dlg-btns">
          <button ref={cancelRef} type="button" className="adm-btn" onClick={onCancel}>{T.cancel}</button>
          <button type="button" className="adm-btn primary danger" onClick={onConfirm}>{T.delete}</button>
        </div>
      </div>
    </div>
  );
}
