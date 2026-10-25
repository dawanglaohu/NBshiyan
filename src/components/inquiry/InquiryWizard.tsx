'use client';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { DEFAULT_PUBLISHED_LOCALE, isPublishedLocale, type PublishedLocale } from '@/i18n/published-locales';
import { products } from '@/data/products';
import { useQuote } from '@/components/quote/QuoteProvider';
import { QUOTE_MAX_ITEMS, isOverQuoteLimit } from '@/lib/quote/list';
import LogoUploadField from './LogoUploadField';
import { LOGO_TTL_MS, type LogoUpload } from '@/lib/client/logoUpload';
import { prefersReducedMotion, scrollBehaviorFor } from '@/lib/a11y/focus';
import { Link } from '@/i18n/navigation';
import { CONTACT_FIELDS, errorId, FIELD_ID, firstError, revalidate, validateContact, type ContactErrors, type ContactField } from '@/lib/inquiry/validate';
import { INQUIRY_EMAIL_EVENT } from '@/app/[locale]/contact/HumanContactNotice';

const QTY = [{ k: '1k', v: 1000 }, { k: '5k', v: 5000 }, { k: '10k', v: 10000 }, { k: '50k', v: 50000 }, { k: 'unsure', v: undefined }] as const;
const MATERIALS = ['corrugated', 'paperboard', 'kraft', 'pulp', 'unsure'] as const;
const TIMELINES = ['2w', '1m', '2m', 'unsure'] as const;
const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'PL', 'RU', 'KZ', 'BY', 'UZ', 'AE', 'SA', 'AU', 'CA', 'ZZ'] as const;
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};
const getTurnstile = () => (window as unknown as { turnstile?: TurnstileApi }).turnstile;

const RETRYABLE = new Set(['retry', 'network']);

/** 焦点移过去（不额外滚动），再滚到最近的可视位置（已在视口内就不动；scroll-margin 避开顶部导航）；减少动态效果时瞬间滚动 */
/** 错误汇总里的链接：把整个字段块（含标签）滚到顶部导航下方（scroll-margin-top），再把焦点给控件 */
function focusField(f: ContactField) {
  const el = document.getElementById(FIELD_ID[f]);
  if (!el) return;
  el.focus({ preventScroll: true });
  (el.closest('.field, .iq-consent') ?? el).scrollIntoView({ block: 'start', behavior: scrollBehaviorFor(prefersReducedMotion(window)) });
}

function revealNearest(el: HTMLElement | null) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', behavior: scrollBehaviorFor(prefersReducedMotion(window)) });
}
type Result = { ok: true; ref: string } | { ok: false; code: string };

