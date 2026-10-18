import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { switchPath, safeLocaleHref, langSwitchTarget, menuSwitchTarget } from '../src/lib/i18n/localeSwitch';
import type { CategoryMeta } from '../src/lib/seo/categoryMeta';

// 多语言第 0 期：语言下拉（UX 规格）+ 切换逻辑按已发布语言泛化
const menu = readFileSync('src/components/layout/LangMenu.tsx', 'utf8');
const hook = readFileSync('src/components/layout/LangLink.tsx', 'utf8');
const header = readFileSync('src/components/layout/SiteHeader.tsx', 'utf8');
const css = readFileSync('src/app/globals.css', 'utf8');

test('button: globe + short code, aria-label = full native name, haspopup/expanded/controls', () => {
  assert.match(menu, /aria-haspopup="menu"/);
  assert.match(menu, /aria-expanded=\{open\}/);
  assert.match(menu, /aria-controls=\{listId\}/);
  assert.match(menu, /aria-label=\{meta\.nativeName\}/);
  assert.match(menu, /className="lang-globe"/);
  assert.match(menu, /\{meta\.short\}/);
});

test('items: native names, no flags, current first with check + aria-current, lang/hrefLang/dir per item', () => {
  assert.match(hook, /const order = \[current, \.\.\.PUBLISHED_LOCALES\.filter\(\(l\) => l !== current\)\]/);
  assert.match(menu, /aria-current=\{isCur \? 'true' : undefined\}/);
  assert.match(menu, /className="lang-check"/);
  for (const a of ['lang={x.locale}', 'hrefLang={x.locale}', 'dir={m.dir}']) assert.ok(menu.includes(a), a);
  assert.doesNotMatch(menu + hook, /[\u{1F1E6}-\u{1F1FF}]|flag/u);
});

test('keyboard and outside click: Enter/Space/arrows open, arrows/Home/End move, Esc closes + returns focus, Tab and outside click close', () => {
  for (const k of ["'Enter'", "' '", "'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Escape'", "'Tab'"]) assert.ok(menu.includes(k), k);
  assert.match(menu, /close\(true\)/);
  assert.match(menu, /btnRef\.current\?\.focus\(\)/);
  assert.match(menu, /addEventListener\('pointerdown'/);
});

test('CSP: no style attribute, classes only; 44px rows on mobile', () => {
  assert.doesNotMatch(menu, /style=\{/);
  assert.match(css, /@media \(max-width:767px\)\{\.lang-item\{min-height:44px\}/);
});

test('header uses the dropdown in desktop and mobile; slug-mapping logic reused (langSwitchTarget)', () => {
  assert.equal((header.match(/<LangMenu \/>/g) ?? []).length, 2);
  assert.match(hook, /menuSwitchTarget\(raw, pathname, current, to, alts, tail\)/);
  assert.match(hook, /router\.push\(menuSwitchTarget\(raw, pathname, current, to, alts, suffix\(\)\), \{ locale: to \}\)/);
  assert.match(hook, /const raw = useRawPathname\(\);/);
});

test('switch logic unchanged for en/ru; missing target slug falls back to list page', () => {
  const meta = [{ key: 'gift-boxes', en: { slug: 'custom-gift-boxes' }, ru: { slug: 'podarochnye-korobki' } }] as unknown as CategoryMeta[];
  assert.equal(switchPath('/en/products/custom-gift-boxes', 'en', 'ru', null, meta, true), '/products/podarochnye-korobki');
  const noRu = [{ key: 'x', en: { slug: 'x-en' }, ru: undefined }] as unknown as CategoryMeta[];
  assert.equal(switchPath('/en/products/x-en', 'en', 'ru', null, noRu, true), '/products');
  assert.equal(safeLocaleHref('/ru/contact', 'ru'), '/ru/contact');
  for (const bad of ['/ja/contact', '/EN/contact', '//evil.com', '/en-US']) assert.equal(safeLocaleHref(bad, 'en'), '/en', bad);
  assert.equal(langSwitchTarget('/contact', 'en', 'ru', null, '?x=1#f'), '/contact?x=1#f');
});

test('inquiry wizard posts a PublishedLocale', () => {
  const src = readFileSync('src/components/inquiry/InquiryWizard.tsx', 'utf8');
  assert.match(src, /locale: \(isPublishedLocale\(locale\) \? locale : DEFAULT_PUBLISHED_LOCALE\) satisfies PublishedLocale/);
});

test('on the unpublished-locale 404 page every item goes to that locale home (/en, /ru), never /ru/ja', () => {
  for (const raw of ['/ja', '/ja/', '/ja/products', '/EN', '/en-US/contact', '/xx']) {
    // next-intl 在 rewrite 后的页面上看到的 pathname 可能是 /ja 或 /locale-unavailable，两种都要回首页
    for (const p of [raw, '/locale-unavailable', '/ja']) {
      assert.equal(menuSwitchTarget(raw, p, 'en', 'ru', null, '?x=1#h'), '/', `${raw} ${p} → ru`);
      assert.equal(menuSwitchTarget(raw, p, 'en', 'en', null, ''), '/', `${raw} ${p} → en`);
    }
  }
  // 正常页面不受影响
  assert.equal(menuSwitchTarget('/en/contact', '/contact', 'en', 'ru', null, '?x=1'), '/contact?x=1');
  assert.equal(menuSwitchTarget('/en/products/nope', '/products/nope', 'en', 'ru', null, ''), '/products');
});
