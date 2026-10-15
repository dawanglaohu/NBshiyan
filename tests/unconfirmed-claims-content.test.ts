// Guard: unconfirmed claims stay out of content sources and generated imports (docs/content/**, incl. sanity-import).
// Same patterns as tests/unconfirmed-claims.test.ts on seo/yo-unification (F19–F22), plus compostable/biodegradable (F15/F17).
// Not scanned: files that quote the claims on purpose (Ryan fact sheet, ru-proofreading sheets).
// In Markdown, editorial notes ("> …") and research sections (Keywords / Article outlines / Internal links) are skipped:
// they are never published (build.py also drops "> " lines and only imports the landing copy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const CONTENT_CLAIMS: RegExp[] = [
  // reply/support-time promises and 24/7 only; «за» as a whole word (a bare «за» hits «запросу»)
  /(reply|respond|response|get back|within|support|ответ\S*|в течение|поддержк\S*|(?<![а-яё])за(?![а-яё]))[^.\n]{0,30}24[\s-]*(hours?|h\b|час)/i,
  /24[\s-]*(hours?|h\b|час\S*)[^.\n]{0,20}(support|reply|response|turnaround|поддержк|ответ)/i,
  /24\s*\/\s*7|круглосуточн/i,
  // specific lead-time figures (fact sheet Q2/Q3): '15-day lead time', 'production 20–25 days', «срок 15 дней», «за 15 дней».
  // Context-bound so privacy/retention durations (after 180 days, через 30 дней, 2 years) pass; stops at '(' so «образцов (раз в 30 дней)» passes.
  /\b\d+\s*(?:[-–]\s*\d+\s*)?-?\s*(?:business[-\s]|working[-\s])?(?:days?|weeks?)\s+(?:lead[-\s]?time|turnaround|production|delivery|shipping|dispatch)|(?:lead[-\s]?times?|turnaround|production|delivery|ship(?:ping|s)?|dispatch|ready|samples?|proofs?)[^.\n()]{0,25}?\b\d+\s*(?:[-–]\s*\d+\s*)?(?:business\s+|working\s+)?(?:days?|weeks?)\b|\b\d+\s*[-–]\s*\d+\s*(?:business\s+|working\s+)?(?:days|weeks)\b/i,
  /(?:срок\S*|производств\S*|изготовлен\S*|доставк\S*|отгрузк\S*|образц\S*|образец|готов\S*)[^.\n()]{0,25}?\d+\s*(?:[-–]\s*\d+\s*)?(?:рабоч\S*\s+)?(?:дн|недел)|(?<![а-яё])за\s*\d+\s*(?:[-–]\s*\d+\s*)?(?:рабоч\S*\s+)?(?:дн|недел)|\d+\s*[-–]\s*\d+\s*(?:рабоч\S*\s+)?(?:дн|недел)/i,
  // MOQ figures (fact sheet Q1)
  /\bMOQ\b[^.\n]{0,15}\d|min(imum)?\.?\s+order(\s+quantity)?[^.\n]{0,15}\d|\bfrom\s+\d[\d,.\s]*\s*(pcs|pieces|units)\b/i,
  /(?<![а-яё])от\s*\d[\d\s\u00a0\u202f]*\s*(шт|экз)|минимальн\S*\s+(тираж|заказ|парти)\S*[^.\n]{0,15}\d/i,
  /factory[-\s]direct/i,
  /food[-\s]?(safe|grade|contact)/i,
  // RU food-contact claims; claim-shaped so keyword research such as «упаковка для пищевых продуктов» (industries.md) passes
  /пищев\S*\s+(картон|бумаг|материал|краск|сырь|покрыт|допуск)|(контакт\S*|соприкосновен\S*)\s+с\s+пищ/i,
  /\bPLA\b/,
  /пищев\S*\s+краск/i,
  /samples?\s+(are\s+)?free|free\s+(of\s+charge\s+)?samples?/i,
  /бесплатн\S*\s+образц|образц\S*\s+бесплатн/i,
  /прям\S*\s+поставк\S*\s+с\s+фабрик/i,
  /plastic[-\s]free/i,
  /без\s+пластик|вместо\s+пластик/i,
  /water[-\s]based/i,
  /водн\S*\s+(покрыти|основ)|на\s+водной\s+основе/i,
  /\bFDA\b/,
  /\bEPS\b|polystyrene|styrofoam|пенопласт|полистирол/i,
  /heidelberg|хайдельберг|гейдельберг/i,
  /for\s+export|export\s+worldwide|worldwide\s+export|export\s+to\s+\d+\s+countries|экспорт/i,
  /compostab|biodegradab|компостируем|биоразлагаем/i,
];