export default function InquiryWizard() {
  const t = useTranslations('Inquiry');
  const names = useTranslations('Products.names');
  const locale = useLocale();
  const quote = useQuote();
  const [step, setStep] = useState(0);
  const [fromQuote, setFromQuote] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const overLimit = isOverQuoteLimit(selected.length);
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
  // #307 提交成功后表单整块换成成功卡片：390 下卡片会落在可视区上方、焦点掉到 body。
  // 卡片渲染后滚进可视区并把焦点移过去（读屏会播报）；减少动态效果时不平滑滚动
  // #308 P2-2：焦点改放到成功卡片的标题（tabIndex=-1），卡片照旧滚进可视区
  const doneRef = useRef<HTMLDivElement>(null);
  const doneTitleRef = useRef<HTMLHeadingElement>(null);
  const succeeded = result?.ok === true;
  useEffect(() => {
    if (!succeeded) return;
    doneTitleRef.current?.focus({ preventScroll: true });
    doneRef.current?.scrollIntoView({ block: 'start', behavior: scrollBehaviorFor(prefersReducedMotion(window)) });
  }, [succeeded]);
  // #308 P2-1：换步骤后焦点到「Step n of 3」这一行（tabIndex=-1，读屏会念），首次渲染不动焦点
  const stepRef = useRef<HTMLParagraphElement>(null);
  const stepMounted = useRef(false);
  const emailJump = useRef(false);
  const [emailJumpTick, setEmailJumpTick] = useState(0);
  useEffect(() => {
    const onJump = () => {
      emailJump.current = true;
      setStep(2);
      setEmailJumpTick((n) => n + 1);
    };
    window.addEventListener(INQUIRY_EMAIL_EVENT, onJump);
    return () => window.removeEventListener(INQUIRY_EMAIL_EVENT, onJump);
  }, []);
  useEffect(() => {
    if (!stepMounted.current) { stepMounted.current = true; return; }
    if (emailJump.current) return;
    revealNearest(stepRef.current);
  }, [step]);
  useEffect(() => {
    if (!emailJumpTick || step !== 2) return;
    emailJump.current = false;
    const input = document.getElementById('iq-email');
    if (!(input instanceof HTMLInputElement)) return;
    const field = input.closest('.field');
    const target = field instanceof HTMLElement ? field : input;
    target.scrollIntoView({ block: 'start', behavior: scrollBehaviorFor(prefersReducedMotion(window)) });
    input.focus({ preventScroll: true });
  }, [emailJumpTick, step]);
  // #308 P2-2：提交失败后焦点到错误框（role=alert，tabIndex=-1）；错误框下面就是提交按钮
  const errRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const failed = result && !result.ok ? result : null;
  useEffect(() => {
    if (failed) revealNearest(errRef.current);
  }, [failed]);
  // #308 P2-3：第 3 步自定义校验。点提交才开始显示；之后改对的字段当场去掉错误
  const [errs, setErrs] = useState<ContactErrors>({});
  // #308 UX 复核：校验失败后焦点到顶部错误汇总（tabIndex=-1），每次失败的提交都重新移焦点
  const summaryRef = useRef<HTMLDivElement>(null);
  const [invalidAttempt, setInvalidAttempt] = useState(0);
  useEffect(() => {
    if (invalidAttempt) revealNearest(summaryRef.current);
  }, [invalidAttempt]);
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);
  useEffect(() => { setErrs((e) => revalidate(e, contact)); }, [contact]);
  const prefilled = useRef(false);
  const prevQuote = useRef<string[]>([]);

  // 从询价清单进来时预填产品
  useEffect(() => {
    setFromQuote(new URLSearchParams(window.location.search).get('from') === 'quote');
  }, []);
  useEffect(() => {
    if (!prefilled.current && quote.items.length) {
      prefilled.current = true;
      setSelected(quote.items.map((i) => i.slug));
    }
    // 从清单抽屉里删除的条目同步移出（用户自行删减，绝不自动截断）
    const now = new Set(quote.items.map((i) => i.slug));
    const gone = prevQuote.current.filter((s) => !now.has(s));
    prevQuote.current = [...now];
    if (gone.length) setSelected((p) => p.filter((s) => !gone.includes(s)));
  }, [quote.items]);

  // Turnstile 只在配置了站点密钥时加载（CSP 已放行 challenges.cloudflare.com）
  // 用显式渲染：隐式模式只在脚本首次加载时扫描一次 .cf-turnstile，
  // 第 3 步点 Back 再 Next 后容器重新挂载，控件不会再渲染，令牌为空 → 403（#181）。
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  useEffect(() => {
    if (!SITE_KEY || step !== 2) return;
    let cancelled = false;
    const mount = () => {
      const ts = getTurnstile();
      const el = turnstileRef.current;
      if (cancelled || !ts || !el || widgetId.current) return;
      widgetId.current = ts.render(el, {
        sitekey: SITE_KEY,
        language: locale,
        callback: (tok: string) => setTurnstileToken(tok),
        'expired-callback': () => { setTurnstileToken(''); if (widgetId.current) getTurnstile()?.reset(widgetId.current); },
        'error-callback': () => { setTurnstileToken(''); }
      });
    };
    if (getTurnstile()) mount();
    else {
      let s = document.getElementById('cf-turnstile-js') as HTMLScriptElement | null;
      if (!s) {
        s = document.createElement('script');
        s.id = 'cf-turnstile-js';
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        document.head.appendChild(s);
      }
      s.addEventListener('load', mount);
    }
    return () => {
      cancelled = true;
      document.getElementById('cf-turnstile-js')?.removeEventListener('load', mount);
      if (widgetId.current) { getTurnstile()?.remove(widgetId.current); widgetId.current = null; }
      setTurnstileToken('');
    };
  }, [step, locale]);

  const toggle = (slug: string) => setSelected((p) => (p.includes(slug) ? p.filter((s) => s !== slug) : [...p, slug]));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step < 2) { setStep(step + 1); return; }
    // busy / 503 倒计时期间按钮只是 aria-disabled（不用原生 disabled，焦点不会掉），这里拦住重复提交
    if (busy || wait > 0) return;
    if (awaitingCheck) return;
    const invalid = validateContact(contact);
    setErrs(invalid);
    const first = firstError(invalid);
    if (first) { setInvalidAttempt((n) => n + 1); return; }
    if (overLimit) return; // never auto-trim: user must remove items first
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
      // 接口只接受已发布语言（#360）；页面语言一定是已发布的，这里再收窄一次，类型上也是 PublishedLocale
      locale: (isPublishedLocale(locale) ? locale : DEFAULT_PUBLISHED_LOCALE) satisfies PublishedLocale,
      contact: { name: c(contact.name), email: c(contact.email), company: c(contact.company), phone: c(contact.phone), region: c(contact.region) },
      message: message.trim() || undefined,
      items: selected.map((productSlug) => ({ productSlug, ...(quantity ? { quantity } : {}), ...(Object.keys(config).length ? { config } : {}) })),
      attribution: { page: window.location.pathname },
      website: String(fd.get('website') ?? ''),
      turnstileToken: turnstileToken || opt('cf-turnstile-response'),
      ...(logo ? { logoUploadId: logo.uploadId } : {})
    };
    // 从错误框里的「重试」提交时，错误框马上会被替换：先把焦点交给提交按钮，不让它掉到 <body>
    if (errRef.current?.contains(document.activeElement)) submitRef.current?.focus();
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
      setTurnstileToken('');
      if (widgetId.current) getTurnstile()?.reset(widgetId.current);
    }
  }

  // 配置了 Turnstile 但还没拿到令牌时，第 3 步不能提交（#181）；令牌清空/重置逻辑不变
  const awaitingCheck = step === 2 && Boolean(SITE_KEY) && !turnstileToken;

  if (result?.ok) {
    return (
      <div ref={doneRef} className="wizard wizard-done" role="status" aria-labelledby="iq-done-title">
        <h2 ref={doneTitleRef} id="iq-done-title" tabIndex={-1} style={{ marginTop: 0 }}>{t('success.title')}</h2>
        <p>{t('success.ref')} <strong>{result.ref}</strong></p>
        {t('success.reply') ? <p>{t('success.reply')}</p> : null}
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

  // 当帧就按当前输入重算（不用等 effect 同步 errs），改对的那一刻错误就消失
  const shownErrs = revalidate(errs, contact);
  const invalidProps = (f: ContactField) => (shownErrs[f] ? { 'aria-invalid': true as const, 'aria-describedby': errorId(f) } : {});
  const fieldErr = (f: ContactField) => (shownErrs[f] ? <p id={errorId(f)} className="iq-err"><span aria-hidden="true">⚠ </span>{t(`validation.${shownErrs[f]!}`)}</p> : null);

  return (
    <form ref={formRef} className="wizard" onSubmit={submit} noValidate>
      <div className="steps" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className={i <= step ? 'on' : ''} />)}</div>
      <p ref={stepRef} className="iq-step" tabIndex={-1}>{t('stepOf', { n: step + 1, total: 3 })} · {t(`steps.${step}`)}</p>

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
          {firstError(shownErrs) && (
            <div ref={summaryRef} className="alert err iq-summary" role="alert" tabIndex={-1}>
              <p><span aria-hidden="true">⚠ </span>{t('validation.summary')}</p>
              <ul>{CONTACT_FIELDS.filter((f) => shownErrs[f]).map((f) => (
                <li key={f}><a href={`#${FIELD_ID[f]}`} onClick={(e) => { e.preventDefault(); focusField(f); }}>{t(`validation.${shownErrs[f]!}`)}</a></li>
              ))}</ul>
            </div>
          )}
          <div className="field"><label htmlFor="iq-name">{t('name')} *</label><input id="iq-name" name="name" value={contact.name} onChange={setC('name')} required maxLength={100} autoComplete="name" {...invalidProps('name')} />{fieldErr('name')}</div>
          <div className="field"><label htmlFor="iq-email">{t('email')} *</label><input id="iq-email" name="email" value={contact.email} onChange={setC('email')} type="email" required maxLength={200} autoComplete="email" {...invalidProps('email')} />{fieldErr('email')}</div>
          <div className="field"><label htmlFor="iq-company">{t('company')}</label><input id="iq-company" name="company" value={contact.company} onChange={setC('company')} maxLength={200} autoComplete="organization" /></div>
          <div className="field"><label htmlFor="iq-phone">{t('phone')}</label><input id="iq-phone" name="phone" value={contact.phone} onChange={setC('phone')} maxLength={40} autoComplete="tel" /></div>
          <div className="field">
            <label htmlFor="iq-region">{t('country')} *</label>
            <select id="iq-region" name="region" required value={contact.region} onChange={setC('region')} {...invalidProps('region')}>
              <option value="" disabled>{t('countryPh')}</option>
              {COUNTRIES.map((c) => <option key={c} value={c}>{t(`countries.${c}`)}</option>)}
            </select>
            {fieldErr('region')}
          </div>
          {/* 诱饵字段：真人看不到，机器人填了会被服务端静默丢弃 */}
          <div className="hp" aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" defaultValue="" /></label></div>
          <div className="iq-consent">
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input id="iq-consent" type="checkbox" name="consent" required checked={contact.consent} onChange={(e) => { const v = e.target.checked; setContact((c) => ({ ...c, consent: v })); }} {...invalidProps('consent')} />{' '}
              {/* #308 P2-4：隐私政策是真链接。填写内容只在页面内存里，同一标签页跳走再回来会清空，所以按 UX 的备选方案在新标签页打开，并只给读屏念「在新标签页打开」 */}
              <span>{t.rich('consent', { link: (c) => <Link href="/privacy" target="_blank" rel="noopener" className="iq-link">{c}<span className="sr-only"> {t('newTab')}</span></Link> })}</span>
            </label>
            {fieldErr('consent')}
          </div>
          {SITE_KEY && <div ref={turnstileRef} className="cf-turnstile" style={{ marginBottom: 16 }} />}
        </>
      )}

      {result && !result.ok && (
        <div ref={errRef} className="alert err" role="alert" tabIndex={-1}>
          <span aria-hidden="true">⚠ </span>{t(`errors.${result.code}`)}
          {result.code === 'logo_invalid' && !logo && <LogoUploadField id="iq-logo-re" value={logo} onChange={(v) => { setLogo(v); if (v) { setLogoNotice(undefined); setResult(null); } }} />}
          {RETRYABLE.has(result.code) && (
            <> <button type="button" className="btn ghost" disabled={busy || wait > 0} onClick={() => formRef.current?.requestSubmit()}>{wait > 0 ? t('retryIn', { s: wait }) : t('retry')}</button></>
          )}
        </div>
      )}

      {overLimit && <p id="iq-over" className="quote-notice" role="status" aria-live="polite">{t('overLimit', { max: QUOTE_MAX_ITEMS, n: selected.length })}</p>}
      <div className="row iq-actions">
        {step > 0 ? <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>{t('back')}</button> : <span />}
        <button ref={submitRef} type="submit" className="btn" disabled={awaitingCheck || (step === 2 && overLimit)} aria-disabled={busy || (step === 2 && wait > 0) || awaitingCheck || (step === 2 && overLimit) || undefined} aria-describedby={[overLimit ? 'iq-over' : '', awaitingCheck ? 'iq-check-hint' : ''].filter(Boolean).join(' ') || undefined}>{step < 2 ? t('next') : busy ? t('sending') : t('submit')}</button>
      </div>
      {awaitingCheck && <p id="iq-check-hint" className="hint" role="status" style={{ fontSize: 13, opacity: 0.75, margin: '8px 0 0', textAlign: 'right' }}>{t('checking')}</p>}
    </form>
  );
}
