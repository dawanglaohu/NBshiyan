#!/usr/bin/env node
// Lint for Russian copy: flags common е-instead-of-ё words and outdated CTA forms.
// Word list, NOT a blanket е→ё rule (все/всё, небо/нёбо etc. are ambiguous and NOT checked automatically).
// Allowlist: put `ru-yo-ignore` on the same line, or add {"file": "...", "word": "..."} to scripts/lint-ru-yo.allow.json.
// Usage: node scripts/lint-ru-yo.mjs [--fix] [files...]
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const L = 'а-яё';
// [е-stem, ё-stem, suffix regex]. Matches whole words, case-insensitive.
export const YO_WORDS = [
  ['расчет', 'расчёт', '(?:|а|у|ом|е|ы|ов|ами|ах|ам)'],
  ['отчет', 'отчёт', '(?:|а|у|ом|е|ы|ов|ами|ах|ам)'],
  ['учет', 'учёт', '(?:|а|у|ом|е)'],
  ['черн', 'чёрн', '(?:ый|ая|ое|ые|ого|ой|ую|ым|ыми|ых|ому)'],
  ['темн', 'тёмн', '(?:ый|ая|ое|ые|ого|ой|ую|ым|ыми|ых|ому)'],
  ['зелен', 'зелён', '(?:ый|ая|ое|ые|ого|ой|ую|ым|ыми|ых|ому)'],
  ['желт', 'жёлт', '(?:ый|ая|ое|ые|ого|ой|ую|ым|ыми|ых|ому)'],
  ['жестк', 'жёстк', '(?:ий|ая|ое|ие|ого|ой|ую|им|ими|их|ому|ость|ости|остью)'],
  ['тверд', 'твёрд', '(?:ый|ая|ое|ые|ого|ой|ую|ым|ыми|ых|ому)'],
  ['легк', 'лёгк', '(?:ий|ая|ое|ие|ого|ой|ую|им|ими|их|ому)'],
  ['четк', 'чётк', '(?:ий|ая|ое|ие|ого|ой|ую|им|ими|их|ому|о|ость|ости)'],
  ['тяжел', 'тяжёл', '(?:ый|ая|ое|ые|ого|ой|ую|ым|ыми|ых|ому)'],
  ['истек', 'истёк', '(?:|ла|ло|ли|ший|шая|шее|шие|шего|шей|шую|шим|ших)'],
  ['объем', 'объём', '(?:|а|у|ом|е|ы|ов|ами|ах|ам|ный|ная|ное|ные|ного|ной|ную|ным|ными|ных)'],
  ['подъем', 'подъём', '(?:|а|у|ом|е|ы|ов)'],
  ['прием', 'приём', '(?:|а|у|ом|е|ы|ов)'],
  ['приемк', 'приёмк', '(?:а|и|е|у|ой)'],
  ['слоев', 'слоёв', '()'],
  ['пленк', 'плёнк', '(?:а|и|е|у|ой|ами|ах)'],
  ['развертк', 'развёртк', '(?:а|и|е|у|ой|ами|ах)'],
  ['трех', 'трёх', '(?:|слойн[' + L + ']*|цветн[' + L + ']*|клапанн[' + L + ']*|сторонн[' + L + ']*)'],
  ['четырех', 'четырёх', '(?:|слойн[' + L + ']*|цветн[' + L + ']*|клапанн[' + L + ']*|сторонн[' + L + ']*)'],
  ['звезд', 'звёзд', '(?:ы|ами|ах)?'],
  ['елк', 'ёлк', '(?:а|и|е|у|ой|ами|ах)'],
  ['елочн', 'ёлочн', '(?:ый|ая|ое|ые|ого|ой|ую|ым|ыми|ых)'],
  ['шелк', 'шёлк', '(?:|а|ом|овый|овая|овое|овые|овой|овую|овым|овых)'],
  ['еще', 'ещё', '()'],
  ['ее', 'её', '()'],
  ['идет', 'идёт', '()'], ['ведет', 'ведёт', '()'], ['дает', 'даёт', '()'], ['берет', 'берёт', '()'],
  ['ждет', 'ждёт', '()'], ['придет', 'придёт', '()'], ['найдет', 'найдёт', '()'], ['займет', 'займёт', '()'],
  ['создает', 'создаёт', '()'], ['передает', 'передаёт', '()'], ['подойдет', 'подойдёт', '()'],
  ['вперед', 'вперёд', '()'],
];
// Old CTA forms. Every Russian CTA must read «Запросить расчёт».
// The imperative «Запросите расчёт.» is allowed inside a sentence (e.g. meta descriptions); it is only flagged
// when it stands alone as a label (a whole string or element text), i.e. when it is used as a CTA.
export const OLD_CTA = [
  /(?<=[>"'«`]\s*)Запросите\s+расч[её]т(?=\s*[<"'»`])/gi,
  /Запросить\s+расчет/gi,
  /Запросит[еь]\s+цену/gi,
];

const yoRe = new RegExp(
  `(?<![${L}])(?:${YO_WORDS.map(([e, , s]) => `${e}${s}`).join('|')})(?![${L}])`, 'gi');

function toYo(word) {
  const low = word.toLowerCase();
  for (const [e, yo, s] of YO_WORDS) {
    if (new RegExp(`^${e}${s}$`, 'i').test(low)) {
      const out = yo + word.slice(e.length);
      return word[0] === word[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out;
    }
  }
  return word;
}

export function lintText(text, file = '', allow = []) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes('ru-yo-ignore')) return;
    for (const m of line.matchAll(yoRe)) {
      if (allow.some((a) => (!a.file || a.file === file) && a.word.toLowerCase() === m[0].toLowerCase())) continue;
      hits.push({ file, line: i + 1, word: m[0], fix: toYo(m[0]), kind: 'yo' });
    }
    for (const re of OLD_CTA) {
      for (const m of line.matchAll(re)) {
        hits.push({ file, line: i + 1, word: m[0], fix: 'Запросить расчёт', kind: 'cta' });
      }
    }
  });
  return hits;
}

