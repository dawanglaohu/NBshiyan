import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMAIL_RE, errorId, FIELD_ID, fieldError, firstError, revalidate, validateContact, type ContactInput } from '../src/lib/inquiry/validate';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = read('../src/components/inquiry/InquiryWizard.tsx');
const css = read('../src/app/globals.css');
const en = JSON.parse(read('../messages/en.json'));
const ru = JSON.parse(read('../messages/ru.json'));
const ok: ContactInput = { name: 'Anna', email: 'anna@acme.com', region: 'DE', consent: true };

test('#308 validate: all four fields, page order, required vs format email', () => {
  assert.deepEqual(validateContact(ok), {});
  assert.deepEqual(validateContact({ name: ' ', email: '', region: '', consent: false }), { name: 'name', email: 'emailRequired', region: 'region', consent: 'consent' });
  assert.equal(fieldError('email', { ...ok, email: 'anna@acme' }), 'emailInvalid');
  assert.equal(fieldError('email', { ...ok, email: 'anna acme.com' }), 'emailInvalid');
  assert.equal(fieldError('email', { ...ok, email: '  anna@acme.co.uk ' }), undefined);
  for (const bad of ['a@b', '@b.com', 'a@.com', 'a b@c.com', 'a@b.']) assert.equal(EMAIL_RE.test(bad), false, bad);
  assert.equal(firstError({ consent: 'consent', email: 'emailInvalid' }), 'email');
  assert.equal(errorId('email'), 'iq-email-err');
  assert.equal(FIELD_ID.consent, 'iq-consent');
});

test('#308 validate: live revalidation only touches fields that already show an error', () => {
  const prev = { email: 'emailRequired' as const };
  assert.deepEqual(revalidate(prev, { ...ok, email: 'x' }), { email: 'emailInvalid' });
  assert.deepEqual(revalidate(prev, ok), {});
  // name 为空但之前没报错：不会凭空冒出来
  assert.deepEqual(revalidate(prev, { ...ok, name: '', email: '' }), prev);
  assert.equal(revalidate(prev, { ...ok, email: '' }), prev, 'unchanged → same object (no re-render loop)');
});

test('#308 wizard: noValidate always, fields wired with aria-invalid/aria-describedby, summary role=alert, focus first error', () => {
  assert.match(src, /onSubmit=\{submit\} noValidate>/);
  assert.match(src, /shownErrs\[f\] \? \{ 'aria-invalid': true as const, 'aria-describedby': errorId\(f\) \}/);
  for (const f of ['name', 'email', 'region', 'consent']) {
    assert.match(src, new RegExp(`\\{\\.\\.\\.invalidProps\\('${f}'\\)\\}`), f);
    assert.match(src, new RegExp(`\\{fieldErr\\('${f}'\\)\\}`), f);
  }
  // UX 复核：失败后焦点到错误汇总（不是第一个字段）；汇总里的链接把焦点给对应字段
  assert.match(src, /<div ref=\{summaryRef\} className="alert err iq-summary" role="alert" tabIndex=\{-1\}>/);
  assert.match(src, /if \(first\) \{ setInvalidAttempt\(\(n\) => n \+ 1\); return; \}/);
  assert.match(src, /if \(invalidAttempt\) revealNearest\(summaryRef\.current\);\s*\}, \[invalidAttempt\]\);/);
  assert.match(src, /onClick=\{\(e\) => \{ e\.preventDefault\(\); focusField\(f\); \}\}/);
  assert.match(src, /el\.focus\(\{ preventScroll: true \}\);\s*\(el\.closest\('\.field, \.iq-consent'\) \?\? el\)\.scrollIntoView\(\{ block: 'start'/);
  assert.doesNotMatch(src, /document\.getElementById\(FIELD_ID\[first\]\)\?\.focus\(\)/);
  assert.match(src, /setErrs\(\(e\) => revalidate\(e, contact\)\)/);
  assert.match(src, /const shownErrs = revalidate\(errs, contact\);/);
  assert.match(src, /<span aria-hidden="true">⚠ <\/span>/);
});

test('#308 wizard: step line focused on step change (not on mount), errors box focused on failure', () => {
  assert.match(src, /<p ref=\{stepRef\} className="iq-step" tabIndex=\{-1\}>/);
  assert.match(src, /if \(!stepMounted\.current\) \{ stepMounted\.current = true; return; \}\s*revealNearest\(stepRef\.current\);\s*\}, \[step\]\);/);
  assert.match(src, /<div ref=\{errRef\} className="alert err" role="alert" tabIndex=\{-1\}>/);
  assert.match(src, /if \(failed\) revealNearest\(errRef\.current\);/);
  assert.match(src, /el\.scrollIntoView\(\{ block: 'nearest', behavior: scrollBehaviorFor\(prefersReducedMotion\(window\)\) \}\)/);
  assert.match(css, /\.iq-step:focus,\.wizard-done h2:focus,\.wizard \.alert\.err:focus\{outline:none\}/);
});

