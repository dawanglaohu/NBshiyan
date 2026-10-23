import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lintText, fixText, defaultFiles, fileId, sameFile } from '../scripts/lint-ru-yo.mjs';

type Hit = { word: string; fix: string; kind: string; file?: string };

test('ru-yo: flags listed е-words and suggests ё', () => {
  const hits: Hit[] = lintText('Жесткие коробки, черная лента, расчет, объем, еще, четырехклапанные, развертка, истек');
  assert.deepEqual(hits.map((h) => h.fix), ['Жёсткие', 'чёрная', 'расчёт', 'объём', 'ещё', 'четырёхклапанные', 'развёртка', 'истёк']);
});

test('ru-yo: word list only — no blanket е→ё, все/лес/небо untouched, already-ё ok', () => {
  assert.deepEqual(lintText('Принять все, на все позиции, лес, небо, белый, тёмная, зелёной'), []);
  assert.deepEqual(lintText('расчетный счетчик черника'), []); // not in the list, no partial-word matches
});

test('ru-yo: old CTA forms fail; imperative inside a sentence is allowed', () => {
  const k = (t: string) => lintText(t).filter((h: Hit) => h.kind === 'cta').map((h: Hit) => h.word);
  assert.deepEqual(k('"quote": "Запросить цену"'), ['Запросить цену']);
  assert.deepEqual(k('<a class="btn">Запросите расчёт</a>'), ['Запросите расчёт']);
  assert.deepEqual(k('"Запросить расчет"').length, 1);
  assert.deepEqual(k('description: "Печать логотипа. Запросите расчёт."'), []);
  assert.deepEqual(k('"Запросить расчёт"'), []);
});

test('ru-yo: allowlist by file+word and inline ru-yo-ignore', () => {
  assert.equal(lintText('черный', 'a.md', [{ file: 'a.md', word: 'черный' }]).length, 0);
  assert.equal(lintText('черный', 'b.md', [{ file: 'a.md', word: 'черный' }]).length, 1);
  assert.equal(lintText('черный // ru-yo-ignore').length, 0);
});

test('ru-yo: fixText keeps case and ignored lines', () => {
  assert.equal(fixText('Черная и черная\nеще // ru-yo-ignore'), 'Чёрная и чёрная\nеще // ru-yo-ignore');
});

test('ru-yo: repo Russian copy is clean; optional dirs are skipped', () => {
  const files: string[] = defaultFiles();
  assert.ok(files.length > 1);
  assert.ok(files.some((f) => f.endsWith('messages/ru.json')));
  assert.ok(files.some((f) => f.endsWith('docs/seo-category-meta.md')));
  assert.ok(files.some((f) => f.endsWith('src/lib/seo/categoryMeta.ts')));
  assert.ok(files.some((f) => f.includes('docs/content/') && !f.includes('ru-proofreading')));
  if (!existsSync('src/lib/server/email')) assert.ok(!files.some((f) => fileId(f).includes('server/email')));
  const hits = files.flatMap((f) => lintText(readFileSync(f, 'utf8'), f));
  assert.deepEqual(hits, []);
});

test('default scan skips proofreading sheets and design mock-ups', async () => {
  const { EXCLUDE, fileId: id } = await import('../scripts/lint-ru-yo.mjs');
  const skipped = (p: string) => EXCLUDE.some((re: RegExp) => re.test(id(p)));
  assert.ok(skipped('/w/docs/content/ru-proofreading.md'));
  assert.ok(skipped('\\w\\docs\\content\\ru-proofreading.md'));
  assert.ok(skipped('/w/design/error-pages.html'));
  assert.ok(skipped('\\w\\design\\error-pages.html'));
  assert.ok(!skipped('/w/docs/content/articles/a.md'));
  assert.ok(!skipped('\\w\\docs\\content\\articles\\a.md'));
  assert.ok(!skipped('/w/messages/ru.json'));
  assert.ok(!skipped('\\w\\messages\\ru.json'));
});

