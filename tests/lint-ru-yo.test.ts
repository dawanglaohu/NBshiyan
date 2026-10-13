import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
// @ts-expect-error plain .mjs script without types
import { lintText, fixText, defaultFiles } from '../scripts/lint-ru-yo.mjs';

type Hit = { word: string; fix: string; kind: string };

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
  assert.ok(files.some((f) => f.endsWith('messages/ru.json')));
  if (!existsSync('src/lib/server/email')) assert.ok(!files.some((f) => f.includes('server/email')));
  const hits = files.flatMap((f) => lintText(readFileSync(f, 'utf8'), f));
  assert.deepEqual(hits, []);
});
