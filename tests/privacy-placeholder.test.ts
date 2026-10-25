import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPrivacy, clientMessages, privacyIndexable, PRIVACY_PAGE_COMPLETE, RETENTION_KEYS } from '../src/lib/legal/privacy';
import { hasPlaceholder, visible } from '../src/lib/placeholder';
import { buildSitemap } from '../src/lib/seo/sitemapEntries';

const load = (l: string) => JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), 'utf8')).Privacy;

test('placeholder guard', () => {
  assert.equal(hasPlaceholder('Email: {{待Ryan确认}}'), true);
  assert.equal(visible('{{待Ryan确认}}'), null);
  assert.equal(visible('ok'), 'ok');
});

for (const l of ['en', 'ru']) {
  test(`privacy ${l}: no placeholder is rendered`, () => {
    const p = load(l);
    assert.ok(JSON.stringify(p).includes('{{待Ryan确认}}'), 'source still has placeholders (company, email)');
    const out = JSON.stringify(buildPrivacy(p));
    assert.ok(!out.includes('{{') && !out.includes('待Ryan确认'), out);
  });
  test(`privacy ${l}: all sections except unconfirmed company render; every retention line present`, () => {
    const doc = buildPrivacy(load(l));
    assert.deepEqual(doc.sections.map((s) => s.key), ['collected', 'purpose', 'retention', 'cookies', 'chat', 'processors', 'contact']);
    assert.equal(doc.sections.find((s) => s.key === 'retention')!.items.length, RETENTION_KEYS.length);
    assert.ok(JSON.stringify(load(l)).includes('pj-consent'));
  });
  test(`privacy ${l}: noindex while incomplete or placeholders exist`, () => {
    assert.equal(privacyIndexable(load(l)), false);
    assert.equal(privacyIndexable(load(l), true), false, 'placeholders alone keep it noindex');
  });
}

test('ru uses ё', () => assert.match(JSON.stringify(load('ru')), /ё/));

test('sitemap excludes /privacy while PRIVACY_PAGE_COMPLETE is false', () => {
  assert.equal(PRIVACY_PAGE_COMPLETE, false);
  const s = buildSitemap({ siteUrl: 'https://example.com', locales: ['en', 'ru'], defaultLocale: 'en' });
  assert.ok(!s.some((e) => e.url.includes('/privacy')));
});

for (const l of ['en', 'ru']) test(`client messages (${l}) never carry placeholders`, () => {
  const m = JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), 'utf8'));
  const c = JSON.stringify(clientMessages(m));
  assert.ok(!c.includes('{{') && !c.includes('待Ryan确认'));
});

test('processors section renders the services actually used (EN/RU), no placeholders, not sent to client', async () => {
  for (const l of ['en', 'ru']) {
    const m = JSON.parse(await (await import('node:fs/promises')).readFile(`messages/${l}.json`, 'utf8'));
    const sec = buildPrivacy(m.Privacy).sections.find((s) => s.key === 'processors')!;
    assert.equal(sec.items.length, 5, l);
    assert.equal(sec.items.some((item) => /live-chat|онлайн-чат/i.test(item)), false, l);
    assert.ok(sec.paragraphs.length >= 1);
    assert.ok(!JSON.stringify(m.Privacy.sections.processors).includes('{{'), l);
    assert.ok(!('Privacy' in clientMessages(m)));
  }
});
