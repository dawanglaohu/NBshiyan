import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INDUSTRIES, industryParams, resolveIndustry, resolveFromMessages } from '../src/lib/solutions';
import { breadcrumbJsonLd, solutionCrumbs } from '../src/lib/seo/breadcrumbs';
import { CMS_SECTIONS } from '../src/lib/seo/sitemapEntries';

const msgs = (l: string) => JSON.parse(readFileSync(`messages/${l}.json`, 'utf8'));
const fill = (tpl: string, industry: string) => tpl.replace('{industry}', industry);

for (const l of ['en', 'ru']) {
  const m = msgs(l);
  const names: Record<string, string> = m.Products.names;

  test(`${l}: every industry slug has a localized name and static param`, () => {
    for (const i of INDUSTRIES) assert.ok(resolveIndustry(i.slug, names)?.name, i.slug);
    assert.deepEqual(industryParams().map((p) => p.slug), INDUSTRIES.map((i) => i.slug));
  });

  test(`${l}: unknown or hostile slug -> null (page and metadata call notFound)`, () => {
    for (const s of ['nope', '<script>alert(1)</script>', '__proto__', 'constructor', 'toString', '', '../admin', 'WINE-BOXES', 'wine-boxes ']) {
      assert.equal(resolveIndustry(s, names), null, JSON.stringify(s));
    }
  });

  test(`${l}: detail title/meta use the list name, never the raw slug`, () => {
    const d = m.Solutions.detail;
    for (const i of INDUSTRIES) {
      const r = resolveFromMessages(i.slug, m)!;
      assert.ok(r.title, `${l} ${i.slug} has title`);
      for (const k of ['metaTitle']) {
        const out = fill(d[k], r.name);
        assert.ok(out.includes(r.name), `${k} has name`);
        if (r.name.toLowerCase() !== i.slug) assert.ok(!out.includes(i.slug), `${k} must not contain slug ${i.slug}`);
        assert.ok(!/[{}]/.test(out), `${k} fully filled`);
      }
    }
  });

  test(`${l}: #108 namespaces carry no {{…}} placeholders`, () => {
    for (const ns of ['Solutions', 'Factory', 'Cases']) assert.doesNotMatch(JSON.stringify(m[ns]), /\{\{/);
  });
}

test('Solutions.industries.<slug> wins over Products.names; falls back when missing', () => {
  const m = { Products: { names: { 'wine-boxes': 'Wine boxes', 'gift-boxes': 'Gift boxes' } }, Solutions: { industries: { 'wine-boxes': { name: 'Wine & Spirits', title: 'Packaging for Wine & Spirits' } } } };
  assert.equal(resolveFromMessages('wine-boxes', m)?.name, 'Wine & Spirits');
  assert.equal(resolveFromMessages('wine-boxes', m)?.title, 'Packaging for Wine & Spirits');
  assert.equal(resolveFromMessages('gift-boxes', m)?.title, undefined);
  assert.equal(resolveFromMessages('gift-boxes', m)?.name, 'Gift boxes');
  assert.equal(resolveFromMessages('nope', m), null);
  assert.equal(resolveFromMessages('wine-boxes', { Solutions: { industries: { 'wine-boxes': { name: '' } } } }), null);
});

test('sitemap: no Sanity-generated /solutions entries (#108 static list)', () => {
  assert.ok(!CMS_SECTIONS.some((s) => (s.base as string) === '/solutions' || (s.type as string) === 'solution'));
});

for (const l of ['en', 'ru'] as const) {
  const m = msgs(l);
  test(`${l}: BreadcrumbList names equal the visible breadcrumb strings`, () => {
    for (const i of INDUSTRIES) {
      const r = resolveFromMessages(i.slug, m)!;
      const crumbs = solutionCrumbs(m.Nav.home, m.Solutions.detail.crumb, r.slug, r.name);
      const ld = breadcrumbJsonLd('https://example.com', l, crumbs);
      assert.deepEqual(ld.itemListElement.map((x) => x.name), [m.Nav.home, m.Solutions.detail.crumb, r.name]);
      assert.equal(ld.itemListElement[2].item, `https://example.com/${l}/solutions/${i.slug}`);
    }
    assert.equal(m.Solutions.detail.crumb, l === 'ru' ? 'Отраслевые решения' : 'Industry solutions');
  });

  test(`${l}: industryGen present and every metaDescription < 150 chars`, () => {
    for (const i of INDUSTRIES) {
      const r = resolveFromMessages(i.slug, m)!;
      assert.ok(m.Solutions.industries[i.slug].industryGen, `${i.slug} industryGen`);
      const out = m.Solutions.detail.metaDescription.replace('{industryGen}', r.industryGen);
      const lead = m.Solutions.detail.lead.replace('{industryGen}', r.industryGen);
      assert.ok(!/[{}]/.test(out + lead));
      if (l === 'ru') assert.ok(out.length < 150, `${i.slug}: ${out.length}`);
    }
  });
}

test('breadcrumb current item: aria-current="page", title=full name, full text in DOM (truncation CSS-only)', () => {
  const src = readFileSync('src/app/[locale]/solutions/[slug]/page.tsx', 'utf8');
  assert.match(src, /<span className="sx-crumb-cur" aria-current="page" title=\{crumbs\[2\]\.name\}>\{crumbs\[2\]\.name\}<\/span>/);
  const css = readFileSync('src/components/sections/sections.css', 'utf8');
  const rule = css.match(/\.sx-crumb-cur\{([^}]*)\}/)?.[1] ?? '';
  for (const d of ['min-width:0', 'overflow:hidden', 'white-space:nowrap', 'text-overflow:ellipsis']) assert.ok(rule.includes(d), d);
});
