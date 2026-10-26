'use client';
import './specs.css';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { commitAndReveal } from '@/components/admin/reveal-error';
import { revealFirstSpecError } from '@/components/admin/specs/reveal-spec-error';
import { SpecEditorView } from '@/components/admin/specs/SpecEditorView';
import {
  DIMS, emptyForm, fromView, serverErrors, specSaveErrors, toBody,
  type FieldErrors, type SpecForm, type SpecView,
} from '@/lib/admin/spec-form';

/** 品类规格编辑：GET 读取，保存时客户端校验后 PUT；服务端错误按字段显示 */
export default function SpecEditor({ category, title }: { category: string; title: string }) {
  const url = `/api/admin/specs/${encodeURIComponent(category)}`;
  const [f, setF] = useState<SpecForm>(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const errRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let live = true;
    fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) {
          if (live) commitAndReveal(errRef, () => { setMsg({ kind: 'err', text: serverErrors(r.status, j).message }); setLoading(false); });
          return;
        }
        setF(fromView(j as SpecView)); setUpdatedAt((j as SpecView).updatedAt ?? null);
      })
      .catch(() => { if (live) commitAndReveal(errRef, () => { setMsg({ kind: 'err', text: '加载失败，请检查网络后刷新' }); setLoading(false); }); })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [url]);

  const set = <K extends keyof SpecForm>(k: K, v: SpecForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const setDim = (which: 'sizeMin' | 'sizeMax', d: (typeof DIMS)[number], v: string) => setF((p) => ({ ...p, [which]: { ...p[which], [d]: v } }));
  const setCert = (i: number, k: 'name' | 'certNo' | 'url', v: string) => setF((p) => ({ ...p, certifications: p.certifications.map((c, j) => (j === i ? { ...c, [k]: v } : c)) }));

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    setMsg(undefined);
    const { body, errors: e } = toBody(f);
    setErrors(e);
    if (!body) { commitAndReveal(errRef, () => setMsg({ kind: 'err', text: '请先修正标红的字段' })); return; }
    setSaving(true);
    try {
      const r = await fetch(url, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const s = specSaveErrors(r.status, j);
        // 已映射到字段时不画顶部句（同一句话不能出现两次）。先把字段错误提交进 DOM，再滚到并聚焦第一个。
        if (s.top) {
          setErrors(s.fields);
          commitAndReveal(errRef, () => setMsg({ kind: 'err', text: s.top }));
        } else {
          flushSync(() => { setErrors(s.fields); setMsg(undefined); });
          revealFirstSpecError(formRef.current);
        }
        return;
      }
      setF(fromView(j as SpecView)); setUpdatedAt((j as SpecView).updatedAt ?? null); setErrors({});
      setMsg({ kind: 'ok', text: '已保存。前台接口有 CDN 缓存，通常 1 小时内生效（最长约 70 分钟）。' });
    } catch {
      commitAndReveal(errRef, () => setMsg({ kind: 'err', text: '保存失败，请检查网络后重试' }));
    } finally { setSaving(false); }
  }

  if (loading) return <p>加载中…</p>;
  return (
    <SpecEditorView
      category={category} title={title} form={f} errors={errors} msg={msg} saving={saving} updatedAt={updatedAt} errRef={errRef} formRef={formRef}
      onSave={save} onChange={set} onDim={setDim} onCert={setCert}
    />
  );
}