export const EXCLUDED_FILES = [/^ryan-fact-sheet\.md$/, /^ru-proofreading[^/]*\.md$/];
export const isExcluded = (file: string) => EXCLUDED_FILES.some((re) => re.test(basename(file)));
const SKIP_SECTION = /^##\s+(Keywords|Article outlines|Internal links)\b/i;

export function claimLines(file: string, text: string): string[] {
  const md = file.endsWith('.md');
  let skip = false;
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (md && /^##\s/.test(line)) skip = SKIP_SECTION.test(line);
    if (md && (skip || line.trimStart().startsWith('>'))) return;
    for (const re of CONTENT_CLAIMS) if (re.test(line)) hits.push(`${file}:${i + 1} ${re}`);
  });
  return hits;
}

function walk(p: string, out: string[] = []): string[] {
  if (!existsSync(p)) return out;
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f), out);
  else if (/\.(md|json|ndjson|py|ts|txt)$/.test(p) && !isExcluded(p)) out.push(p);
  return out;
}

test('docs/content and sanity-import contain no unconfirmed claims', () => {
  const files = walk('docs/content');
  assert.ok(files.length > 0);
  assert.deepEqual(files.flatMap((f) => claimLines(f, readFileSync(f, 'utf8'))), []);
});

test('fact sheet and proofreading sheets are excluded; other files are not', () => {
  assert.ok(isExcluded('docs/content/ryan-fact-sheet.md'));
  assert.ok(isExcluded('docs/content/ru-proofreading.md'));
  assert.ok(!isExcluded('docs/content/eco-paper-cups.md'));
  assert.ok(!isExcluded('docs/content/sanity-import/import.ndjson'));
  assert.ok(!walk('docs/content').some((f) => /ryan-fact-sheet|ru-proofreading/.test(f)));
});

test('guard catches claims in published copy but not in notes or keyword research', () => {
  assert.equal(claimLines('a.md', '- **Plastic-free** — Replaces EPS foam.').length, 2);
  assert.equal(claimLines('a.ndjson', '{"text":"Экспортная доставка"}').length, 1);
  assert.equal(claimLines('a.md', '> ⚠️ compostable 已去掉').length, 0);
  assert.equal(claimLines('a.md', 'Logos are deleted 24 hours after upload.').length, 0);
  assert.equal(claimLines('a.md', 'Логотипы удаляются через 24 часа после загрузки.').length, 0);
  assert.equal(claimLines('a.md', 'We reply within 24 hours.').length, 1);
  assert.equal(claimLines('a.md', 'Ответим в течение 24 часов.').length, 1);
  for (const bad of ['24h support', '24-hour support', 'ответ за 24 часа', 'поддержка 24 часа', '24/7 support', 'круглосуточная поддержка'])
    assert.ok(claimLines('a.md', bad).length > 0, bad);
  for (const bad of ['MOQ from 500 pcs', 'Minimum order 1,000 pieces', 'Тираж от 1 000 шт.', 'минимальный тираж 300'])
    assert.ok(claimLines('a.md', bad).length > 0, bad);
  assert.equal(claimLines('a.md', '| MOQ | **TBD（待 Ryan 提供）** |').length, 0);
  assert.equal(claimLines('a.md', 'Тираж уточняем под заказ').length, 0);
  for (const bad of ['15-day lead time', 'production 20–25 days', 'срок 15 дней', 'за 15 дней'])
    assert.ok(claimLines('a.md', bad).length > 0, bad);
  assert.equal(claimLines('a.md', '| Sample lead time | **TBD（待 Ryan 提供）** |').length, 0);
  assert.equal(claimLines('a.md', 'Shared designs expire after 180 days and are deleted 90 days later.').length, 0);
  assert.equal(claimLines('a.md', 'Логотипы, не прикреплённые к запросу, удаляются через 24 часа после загрузки, не позднее чем через 48 часов.').length, 0);
  assert.equal(claimLines('a.md', '## Keywords\n- PLA paper cups supplier\n## RU — Текст\n- без пластика').length, 1);
});

test('food-contact patterns: claims are flagged, keyword research and neutral wording pass', () => {
  const hit = (t: string) => CONTENT_CLAIMS.some((re) => re.test(t));
  for (const t of ['Food-grade paperboard', 'food safe inks', 'food-contact inks', 'FOODGRADE', 'Пищевой картон и краски', 'красками для контакта с пищевыми продуктами', 'для контакта с пищей'])
    assert.ok(hit(t), t);
  for (const t of ['упаковка для пищевых продуктов', 'food packaging manufacturer', 'Paperboard and inks.', 'Картон и краски.', 'Food & beverage'])
    assert.ok(!hit(t), t);
});
