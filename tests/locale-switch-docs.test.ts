import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchHref } from '../src/lib/i18n/localeSwitch';

// DetailPage (cmsPages.tsx) passes { en: base/alt.en | null, ru: base/alt.ru | null }
for (const base of ['/articles', '/solutions'] as const) {
  test(`${base}/[slug]: ru version exists → ru slug`, () => {
    const alts = { en: `${base}/packaging-guide`, ru: `${base}/rukovodstvo-po-upakovke` };
    assert.equal(switchHref(`/en${base}/packaging-guide`, 'en', 'ru', alts), `/ru${base}/rukovodstvo-po-upakovke`);
    assert.equal(switchHref(`/ru${base}/rukovodstvo-po-upakovke`, 'ru', 'en', alts), `/en${base}/packaging-guide`);
  });

  test(`${base}/[slug]: no ru version → /ru${base} list, not a 404 path`, () => {
    const alts = { en: `${base}/packaging-guide`, ru: null };
    assert.equal(switchHref(`/en${base}/packaging-guide`, 'en', 'ru', alts), `/ru${base}`);
    // no alternates at all (e.g. before hydration) → same fallback, never the en slug under /ru
    assert.equal(switchHref(`/en${base}/packaging-guide`, 'en', 'ru', null), `/ru${base}`);
    assert.equal(switchHref(`/en${base}/packaging-guide`, 'en', 'ru', {}), `/ru${base}`);
  });
}