test('ru-yo: slash and backslash name one file; a real bad file is flagged', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ru-yo-id-'));
  try {
    const badNative = path.join(root, 'docs', 'content', 'bad-yo.md');
    const proofNative = path.join(root, 'docs', 'content', 'ru-proofreading.md');
    const cleanNative = path.join(root, 'docs', 'content', 'articles', 'a.md');
    const messages = path.join(root, 'messages', 'ru.json');
    const seoMeta = path.join(root, 'docs', 'seo-category-meta.md');
    const categoryMeta = path.join(root, 'src', 'lib', 'seo', 'categoryMeta.ts');
    mkdirSync(path.dirname(badNative), { recursive: true });
    mkdirSync(path.dirname(cleanNative), { recursive: true });
    mkdirSync(path.dirname(messages), { recursive: true });
    mkdirSync(path.dirname(categoryMeta), { recursive: true });
    writeFileSync(badNative, 'черный\n');
    writeFileSync(proofNative, 'расчет\n');
    writeFileSync(cleanNative, 'белый\n');
    writeFileSync(messages, '{}\n');
    writeFileSync(seoMeta, 'белый\n');
    writeFileSync(categoryMeta, 'export const meta = 1;\n');

    const badSlash = 'docs/content/bad-yo.md';
    const badBack = 'docs\\content\\bad-yo.md';
    assert.equal(fileId(badBack), badSlash);
    assert.ok(sameFile(badSlash, badBack));
    assert.equal(sameFile('', badSlash), false);
    assert.equal(sameFile(badSlash, 'docs/content/other.md'), false);
    assert.equal(readFileSync(badNative, 'utf8'), readFileSync(fileId(badNative), 'utf8'));

    assert.deepEqual(defaultFiles(path.join(root, 'missing-cwd')), []);
    const files = defaultFiles(root);
    const ids = files.map((f) => fileId(f));
    assert.ok(files.length >= 5);
    assert.equal(ids.filter((f) => f.endsWith(badSlash)).length, 1);
    assert.ok(ids.some((f) => f.endsWith('messages/ru.json')));
    assert.ok(ids.some((f) => f.endsWith('docs/seo-category-meta.md')));
    assert.ok(ids.some((f) => f.endsWith('src/lib/seo/categoryMeta.ts')));
    assert.ok(ids.some((f) => f.endsWith('docs/content/articles/a.md')));
    assert.ok(!ids.some((f) => f.includes('ru-proofreading')));

    const badFile = files.find((f) => fileId(f).endsWith(badSlash));
    assert.ok(badFile);
    assert.deepEqual(lintText('', badBack), []);
    const hits = lintText(readFileSync(badFile, 'utf8'), badBack);
    assert.ok(hits.some((h) => h.word.toLowerCase() === 'черный'));
    assert.ok(hits.every((h) => h.file === badSlash));
    assert.equal(lintText(readFileSync(badFile, 'utf8'), badBack, [{ file: badSlash, word: 'черный' }]).length, 0);
    assert.equal(lintText(readFileSync(badFile, 'utf8'), badSlash, [{ file: badBack, word: 'черный' }]).length, 0);
    assert.equal(lintText(readFileSync(badFile, 'utf8'), 'other.md', [{ file: badSlash, word: 'черный' }]).length, 1);

    const scanned = files.flatMap((f) => lintText(readFileSync(f, 'utf8'), f));
    assert.ok(scanned.some((h) => h.word.toLowerCase() === 'черный'));
    assert.ok(!scanned.some((h) => h.word.toLowerCase() === 'расчет'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ru-yo cli reports a real bad file for either separator and accepts clean copy', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ru-yo-cli-'));
  try {
    const bad = path.join(root, 'bad-yo.md');
    const clean = path.join(root, 'clean.md');
    writeFileSync(bad, 'черный\n');
    writeFileSync(clean, 'белый\n');
    const script = path.join(process.cwd(), 'scripts', 'lint-ru-yo.mjs');
    const run = (file: string) => spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    const flagged = run(fileId(bad));
    assert.notEqual(flagged.status, 0);
    assert.match(flagged.stderr, /черный/);
    assert.match(flagged.stderr, /bad-yo\.md/);
    const native = run(bad);
    assert.notEqual(native.status, 0);
    assert.match(native.stderr, /черный/);
    if (process.platform === 'win32') {
      const back = run(fileId(bad).split('/').join('\\'));
      assert.notEqual(back.status, 0);
      assert.match(back.stderr, /черный/);
    }
    const ok = run(fileId(clean));
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /lint:ru-yo: ok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