test('#308 wizard: busy uses aria-disabled (no native disabled), handler guards double submit', () => {
  const btn = src.match(/<button ref=\{submitRef\} type="submit"[^>]*>/)?.[0] ?? '';
  assert.ok(btn, 'submit button');
  assert.doesNotMatch(btn.match(/ disabled=\{[^}]*\}/)?.[0] ?? '', /busy/);
  assert.match(btn, /aria-disabled=\{busy \|\|/);
  assert.match(src, /if \(busy \|\| wait > 0\) return;/);
});

test('#308 consent: privacy link via t.rich, new tab with sr-only note; messages EN/RU', () => {
  assert.match(src, /t\.rich\('consent', \{ link: \(c\) => <Link href="\/privacy" target="_blank" rel="noopener" className="iq-link">\{c\}<span className="sr-only"> \{t\('newTab'\)\}<\/span><\/Link> \}\)/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  assert.match(en.Inquiry.consent, /<link>privacy policy<\/link>\.$/);
  assert.match(ru.Inquiry.consent, /<link>политикой конфиденциальности<\/link>\.$/);
  assert.equal(ru.Inquiry.newTab, '(откроется в новой вкладке)');
  for (const k of ['summary', 'name', 'emailRequired', 'emailInvalid', 'region', 'consent']) {
    assert.ok(en.Inquiry.validation[k] && ru.Inquiry.validation[k], k);
  }
  assert.equal(ru.Inquiry.submit !== undefined, true);
});

test('#308 RU: no bare "email" in RU copy (use «e-mail»)', () => {
  const bad: string[] = [];
  const walk = (o: unknown, p: string) => {
    if (typeof o === 'string') { if (/(?<![\w-])email\b/.test(o)) bad.push(p); }
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`);
  };
  walk(ru, '');
  assert.deepEqual(bad, []);
});

test('#308 CSS: chips ≥44px, ✓ + heavier border when checked, 2 columns ≤767; wizard centred max 640', () => {
  assert.match(css, /\.chips label\{display:inline-flex;align-items:center;gap:6px;min-height:44px;/);
  assert.match(css, /\.chips label:has\(input:checked\)::before\{content:"✓";content:"✓" \/ "";/);
  assert.match(css, /\.chips label:has\(input:checked\)\{[^}]*box-shadow:0 0 0 1px var\(--ink\)/);
  assert.match(css, /@media \(max-width:767px\)\{\.chips\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\.chips label\{[^}]*hyphens:auto;overflow-wrap:break-word\}/);
  assert.match(css, /\.wizard\{[^}]*max-width:640px;margin-inline:auto\}/);
});

test('#308 UX review: scroll-margin on summary + every field = measured nav height (73px) + 16px (16px when nav is static ≤767)', () => {
  const sel = '.wizard-done,.iq-step,.wizard .alert.err,.wizard .field,.wizard .field :is(input,select,textarea),.iq-consent,.iq-consent input';
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(css, new RegExp(esc + '\\{scroll-margin-top:calc\\(var\\(--iq-nav-h\\) \\+ 16px\\)\\}'));
  assert.match(css, new RegExp('@media \\(max-width:767px\\)\\{' + esc + '\\{scroll-margin-top:16px\\}\\}'));
  assert.match(css, /\.wizard\{--iq-nav-h:73px\}/); // 实测吸顶导航 73px（≥768）
  assert.match(css, /@media \(max-width:767px\)\{header\.site\{position:static\}/);
});

test('#308 UX review: server error box has aria-hidden ⚠, consent checkbox dark 20px, primary button on the right', () => {
  assert.match(src, /role="alert" tabIndex=\{-1\}>\s*<span aria-hidden="true">⚠ <\/span>\{t\(`errors\.\$\{result\.code\}`\)\}/);
  assert.match(css, /\.iq-consent input\[type=checkbox\]\{accent-color:var\(--ink\);width:20px;height:20px;/);
  assert.match(src, /<div className="iq-consent">\s*<label /);
  assert.match(src, /<div className="row iq-actions">/);
  assert.match(css, /\.iq-actions \.btn:not\(\.ghost\)\{margin-left:auto\}/);
  // 文案不变：服务端错误不加联系方式或时间承诺
  assert.equal(en.Inquiry.errors.server, 'Something went wrong on our side. Please try again later.');
  assert.equal(ru.Inquiry.errors.server, 'На нашей стороне произошла ошибка. Пожалуйста, попробуйте позже.');
});
