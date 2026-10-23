// Regenerating the Sanity import from the sources must reproduce the committed file byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SANITY_IMPORT_PYTHON is one executable path or command name, not a shell line.
// A set value, including an empty string, is used as-is. Exit 9009 is the WindowsApps
// alias: it is a startup failure and must not satisfy a content refusal.
const PYTHON_ENV = 'SANITY_IMPORT_PYTHON';
const PROBE = 'import sys; raise SystemExit(0 if sys.version_info[0] >= 3 else 1)';

type PythonLaunch = { command: string; args: string[]; display: string };
type PythonOutput = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error };

let cachedLaunch: PythonLaunch | undefined;

function pythonEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

function spawnOptions() {
  return { encoding: 'utf8' as const, env: pythonEnv(), timeout: 60_000, windowsHide: true };
}

function defaultCandidates(): PythonLaunch[] {
  if (process.platform === 'win32') {
    return [
      { command: 'python', args: [], display: 'python' },
      { command: 'py', args: ['-3'], display: 'py -3' },
      { command: 'python3', args: [], display: 'python3' },
    ];
  }
  return [
    { command: 'python3', args: [], display: 'python3' },
    { command: 'python', args: [], display: 'python' },
  ];
}

function asOutput(result: SpawnSyncReturns<string>): PythonOutput {
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function startupFailure(launch: PythonLaunch, output: PythonOutput): string | undefined {
  if (!output.error && output.status !== null && output.status !== 9009) return undefined;
  const exit = output.status === null ? 'none' : String(output.status);
  const lines = [
    `Python interpreter failed to start (${launch.display}).`,
    `exit ${exit} is not a pass.`,
  ];
  if (output.signal) lines.push(`signal ${output.signal}`);
  if (output.error) lines.push(`spawn error: ${output.error.message}`);
  lines.push(`stderr:${output.stderr ? `\n${output.stderr}` : ''}`);
  return lines.join('\n');
}

function rejectStartupFailure(launch: PythonLaunch, output: PythonOutput): void {
  const message = startupFailure(launch, output);
  if (message) assert.fail(message);
}

function launchFrom(raw: string): PythonLaunch {
  const command = raw.trim();
  return { command, args: [], display: command || `(empty ${PYTHON_ENV})` };
}

function resolvePython(override?: string): PythonLaunch {
  if (override !== undefined) return launchFrom(override);
  const configured = process.env[PYTHON_ENV];
  if (configured !== undefined) return launchFrom(configured);
  if (cachedLaunch) return cachedLaunch;
  const failures: string[] = [];
  for (const launch of defaultCandidates()) {
    const output = asOutput(spawnSync(launch.command, [...launch.args, '-c', PROBE], spawnOptions()));
    const failed = startupFailure(launch, output);
    if (failed) {
      failures.push(failed);
      continue;
    }
    if (output.status !== 0) {
      failures.push(`Python probe exited ${output.status} (${launch.display}).\nstderr:${output.stderr ? `\n${output.stderr}` : ''}`);
      continue;
    }
    cachedLaunch = launch;
    return launch;
  }
  assert.fail(`No usable Python interpreter for sanity-import tests.\n${failures.join('\n---\n')}`);
}

function spawnPython(scriptArgs: string[], override?: string): PythonOutput {
  const launch = resolvePython(override);
  if (!launch.command) rejectStartupFailure(launch, { status: null, signal: null, stdout: '', stderr: '' });
  const output = asOutput(spawnSync(launch.command, [...launch.args, ...scriptArgs], spawnOptions()));
  rejectStartupFailure(launch, output);
  return output;
}

test('sanity-import: build.py output matches committed import.ndjson', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sanity-import-'));
  try {
    const out = join(dir, 'import.ndjson');
    const r = spawnPython(['docs/content/sanity-import/build.py', '--out', out]);
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
    const r = spawnPython(['docs/content/sanity-import/build.py', dir, '--out', out]);
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
      const r = spawnPython(['docs/content/sanity-import/build.py', dir, '--out', out]);
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
      const r = spawnPython(['docs/content/sanity-import/linkmap.py', dir, '--out', dir]);
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(join(dir, 'internal-links.json'), 'utf8')).links as { from: string; to: string; kind: string }[];
    };
    const held = run();
    assert.equal(held.filter((x) => x.from === gift || x.to === gift).length, 0, 'import: false article must not be linked');
    assert.equal(held.filter((x) => x.to.includes('/articles/')).length, 0);

    // Flip the RU gift article to importable (front matter flag off, placeholders filled) -> links return automatically.
    // The checked-out article may use CRLF; `\r?` still matches an LF checkout.
    const p = join(dir, 'articles', 'korporativnye-podarki-upakovka-s-logotipom.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^import: false\r?\n/m, '').replaceAll('{{待Ryan确认}}', 'X'));
    const live = run();
    assert.equal(live.filter((x) => x.kind === 'category→article' && x.to === gift).length, 3);
    assert.equal(live.filter((x) => x.kind === 'article→category' && x.from === gift).length, 3);

    // build.py rebuilds the kept product docs' link sections from that map: "Полезные статьи" comes back too.
    const out = join(dir, 'import.ndjson');
    const b = spawnPython(['docs/content/sanity-import/build.py', dir, '--out', out, '--links', join(dir, 'internal-links.json')]);
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

test('sanity-import: committed product docs carry no TBD or {{待Ryan确认}}', () => {
  const docs = readFileSync('docs/content/sanity-import/import.ndjson', 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  const bad = docs.filter((d) => d._type === 'product' && /\{\{待Ryan确认\}\}|\bTBD\b/.test(JSON.stringify(d))).map((d) => d._id);
  assert.deepEqual(bad, []);
});

test('sanity-import: build.py refuses product docs with TBD or {{待Ryan确认}}, naming doc and line', () => {
  for (const [name, word] of [['tbd', 'срок TBD'], ['placeholder', '{{待Ryan确认}}']] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'sanity-prod-guard-'));
    try {
      // Kept-product path (no landing sources): a repo-shaped copy with line 3 of import.ndjson poisoned.
      const content = join(dir, 'docs/content');
      const sib = join(content, 'sanity-import');
      mkdirSync(join(content, 'articles'), { recursive: true });
      mkdirSync(sib);
      mkdirSync(join(dir, 'src/lib/seo'), { recursive: true });
      copyFileSync('src/lib/seo/categoryMeta.ts', join(dir, 'src/lib/seo/categoryMeta.ts'));
      copyFileSync('docs/content/sanity-import/build.py', join(sib, 'build.py'));
      copyFileSync('docs/content/internal-links.json', join(content, 'internal-links.json'));
      const lines = readFileSync('docs/content/sanity-import/import.ndjson', 'utf8').split('\n');
      const d = JSON.parse(lines[2]);
      d.body.ru[0].children[0].text += ` ${word}`;
      lines[2] = JSON.stringify(d);
      writeFileSync(join(sib, 'import.ndjson'), lines.join('\n'));
      const r = spawnPython([join(sib, 'build.py'), content, '--out', join(dir, 'out.ndjson')]);
      assert.notEqual(r.status, 0, `${name}: build.py should refuse`);
      assert.match(r.stderr, new RegExp(`import\\.ndjson:3: ${d._id} body\\.ru\\[0\\]`), r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Landing-source path: file:line inside the published EN section; '> ' notes and the FAQ are not checked.
  const dir = mkdtempSync(join(tmpdir(), 'sanity-landing-guard-'));
  try {
    mkdirSync(join(dir, 'articles'));
    writeFileSync(join(dir, 'custom-x.md'), '# X\n内部 key `gift-boxes`\n## EN — Landing copy\n> note TBD\n- Lead time: TBD\n### H1: X\nIntro.\n### FAQ\n- TBD\n## RU — Текст посадочной страницы\n### H1: X\nВступление.\n### FAQ\n');
    const r = spawnPython(['docs/content/sanity-import/build.py', dir, '--out', join(dir, 'out.ndjson')]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /custom-x\.md:5: - Lead time: TBD/, r.stderr);
    assert.doesNotMatch(r.stderr, /custom-x\.md:(4|9):/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('linkmap.py: --meta defaults to src/lib/seo/categoryMeta.ts; missing, unreadable or retired compostable slug exits non-zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkmap-meta-'));
  try {
    mkdirSync(join(dir, 'articles'));
    for (const f of readdirSync('docs/content/articles')) copyFileSync(join('docs/content/articles', f), join(dir, 'articles', f));
    const run = (...extra: string[]) => spawnPython(['docs/content/sanity-import/linkmap.py', dir, '--out', dir, ...extra]);
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(readFileSync(join(dir, 'internal-links.json'), 'utf8'), readFileSync('docs/content/internal-links.json', 'utf8'), 'default meta reproduces committed map');
    const missing = run('--meta', join(dir, 'nope.ts'));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /cannot read category meta/);
    const unreadable = run('--meta', dir); // a directory cannot be read as a file
    assert.notEqual(unreadable.status, 0);
    assert.match(unreadable.stderr, /cannot read category meta/);
    const stale = join(dir, 'stale.ts');
    writeFileSync(stale, readFileSync('src/lib/seo/categoryMeta.ts', 'utf8').replace("en: { slug: 'custom-paper-cups'", "en: { slug: 'compostable-paper-cups'"));
    const r = run('--meta', stale);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /retired.*compostable-paper-cups/);
    writeFileSync(stale, readFileSync('src/lib/seo/categoryMeta.ts', 'utf8').replace("en: { slug: 'custom-paper-cups'", "en: { slug: 'eco-compostable-cups'"));
    assert.notEqual(run('--meta', stale).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanity-import: build.py refuses product docs with food-contact claims (EN + RU)', () => {
  for (const word of ['Food-grade board', 'food safe inks', 'FOOD-CONTACT', 'пищевой картон']) {
    const dir = mkdtempSync(join(tmpdir(), 'sanity-food-'));
    try {
      const content = join(dir, 'docs/content');
      const sib = join(content, 'sanity-import');
      mkdirSync(join(content, 'articles'), { recursive: true });
      mkdirSync(sib);
      mkdirSync(join(dir, 'src/lib/seo'), { recursive: true });
      copyFileSync('src/lib/seo/categoryMeta.ts', join(dir, 'src/lib/seo/categoryMeta.ts'));
      copyFileSync('docs/content/sanity-import/build.py', join(sib, 'build.py'));
      copyFileSync('docs/content/internal-links.json', join(content, 'internal-links.json'));
      const lines = readFileSync('docs/content/sanity-import/import.ndjson', 'utf8').split('\n');
      const d = JSON.parse(lines[0]);
      d.body.en[1].children[1].text += ` ${word}`;
      lines[0] = JSON.stringify(d);
      writeFileSync(join(sib, 'import.ndjson'), lines.join('\n'));
      const r = spawnPython([join(sib, 'build.py'), content, '--out', join(dir, 'out.ndjson')]);
      assert.notEqual(r.status, 0, word);
      assert.match(r.stderr, new RegExp(`${d._id}: unconfirmed food-use claim`), r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('sanity-import: exit 9009 is not a pass and stderr is kept', () => {
  // POSIX wait status keeps only 8 bits, so a live exit 9009 cannot be asserted on Linux.
  // The WindowsApps alias still reports 9009 to spawnSync; this is that result.
  const output: PythonOutput = { status: 9009, signal: null, stdout: '', stderr: 'alias-stderr-kept' };
  assert.throws(() => rejectStartupFailure({ command: 'python3', args: [], display: 'python3' }, output), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /9009/);
    assert.match(err.message, /not a pass/);
    assert.match(err.message, /stderr:/);
    assert.match(err.message, /alias-stderr-kept/);
    return true;
  });
});

test('sanity-import: an empty or missing interpreter fails closed and keeps stderr', () => {
  assert.throws(() => spawnPython(['-c', 'print(1)'], '   '), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /empty SANITY_IMPORT_PYTHON/);
    assert.match(err.message, /not a pass/);
    assert.match(err.message, /stderr:/);
    return true;
  });
  const missing = join(tmpdir(), 'sanity-import-missing-python.exe');
  assert.throws(() => spawnPython(['-c', 'print(1)'], missing), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /failed to start/);
    assert.match(err.message, /not a pass/);
    assert.match(err.message, /stderr:/);
    return true;
  });
});

test('sanity-import: the selected interpreter runs again instead of replaying a pass', () => {
  const once = spawnPython(['-c', 'import sys; print(sys.version_info[0])']);
  const twice = spawnPython(['-c', 'import sys; print(sys.version_info[0])']);
  assert.equal(once.status, 0, once.stderr);
  assert.equal(twice.status, 0, twice.stderr);
  assert.equal(once.stdout.trim(), '3');
  assert.equal(twice.stdout.trim(), '3');
});

test('sanity-import: the Windows python3 alias is not treated as a pass', { skip: process.platform === 'win32' ? false : 'only the WindowsApps python3 alias exits 9009' }, () => {
  assert.throws(() => spawnPython(['-c', 'print(1)'], 'python3'), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /9009/);
    assert.match(err.message, /not a pass/);
    assert.match(err.message, /stderr:/);
    return true;
  });
});
