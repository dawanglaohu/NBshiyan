import Link from 'next/link';
import AdminTime from '@/components/admin/AdminTime';
import {
  CURRENCIES, DIMS, INCOTERMS, LEAD_UNITS, MOQ_UNITS, SIZE_UNITS, isHttpsUrl, newCertRow,
  type FieldErrors, type SpecForm,
} from '@/lib/admin/spec-form';

const DIM_LABEL = { l: '长 L', w: '宽 W', h: '高 H' } as const;
const UNIT_LABEL: Record<string, string> = { mm: 'mm', pcs: '件 (pcs)', day: '天 (day)' };

function Err({ e, k }: { e: FieldErrors; k: string }) {
  return e[k] ? <span className="spec-err" role="alert" tabIndex={-1}>{e[k]}</span> : null;
}
function UnitSelect({ value, units, onChange, label }: { value: string; units: readonly string[]; onChange: (v: string) => void; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(ev) => onChange(ev.target.value)}>
      {units.map((u) => <option key={u} value={u}>{UNIT_LABEL[u] ?? u}</option>)}
    </select>
  );
}

export type SpecEditorViewProps = {
  category: string;
  title: string;
  form: SpecForm;
  errors: FieldErrors;
  msg?: { kind: 'ok' | 'err'; text: string };
  saving: boolean;
  updatedAt: string | null;
  errRef: React.RefObject<HTMLDivElement | null>;
  formRef?: React.Ref<HTMLFormElement>;
  onSave: (ev: React.FormEvent) => void;
  onChange: <K extends keyof SpecForm>(k: K, v: SpecForm[K]) => void;
  onDim: (which: 'sizeMin' | 'sizeMax', d: (typeof DIMS)[number], v: string) => void;
  onCert: (i: number, k: 'name' | 'certNo' | 'url', v: string) => void;
};

