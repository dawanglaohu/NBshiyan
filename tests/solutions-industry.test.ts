import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INDUSTRIES, industryParams, resolveIndustry } from '../src/lib/solutions';

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
      const r = resolveIndustry(i.slug, names)!;
      for (const k of ['title', 'lead', 'metaTitle', 'metaDescription']) {
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
