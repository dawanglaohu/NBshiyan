// Regenerating the Sanity import from the sources must reproduce the committed file byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('sanity-import: build.py output matches committed import.ndjson', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sanity-import-'));
  try {
    const out = join(dir, 'import.ndjson');
    const r = spawnSync('python3', ['docs/content/sanity-import/build.py', '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const committed = readFileSync('docs/content/sanity-import/import.ndjson');
    const built = readFileSync(out);
    assert.ok(built.equals(committed), 'import.ndjson is stale: run linkmap.py then build.py (see sanity-import/README.md)');
    for (const line of built.toString('utf8').trimEnd().split('\n')) JSON.parse(line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanity-import: build.py skips docs without an internal key (FAQ drafts, proofreading, fact sheet) and articles with import: false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sanity-src-'));
  try {
    mkdirSync(join(dir, 'articles'));
    for (const f of readdirSync('docs/content/articles')) copyFileSync(join('docs/content/articles', f), join(dir, 'articles', f));
    writeFileSync(join(dir, 'landing-faq.md'), '# FAQ drafts\n\n## EN\n- Q?\n');
    writeFileSync(join(dir, 'ru-proofreading.md'), '# ru proofreading\n| F1 | x |\n');
    writeFileSync(join(dir, 'ryan-fact-sheet.md'), '# fact sheet\n## Q1\n');
    writeFileSync(join(dir, 'articles', 'draft.md'), '---\ntitle: "Draft"\nslug: draft\nlocale: en\nimport: false\nmeta_description: "x"\n---\n\n# Draft\n\nBody {{待Ryan确认}}\n');
    const out = join(dir, 'import.ndjson');
    const r = spawnSync('python3', ['docs/content/sanity-import/build.py', dir, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(out).equals(readFileSync('docs/content/sanity-import/import.ndjson')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanity-import: build.py refuses importable articles whose body has {{待Ryan确认}} or TBD, naming file and line', () => {
  for (const [name, word] of [['placeholder', '{{待Ryan确认}}'], ['tbd', 'TBD']] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'sanity-guard-'));
    try {
      mkdirSync(join(dir, 'articles'));
      const md = `---\ntitle: "Guard"\nslug: guard-${name}\nlocale: en\nstatus: draft TBD\nmeta_description: "x"\n---\n\n> note TBD {{待Ryan确认}}\n\n# Guard\n\nLead time is ${word}.\n`;
      writeFileSync(join(dir, 'articles', `guard-${name}.md`), md);
      const out = join(dir, 'import.ndjson');
      const r = spawnSync('python3', ['docs/content/sanity-import/build.py', dir, '--out', out], { encoding: 'utf8' });
      assert.notEqual(r.status, 0, `${name}: build.py should refuse`);
      assert.match(r.stderr, new RegExp(`guard-${name}\\.md:13: `), r.stderr);
      assert.doesNotMatch(r.stderr, /:(5|9): /, 'front matter and > notes are not checked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('internal links: import: false articles get no links; flipping them importable brings the links back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkmap-'));
  try {
    mkdirSync(join(dir, 'articles'));
    for (const f of readdirSync('docs/content/articles')) copyFileSync(join('docs/content/articles', f), join(dir, 'articles', f));
    const gift = '/ru/articles/korporativnye-podarki-upakovka-s-logotipom';
    const run = () => {
      const r = spawnSync('python3', ['docs/content/sanity-import/linkmap.py', dir, '--out', dir], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(join(dir, 'internal-links.json'), 'utf8')).links as { from: string; to: string; kind: string }[];
    };
    const held = run();
    assert.equal(held.filter((x) => x.from === gift || x.to === gift).length, 0, 'import: false article must not be linked');
    assert.equal(held.filter((x) => x.to.includes('/articles/')).length, 0);

    // Flip the RU gift article to importable (front matter flag off, placeholders filled) -> links return automatically.
    const p = join(dir, 'articles', 'korporativnye-podarki-upakovka-s-logotipom.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^import: false\n/m, '').replaceAll('{{待Ryan确认}}', 'X'));
    const live = run();
    assert.equal(live.filter((x) => x.kind === 'category→article' && x.to === gift).length, 3);
    assert.equal(live.filter((x) => x.kind === 'article→category' && x.from === gift).length, 3);

    // build.py rebuilds the kept product docs' link sections from that map: "Полезные статьи" comes back too.
    const out = join(dir, 'import.ndjson');
    const b = spawnSync('python3', ['docs/content/sanity-import/build.py', dir, '--out', out, '--links', join(dir, 'internal-links.json')], { encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
    const docs = readFileSync(out, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    const linked = docs.filter((d) => d._type === 'product' && JSON.stringify(d).includes(gift)).map((d) => d._id).sort();
    assert.deepEqual(linked, ['product-christmas-merchandise', 'product-gift-boxes', 'product-wine-boxes']);
    assert.ok(docs.some((d) => d._id === 'article-corporate-gift-packaging-planning-guide'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanity-import: import.ndjson has no links to articles it does not contain', () => {
  const docs = readFileSync('docs/content/sanity-import/import.ndjson', 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  const have = new Set(docs.filter((d) => d._type === 'article').flatMap((d) => Object.entries(d.slug).map(([l, s]) => `/${l}/articles/${(s as { current: string }).current}`)));
  const refs = docs.flatMap((d) => JSON.stringify(d).match(/\/(en|ru)\/articles\/[a-z0-9-]+/g) ?? []);
  assert.deepEqual(refs.filter((r) => !have.has(r)), []);
});