/** 规格表单的可见部分。样式在 SpecEditor 引入的 specs.css。 */
export function SpecEditorView({ category, title, form: f, errors, msg, saving, updatedAt, errRef, formRef, onSave, onChange, onDim, onCert }: SpecEditorViewProps) {
  const certUrlBad = (u: string) => u.trim() !== '' && !isHttpsUrl(u.trim());
  return (
    <form ref={formRef} className="spec" onSubmit={onSave} noValidate>
      <p><Link href="/admin/specs">← 全部品类</Link></p>
      <h1>产品规格：{title} <small>{category}</small></h1>
      {updatedAt && <p className="spec-meta">上次保存：<AdminTime iso={updatedAt} /></p>}
      {msg && <div ref={errRef} tabIndex={-1} className={`spec-msg ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</div>}
      {errors._ && <div className="spec-msg err" role="alert">{errors._}</div>}

      <section className="adm-card spec-sec">
        <h2>文字（英文 / 俄文）</h2>
        <table>
          <thead><tr><th>字段</th><th>English</th><th>Русский</th></tr></thead>
          <tbody>
            <tr><td>材料 material</td>
              <td><input aria-label="material en" value={f.materialEn} maxLength={300} onChange={(e) => onChange('materialEn', e.target.value)} /></td>
              <td><input aria-label="material ru" value={f.materialRu} maxLength={300} onChange={(e) => onChange('materialRu', e.target.value)} /></td></tr>
            <tr><td>备注 notes</td>
              <td><textarea aria-label="notes en" rows={3} value={f.notesEn} maxLength={2000} onChange={(e) => onChange('notesEn', e.target.value)} /></td>
              <td><textarea aria-label="notes ru" rows={3} value={f.notesRu} maxLength={2000} onChange={(e) => onChange('notesRu', e.target.value)} /></td></tr>
          </tbody>
        </table>
        <Err e={errors} k="material" /><Err e={errors} k="notes" />
      </section>

      <section className="adm-card spec-sec">
        <h2>数值（数值和单位分开填）</h2>
        <table>
          <thead><tr><th>字段</th><th>数值</th><th>单位</th></tr></thead>
          <tbody>
            {(['sizeMin', 'sizeMax'] as const).map((which) => {
              const key = which === 'sizeMin' ? 'min' : 'max';
              return (
                <tr key={which}><td>{which === 'sizeMin' ? '最小尺寸' : '最大尺寸'}</td>
                  <td>
                    <div className="spec-dims">
                      {DIMS.map((d) => (
                        <label key={d}>{DIM_LABEL[d]}<input inputMode="numeric" aria-label={`size ${key} ${d}`} value={f[which][d]} onChange={(e) => onDim(which, d, e.target.value)} /></label>
                      ))}
                    </div>
                    <Err e={errors} k={`size.${key}`} />{DIMS.map((d) => <Err key={d} e={errors} k={`size.${key}.${d}`} />)}
                  </td>
                  <td>{which === 'sizeMin' ? <UnitSelect label="size unit" value={f.sizeUnit} units={SIZE_UNITS} onChange={(v) => onChange('sizeUnit', v)} /> : <span className="spec-meta">同上</span>}</td></tr>
              );
            })}
            <tr><td>起订量 MOQ</td>
              <td><input inputMode="numeric" aria-label="moq value" value={f.moqValue} onChange={(e) => onChange('moqValue', e.target.value)} /><Err e={errors} k="moq.value" /></td>
              <td><UnitSelect label="moq unit" value={f.moqUnit} units={MOQ_UNITS} onChange={(v) => onChange('moqUnit', v)} /></td></tr>
            <tr><td>交期</td>
              <td><div className="spec-dims">
                <label>最短<input inputMode="numeric" aria-label="lead time min" value={f.leadMin} onChange={(e) => onChange('leadMin', e.target.value)} /></label>
                <label>最长<input inputMode="numeric" aria-label="lead time max" value={f.leadMax} onChange={(e) => onChange('leadMax', e.target.value)} /></label>
              </div><Err e={errors} k="leadTime.min" /><Err e={errors} k="leadTime.max" /><Err e={errors} k="leadTime" /></td>
              <td><UnitSelect label="lead time unit" value={f.leadUnit} units={LEAD_UNITS} onChange={(v) => onChange('leadUnit', v)} /></td></tr>
            <tr><td>样品费</td>
              <td>
                <div className="spec-radio" role="radiogroup" aria-label="sample fee">
                  {([['none', '不填'], ['free', '免费'], ['paid', '收费']] as const).map(([m, l]) => (
                    <label key={m}><input type="radio" name="feeMode" checked={f.feeMode === m} onChange={() => onChange('feeMode', m)} />{l}</label>
                  ))}
                </div>
                {f.feeMode === 'paid' && <input inputMode="decimal" aria-label="sample fee amount" value={f.feeAmount} onChange={(e) => onChange('feeAmount', e.target.value)} />}
                <Err e={errors} k="sampleFee.amount" /><Err e={errors} k="sampleFee" />
              </td>
              <td>{f.feeMode === 'paid' && <UnitSelect label="sample fee currency" value={f.feeCurrency} units={CURRENCIES} onChange={(v) => onChange('feeCurrency', v)} />}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="adm-card spec-sec">
        <h2>认证</h2>
        <p className="spec-meta">每条至少填证书编号或链接；链接只接受 https://。只有带 https 链接的认证会进入结构化数据。</p>
        <table>
          <thead><tr><th>名称</th><th>证书编号</th><th>链接（https）</th><th /></tr></thead>
          <tbody>
            {f.certifications.map((c, i) => (
              <tr key={c.key}>
                <td><input aria-label={`certification ${i + 1} name`} value={c.name} maxLength={80} onChange={(e) => onCert(i, 'name', e.target.value)} /><Err e={errors} k={`certifications.${i}.name`} /></td>
                <td><input aria-label={`certification ${i + 1} number`} value={c.certNo} maxLength={80} onChange={(e) => onCert(i, 'certNo', e.target.value)} /><Err e={errors} k={`certifications.${i}.certNo`} /><Err e={errors} k={`certifications.${i}`} /></td>
                <td><input type="url" aria-label={`certification ${i + 1} url`} aria-invalid={certUrlBad(c.url) || undefined} value={c.url} maxLength={2048} placeholder="https://"
                  onChange={(e) => onCert(i, 'url', e.target.value)} />
                  {certUrlBad(c.url) && !errors[`certifications.${i}.url`] && <span className="spec-err" tabIndex={-1}>链接必须以 https:// 开头，不能包含用户名或密码</span>}
                  <Err e={errors} k={`certifications.${i}.url`} /></td>
                <td><button type="button" className="adm-btn" onClick={() => onChange('certifications', f.certifications.filter((_, j) => j !== i))}>删除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="adm-btn" disabled={f.certifications.length >= 30} onClick={() => onChange('certifications', [...f.certifications, newCertRow()])}>+ 添加认证</button>
        <Err e={errors} k="certifications" />
      </section>

      <section className="adm-card spec-sec">
        <h2>贸易术语（Incoterms 2020）</h2>
        <div className="spec-terms">
          {INCOTERMS.map((t) => (
            <label key={t}><input type="checkbox" checked={f.tradeTerms.includes(t)}
              onChange={(e) => onChange('tradeTerms', e.target.checked ? [...f.tradeTerms, t] : f.tradeTerms.filter((x) => x !== t))} />{t}</label>
          ))}
        </div>
        <Err e={errors} k="tradeTerms" />
      </section>

      <div className="spec-actions"><button type="submit" className="adm-btn primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button></div>
    </form>
  );
}