export function fixText(text) {
  return text.split('\n').map((l) => (l.includes('ru-yo-ignore') ? l : l.replace(yoRe, toYo))).join('\n');
}

const ROOTS = [
  { path: 'messages/ru.json' },
  { path: 'docs/seo-category-meta.md' },
  { path: 'src/lib/seo/categoryMeta.ts' },
  { path: 'docs/content', ext: /\.(md|json|ts|txt)$/ },
  { path: 'design', ext: /\.html$/ },
  { path: 'src/lib/server/email', ext: /\.(ts|tsx|html|txt)$/ },
];

function walk(p, ext, out) {
  if (!existsSync(p)) return out; // optional dirs (e.g. src/lib/server/email) are skipped gracefully
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f), ext, out);
  else if (!ext || ext.test(p)) out.push(p);
  return out;
}

export function defaultFiles(cwd = process.cwd()) {
  return ROOTS.flatMap((r) => walk(join(cwd, r.path), r.ext, []));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const files = args.filter((a) => a !== '--fix');
  const cwd = process.cwd();
  const allowFile = join(cwd, 'scripts/lint-ru-yo.allow.json');
  const allow = existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, 'utf8')) : [];
  let total = 0;
  for (const abs of files.length ? files : defaultFiles(cwd)) {
    const rel = relative(cwd, abs).split(sep).join('/');
    let text = readFileSync(abs, 'utf8');
    if (fix) { const t = fixText(text); if (t !== text) writeFileSync(abs, t); text = t; }
    for (const h of lintText(text, rel, allow)) {
      total++;
      console.error(`${rel}:${h.line}  ${h.kind === 'cta' ? 'old CTA' : 'е→ё'}  «${h.word}» → «${h.fix}»`);
    }
  }
  if (total) { console.error(`lint:ru-yo: ${total} problem(s)`); process.exit(1); }
  console.log('lint:ru-yo: ok');
}
