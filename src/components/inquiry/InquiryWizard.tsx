'use client';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { products } from '@/data/products';
import { useQuote } from '@/components/quote/QuoteProvider';
import LogoUploadField from './LogoUploadField';
import { LOGO_TTL_MS, type LogoUpload } from '@/lib/client/logoUpload';

const QTY = [{ k: '1k', v: 1000 }, { k: '5k', v: 5000 }, { k: '10k', v: 10000 }, { k: '50k', v: 50000 }, { k: 'unsure', v: undefined }] as const;
const MATERIALS = ['corrugated', 'paperboard', 'kraft', 'pulp', 'unsure'] as const;
const TIMELINES = ['2w', '1m', '2m', 'unsure'] as const;
const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'PL', 'RU', 'KZ', 'BY', 'UZ', 'AE', 'SA', 'AU', 'CA', 'ZZ'] as const;
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

const RETRYABLE = new Set(['retry', 'network']);
type Result = { ok: true; ref: string } | { ok: false; code: string };

export default function InquiryWizard() {
  const t = useTranslations('Inquiry');
  const names = useTranslations('Products.names');
  const locale = useLocale();
  const quote = useQuote();
  const [step, setStep] = useState(0);
  const [fromQuote, setFromQuote] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [qty, setQty] = useState<string>('unsure');
  const [size, setSize] = useState('');
  const [material, setMaterial] = useState<string>('unsure');
  const [timeline, setTimeline] = useState<string>('unsure');
  const [message, setMessage] = useState('');
  // 第 3 步的联系方式放在 state 里，返回上一步再回来时不会被清空（#98）
  const [contact, setContact] = useState({ name: '', email: '', company: '', phone: '', region: locale === 'ru' ? 'RU' : '', consent: false });
  const setC = (k: 'name' | 'email' | 'company' | 'phone' | 'region') => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { const v = e.target.value; setContact((c) => ({ ...c, [k]: v })); };
  // Logo 先单独上传拿 uploadId（1 小时有效），提交询盘时作为 logoUploadId 绑定；人机校验只在最后提交时做一次
  const [logo, setLogo] = useState<LogoUpload | null>(null);
  const [logoNotice, setLogoNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);
  const prefilled = useRef(false);

  // 从询价清单进来时预填产品
  useEffect(() => {
    setFromQuote(new URLSearchParams(window.location.search).get('from') === 'quote');
  }, []);
  useEffect(() => {
    if (!prefilled.current && quote.items.length) {
      prefilled.current = true;
      setSelected(quote.items.map((i) => i.slug));
    }
  }, [quote.items]);

  // Turnstile 只在配置了站点密钥时加载（CSP 已放行 challenges.cloudflare.com）
  useEffect(() => {
    if (!SITE_KEY || step !== 2 || document.getElementById('cf-turnstile-js')) return;
    const s = document.createElement('script');
    s.id = 'cf-turnstile-js';
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async = true;
    document.head.appendChild(s);
  }, [step]);

  const toggle = (slug: string) => setSelected((p) => (p.includes(slug) ? p.filter((s) => s !== slug) : [...p, slug]));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step < 2) { setStep(step + 1); return; }
    const fd = new FormData(e.currentTarget);
    const quantity = QTY.find((q) => q.k === qty)?.v;
    const config: Record<string, string> = {};
    if (size.trim()) config.size = size.trim().slice(0, 200);
    if (material !== 'unsure') config.material = material;
    if (timeline !== 'unsure') config.timeline = timeline;
    // uploadId 快过期时不再发送，提示重新上传（服务端会以 logo_invalid 拒绝整条询盘）
    if (logo && Date.now() - logo.uploadedAt > LOGO_TTL_MS) {
      setLogo(null); setLogoNotice(t('logo.expired')); setResult({ ok: false, code: 'logo_invalid' }); return;
    }
    const opt = (k: string) => { const v = String(fd.get(k) ?? '').trim(); return v || undefined; };
    const c = (v: string) => v.trim() || undefined;
    const body = {
      source: fromQuote ? 'CART' : 'WIZARD',
      locale,
      contact: { name: c(contact.name), email: c(contact.email), company: c(contact.company), phone: c(contact.phone), region: c(contact.region) },
      message: message.trim() || undefined,
      items: selected.slice(0, 20).map((productSlug) => ({ productSlug, ...(quantity ? { quantity } : {}), ...(Object.keys(config).length ? { config } : {}) })),
      attribution: { page: window.location.pathname },
      website: String(fd.get('website') ?? ''),
      turnstileToken: opt('cf-turnstile-response'),
      ...(logo ? { logoUploadId: logo.uploadId } : {})
    };
    setBusy(true); setResult(null);
    try {
      const res = await fetch('/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 201) {
        const data = await res.json().catch(() => ({}));
        setResult({ ok: true, ref: String(data.ref ?? '') });
        if (fromQuote) quote.clear();
      } else {
        const errBody = res.status === 422 ? await res.json().catch(() => ({})) as { error?: string } : {};
        if (errBody.error === 'logo_invalid') { setLogo(null); setLogoNotice(t('logo.expired')); setResult({ ok: false, code: 'logo_invalid' }); return; }
        const code = res.status === 404 ? 'unavailable' : res.status === 429 ? 'rate' : res.status === 400 ? 'invalid' : res.status === 403 ? 'captcha' : res.status === 503 ? 'retry' : 'server';
        if (res.status === 503) {
          const ra = Number(res.headers.get('Retry-After'));
          setWait(Number.isFinite(ra) && ra > 0 ? Math.min(Math.round(ra), 120) : 0);
        }
        setResult({ ok: false, code });
      }
    } catch {
      setResult({ ok: false, code: 'network' });
    } finally {
      setBusy(false);
      // Turnstile 令牌只能用一次：失败后刷新，方便直接重试
      (window as unknown as { turnstile?: { reset: () => void } }).turnstile?.reset();
    }
  }

  if (result?.ok) {
    return (
      <div className="wizard" role="status">
        <h2 style={{ marginTop: 0 }}>{t('success.title')}</h2>
        <p>{t('success.ref')} <strong>{result.ref}</strong></p>
        <p>{t('success.reply')}</p>
      </div>
    );
  }

  const chips = (name: string, options: readonly string[], value: string, set: (v: string) => void, label: (k: string) => string) => (
    <div className="chips">
      {options.map((o) => (
        <label key={o}><input type="radio" name={name} value={o} checked={value === o} onChange={() => set(o)} />{label(o)}</label>
      ))}
    </div>
  );

  return (
    <form ref={formRef} className="wizard" onSubmit={submit} noValidate={step < 2}>
      <div className="steps" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className={i <= step ? 'on' : ''} />)}</div>
      <p style={{ color: 'var(--ink-2)', marginTop: 0 }}>{t('stepOf', { n: step + 1, total: 3 })} · {t(`steps.${step}`)}</p>

      {step === 0 && (
        <>
          <fieldset className="field">
            <legend>{t('products')}</legend>
            <div className="chips">
              {products.map((p) => (
                <label key={p.slug}><input type="checkbox" checked={selected.includes(p.slug)} onChange={() => toggle(p.slug)} />{names(p.slug)}</label>
              ))}
            </div>
          </fieldset>
          <fieldset className="field"><legend>{t('quantity')}</legend>{chips('qty', QTY.map((q) => q.k), qty, setQty, (k) => t(`qty.${k}`))}</fieldset>
        </>
      )}

      {step === 1 && (
        <>
          <div className="field"><label htmlFor="iq-size">{t('size')}</label><input id="iq-size" value={size} maxLength={200} placeholder={t('sizePh')} onChange={(e) => setSize(e.target.value)} /></div>
          <fieldset className="field"><legend>{t('material')}</legend>{chips('material', MATERIALS, material, setMaterial, (k) => t(`materials.${k}`))}</fieldset>
          <fieldset className="field"><legend>{t('timeline')}</legend>{chips('timeline', TIMELINES, timeline, setTimeline, (k) => t(`timelines.${k}`))}</fieldset>
          <LogoUploadField id="iq-logo" value={logo} onChange={(v) => { setLogo(v); if (v) setLogoNotice(undefined); }} notice={logoNotice} />
          <div className="field"><label htmlFor="iq-msg">{t('message')}</label><textarea id="iq-msg" rows={4} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} aria-describedby="iq-logo-note" /><p id="iq-logo-note" className="hint" style={{ fontSize: 13, opacity: 0.75, marginTop: 6 }}>{t('logoNote')}</p></div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="field"><label htmlFor="iq-name">{t('name')} *</label><input id="iq-name" name="name" value={contact.name} onChange={setC('name')} required maxLength={100} autoComplete="name" /></div>
          <div className="field"><label htmlFor="iq-email">{t('email')} *</label><input id="iq-email" name="email" value={contact.email} onChange={setC('email')} type="email" required maxLength={200} autoComplete="email" /></div>
          <div className="field"><label htmlFor="iq-company">{t('company')}</label><input id="iq-company" name="company" value={contact.company} onChange={setC('company')} maxLength={200} autoComplete="organization" /></div>
          <div className="field"><label htmlFor="iq-phone">{t('phone')}</label><input id="iq-phone" name="phone" value={contact.phone} onChange={setC('phone')} maxLength={40} autoComplete="tel" /></div>
          <div className="field">
            <label htmlFor="iq-region">{t('country')} *</label>
            <select id="iq-region" name="region" required value={contact.region} onChange={setC('region')}>
              <option value="" disabled>{t('countryPh')}</option>
              {COUNTRIES.map((c) => <option key={c} value={c}>{t(`countries.${c}`)}</option>)}
            </select>
          </div>
          {/* 诱饵字段：真人看不到，机器人填了会被服务端静默丢弃 */}
          <div className="hp" aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" defaultValue="" /></label></div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 16 }}>
            <input type="checkbox" name="consent" required checked={contact.consent} onChange={(e) => { const v = e.target.checked; setContact((c) => ({ ...c, consent: v })); }} /> <span>{t('consent')}</span>
          </label>
          {SITE_KEY && <div className="cf-turnstile" data-sitekey={SITE_KEY} data-language={locale} style={{ marginBottom: 16 }} />}
        </>
      )}

      {result && !result.ok && (
        <div className="alert err" role="alert">
          {t(`errors.${result.code}`)}
          {result.code === 'logo_invalid' && !logo && <LogoUploadField id="iq-logo-re" value={logo} onChange={(v) => { setLogo(v); if (v) { setLogoNotice(undefined); setResult(null); } }} />}
          {RETRYABLE.has(result.code) && (
            <> <button type="button" className="btn ghost" disabled={busy || wait > 0} onClick={() => formRef.current?.requestSubmit()}>{wait > 0 ? t('retryIn', { s: wait }) : t('retry')}</button></>
          )}
        </div>
      )}

      <div className="row">
        {step > 0 ? <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>{t('back')}</button> : <span />}
        <button type="submit" className="btn" disabled={busy}>{step < 2 ? t('next') : busy ? t('sending') : t('submit')}</button>
      </div>
    </form>
  );
}
