'use client';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LOGO_TYPES, LogoError, precheckLogo, uploadLogo, type LogoErrorCode, type LogoUpload } from '@/lib/client/logoUpload';

/** 询价向导里的 Logo 上传：PNG/JPEG/WebP ≤ 2MB；上传成功后父组件拿到 uploadId，提交询盘时一起发送 */
export default function LogoUploadField({ id, value, onChange, notice }: { id: string; value: LogoUpload | null; onChange: (v: LogoUpload | null) => void; notice?: string }) {
  const t = useTranslations('Inquiry.logo');
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LogoErrorCode | null>(null);
  const [name, setName] = useState('');
  const [pending, setPending] = useState('');
  const [preview, setPreview] = useState<string>();
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => { if (!value) { setName(''); setPreview(undefined); } }, [value]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    const pre = precheckLogo(file);
    if (pre) { setError(pre); if (input.current) input.current.value = ''; return; }
    setBusy(true); setPending(file.name);
    try {
      const up = await uploadLogo(file);
      setName(file.name);
      setPreview(URL.createObjectURL(file));
      onChange(up);
    } catch (e) {
      setError(e instanceof LogoError ? e.code : 'server');
      onChange(null);
    } finally {
      setBusy(false); setPending('');
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="field logo-field">
      <label htmlFor={id}>{t('label')}</label>
      {value ? (
        <div className="logo-chosen">
          {/* eslint-disable-next-line @next/next/no-img-element -- 本地 blob 预览，不走图片优化 */}
          {preview && <img src={preview} alt="" width={48} height={48} style={{ objectFit: 'contain', borderRadius: 6, background: '#fff', border: '1px solid var(--line)' }} />}
          <span>{name || t('uploaded')} · {value.width}×{value.height}</span>
          <button type="button" className="btn ghost sm" onClick={() => { onChange(null); setError(null); }}>{t('remove')}</button>
        </div>
      ) : (
        // 原生控件视觉隐藏，用站内胶囊按钮（label）代替，文案跟随语言（#119）；input 本身仍可 Tab 聚焦、空格/回车打开选择框
        <div className="file-pick">
          <input ref={input} id={id} className="sr-only" type="file" accept={LOGO_TYPES.join(',')} disabled={busy} aria-describedby={`${id}-file ${id}-hint ${id}-err`}
            onChange={(e) => pick(e.target.files?.[0])} />
          <label htmlFor={id} className="btn ghost sm" aria-hidden="true">{t('choose')}</label>
          <span id={`${id}-file`} className="file-name">{pending || t('none')}</span>
        </div>
      )}
      <p id={`${id}-hint`} className="hint" style={{ fontSize: 13, opacity: 0.75, margin: '6px 0 0' }}>{busy ? t('uploading') : t('hint')}</p>
      <p id={`${id}-err`} role="alert" style={{ color: 'var(--accent-press)', fontSize: 13, margin: error || notice ? '6px 0 0' : 0 }}>
        {error ? t(`errors.${error}`) : notice ?? ''}
      </p>
    </div>
  );
}
