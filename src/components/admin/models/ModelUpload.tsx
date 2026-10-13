'use client';
import '@/components/admin/models/models.css';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CHECK_LABEL, LIMITS, ModelApiError, blockingChecks, modelApi, readGlbJson, sizeFailed, type AdminModel } from '@/lib/admin/models-api';
import { PRODUCT_LABEL } from '@/components/admin/format';

const ModelPreview = dynamic(() => import('./ModelPreview'), { ssr: false });
const STEPS = ['上传', '处理与检查', '预览确认', '上架'] as const;
const fmt = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)}MB` : `${Math.round(b / 1024)}KB`);
const API_ERR: Record<string, string> = {
  too_large: '文件超过上限（主 GLB ≤1.5MB、高精度层 ≤1MB、封面 ≤512KB）', unsupported_type: '不是有效的 GLB 文件', not_ready: '检查未全部通过，不能上架',
  forbidden_origin: '请求被拒绝：来源校验失败，请刷新页面后重试', unauthorized: '登录已过期，请重新登录', forbidden: '没有权限（需要 ADMIN 或 EDITOR 角色）', rate_limited: '操作太频繁，请稍后再试'
};
const errText = (e: unknown) => (e instanceof ModelApiError ? API_ERR[e.code] ?? `操作失败：${e.code}` : `操作失败：${String((e as Error)?.message ?? e)}`);

type Files = { glb?: File; lod?: File; poster?: File };

export default function ModelUpload() {
  const [step, setStep] = useState(0);
  const [files, setFiles] = useState<Files>({});
  const [needsLod, setNeedsLod] = useState(false);
  const [slug, setSlug] = useState('wine-boxes');
  const [animated, setAnimated] = useState(false);
  const [model, setModel] = useState<AdminModel>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark' | 'mobile'>('light');
  const [glbUrl, setGlbUrl] = useState<string>();
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [replaced, setReplaced] = useState<string[]>();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!files.glb) { setGlbUrl(undefined); return; } const u = URL.createObjectURL(files.glb); setGlbUrl(u); return () => URL.revokeObjectURL(u); }, [files.glb]);

  async function pick(list: FileList | null) {
    setErr(undefined);
    const next = { ...files }; const problems: string[] = [];
    for (const f of Array.from(list ?? [])) {
      if (/\.lod0\.glb$/i.test(f.name)) { if (f.size > LIMITS.lod) problems.push(`${f.name} 超过 1MB`); else next.lod = f; }
      else if (/\.glb$/i.test(f.name)) {
        if (f.size > LIMITS.glb) { problems.push(`${f.name} 为 ${fmt(f.size)}，超过 1.5MB 上传上限。请先在本地压缩（Draco/meshopt + KTX2），或联系 3D 组处理`); continue; }
        const g = await readGlbJson(f);
        if (!g.ok) { problems.push(`${f.name} 不是 glTF 2.0 GLB`); continue; }
        next.glb = f; setNeedsLod(!!g.json?.extensionsUsed?.includes('NEEDLE_progressive'));
        if (g.json?.animations?.some((a) => a.name === 'Open')) setAnimated(true);
      } else if (/^image\/(png|jpeg|webp)$/.test(f.type)) { if (f.size > LIMITS.poster) problems.push(`封面 ${f.name} 超过 512KB`); else next.poster = f; }
      else problems.push(`不支持的文件：${f.name}（只收 .glb、.lod0.glb 和 PNG/JPEG/WebP 封面）`);
    }
    setFiles(next); if (problems.length) setErr(problems.join('；'));
    if (input.current) input.current.value = '';
  }
  async function upload() {
    if (!files.glb) return;
    setBusy(true); setErr(undefined);
    try {
      setStep(1);
      setModel(await modelApi.upload({ file: files.glb, lod: files.lod, poster: files.poster, productSlug: slug, category: slug, animated }));
    } catch (e) { setErr(errText(e)); setStep(0); } finally { setBusy(false); }
  }
  const act = async (fn: () => Promise<AdminModel>) => {
    setBusy(true); setErr(undefined);
    try { setModel(await fn()); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const reupload = () => { setModel(undefined); setFiles({}); setStep(0); setReplaced(undefined); setTimeout(() => input.current?.click(), 0); };
  const publish = async () => {
    if (!model) return; setBusy(true); setErr(undefined);
    try { const r = await modelApi.publish(model.id, true); setModel(r.model); setReplaced(r.replaced); setConfirmPublish(false); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  const blocking = model ? blockingChecks(model) : [];
  const warns = model ? model.checks.filter((c) => !c.ok && c.severity === 'warn') : [];
  const nextReason = !model ? '请先上传文件' : model.status === 'PROCESSING' ? '检查进行中' : blocking.length ? `检查未通过：${blocking.map((c) => CHECK_LABEL[c.key]).join('、')}` : undefined;
  const missingLod = needsLod && !files.lod;
  const doneUpTo = model?.published ? 4 : step;

  return (
    <div className="mdl">
      <div className="adm-crumb"><Link href="/admin/models">3D 模型</Link> / 新建</div>
      <div className="adm-hd"><h1>上传新模型</h1><span className="sp" /><Link className="adm-btn sq" href="/admin/inquiries">取消</Link></div>

      <ol className="mdl-steps" aria-label="上传进度">
        {STEPS.map((s, i) => (
          <li key={s} className={i < doneUpTo ? 'done' : i === step ? 'cur' : ''} aria-current={i === step ? 'step' : undefined}><i>{i < doneUpTo ? '✓' : i + 1}</i>{s}</li>))}
      </ol>
      {err && <p className="warn" role="alert">{err}</p>}

      <div className="adm-g2">
        <div>
          <section className="adm-sec">
            <h2>文件</h2>
            <label className="mdl-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (step === 0) void pick(e.dataTransfer.files); }}>
              <input ref={input} type="file" accept=".glb,model/gltf-binary,image/png,image/jpeg,image/webp" multiple hidden disabled={step > 0} onChange={(e) => void pick(e.target.files)} />
              {files.glb ? (
                <span>✓ <b>{files.glb.name}</b> {fmt(files.glb.size)}
                  {files.lod ? <> · 高精度层 <b>{files.lod.name}</b> {fmt(files.lod.size)}</> : null}
                  {files.poster ? <> · 封面 <b>{files.poster.name}</b> {fmt(files.poster.size)}</> : null}</span>
              ) : <span>拖入或点击选择：已压缩的 <b>.glb</b>（≤1.5MB），可附高精度层 <b>.lod0.glb</b> 和封面图</span>}
              <small className="muted">{step === 0 ? '服务端不做压缩：请上传已用 Draco/meshopt + KTX2 处理好的文件 · 拖入新文件可替换' : '已上传；要更换文件请点“重新上传”'}</small>
            </label>
            {missingLod && step === 0 && <p className="warn" style={{ fontSize: 13 }}>主文件声明了 NEEDLE_progressive，需要一起上传对应的 .lod0.glb。</p>}
            {step === 0 && (
              <div className="adm-row" style={{ marginTop: 10 }}>
                <label className="muted">产品 <select value={slug} onChange={(e) => setSlug(e.target.value)}>{Object.entries(PRODUCT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                <label className="muted adm-row"><input type="checkbox" checked={animated} onChange={(e) => setAnimated(e.target.checked)} /> 带开盒 / 刀模动画（体积上限 1.5MB）</label>
                <span style={{ flex: 1 }} />
                <button type="button" className="adm-btn primary sq" disabled={!files.glb || missingLod || busy} onClick={upload}>{busy ? '上传中…' : '上传并检查'}</button>
              </div>)}
          </section>

          {(model || (step === 1 && busy)) && (
            <section className="adm-sec">
              <h2>处理结果 <span className="muted">{!model ? '检查中…' : model.status === 'READY' ? (warns.length ? `通过（${warns.length} 条提示）` : '全部通过') : model.status === 'FAILED' ? '有未通过项' : '检查中…'}</span></h2>
              {model && (
                <ul className="mdl-checks">
                  {model.checks.map((c) => {
                    const state = c.ok ? 'ok' : c.severity === 'warn' ? 'warn' : 'fail';
                    return (
                      <li key={c.key} className={state}>
                        <i aria-hidden>{state === 'ok' ? '✓' : state === 'warn' ? '!' : '✕'}</i>
                        <b>{CHECK_LABEL[c.key] ?? c.key}</b>
                        <span>{c.detail}{state === 'warn' ? '（仅提示）' : ''}</span>
                        {c.key === 'size' && <span className="mdl-bar"><span style={{ width: `${Math.min(100, (model.sizeBytes / (model.animated ? LIMITS.sizeAnimated : LIMITS.sizeNormal)) * 100)}%` }} className={c.ok ? 'ok' : 'fail'} /></span>}
                      </li>);
                  })}
                </ul>)}
              {model && sizeFailed(model) && (
                <div className="mdl-remedy" role="alert">
                  <b>体积超出上限。</b>服务端不做压缩，可以：
                  <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
                    <li>在本地压缩后重新上传：降低贴图分辨率、转 KTX2、几何用 Draco 或 meshopt（如 <code>gltf-transform optimize</code>）；或联系 3D 组处理。</li>
                    <li>如果这个模型带开盒 / 刀模动画（含 <code>Open</code> 片段），标记为“带动画”，上限放宽到 1.5MB。</li>
                  </ol>
                  <div className="adm-row" style={{ marginTop: 8 }}>
                    <button type="button" className="adm-btn sq" disabled={busy || model.animated} onClick={() => act(() => modelApi.update(model.id, { animated: true }))}>{model.animated ? '已标记带动画' : '标记为带动画'}</button>
                    <button type="button" className="adm-btn sq" onClick={reupload}>重新上传</button>
                  </div>
                </div>)}
              {model && model.status === 'FAILED' && !sizeFailed(model) && (
                <div className="adm-row" style={{ marginTop: 8 }}>
                  <button type="button" className="adm-btn sq" onClick={reupload}>重新上传</button>
                  <button type="button" className="adm-btn sq" disabled={busy} onClick={() => act(() => modelApi.recheck(model.id))}>重新检查</button>
                </div>)}
            </section>)}
        </div>

        <aside>
          <section className="adm-sec">
            <h2>预览 <span className="muted">复用前台解码器</span></h2>
            <div className="adm-tabs" role="group" aria-label="预览主题">
              {([['light', '前台'], ['dark', '礼盒深色'], ['mobile', '手机']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={theme === k} onClick={() => setTheme(k)}>{l}</button>)}
            </div>
            <div className={`mdl-preview ${theme}`}>
              {glbUrl ? <ModelPreview url={glbUrl} dark={theme === 'dark'} /> : <p className="muted">选好文件后显示 3D 预览</p>}
            </div>
            {model && (
              <div className="mdl-form">
                <label>产品<select value={model.productSlug} disabled={busy} onChange={(e) => act(() => modelApi.update(model.id, { productSlug: e.target.value, category: e.target.value }))}>{Object.entries(PRODUCT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                <label>排序<input type="number" min={0} value={model.sortOrder} onChange={(e) => setModel({ ...model, sortOrder: Number(e.target.value) })} onBlur={() => act(() => modelApi.update(model.id, { sortOrder: model.sortOrder }))} /></label>
                <label>动画<span>{model.animations?.length ? model.animations.join('、') : '无'} · {model.animated ? '带动画（上限 1.5MB）' : '普通（上限 1MB）'}</span></label>
                <label>文件<span>{fmt(model.sizeBytes)} · {model.hasLod ? '有高精度层' : '无高精度层'} · {model.hasPoster ? '有封面' : '无封面'}</span></label>
              </div>)}
            <div className="adm-row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              {step < 3 ? (
                // 有 error 级未通过项时保持禁用，悬停提示原因（禁用按钮本身不触发悬停，外层 span 承载 title）
                <span title={nextReason} className="mdl-tip">
                  <button type="button" className="adm-btn primary sq" aria-describedby="mdl-next-why" disabled={!!nextReason || busy} onClick={() => setStep(step < 2 ? 2 : 3)}>
                    {step < 2 ? '下一步：预览确认' : '下一步：确认上架'}
                  </button>
                </span>
              ) : model?.published ? <span className="badge WON">已上架</span>
                : confirmPublish ? (<><span className="muted">上架后会自动下架该产品的旧版本，确认？</span>
                    <button type="button" className="adm-btn sq" onClick={() => setConfirmPublish(false)}>取消</button>
                    <button type="button" className="adm-btn primary sq" disabled={busy} onClick={publish}>确认上架</button></>)
                : <><span className="muted">未上架（草稿）</span><button type="button" className="adm-btn primary sq" onClick={() => setConfirmPublish(true)}>上架</button></>}
            </div>
            {nextReason && step < 3 && <p id="mdl-next-why" className="muted" style={{ fontSize: 12, marginTop: 6 }}>无法继续：{nextReason}</p>}
            {replaced && replaced.length > 0 && <p className="muted" style={{ fontSize: 12 }}>已自动下架旧版本：{replaced.join('、')}</p>}
            <p className="muted" style={{ fontSize: 12 }}>未上架的模型保存为草稿。下架、删除需二次确认；所有操作写入操作日志。</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
