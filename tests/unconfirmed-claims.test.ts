// Guard: unconfirmed claims stay hidden until Ryan confirms (ru-proofreading F19/F20/F21/F22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN: RegExp[] = [
  // reply/support-time promises only (F19); retention facts like 'deleted 24 hours after upload' are allowed.
  // «за» is matched as a whole word only: a bare «за» also hits «запросу» in the RU privacy text.
  /(reply|respond|response|get back|within|support|ответ\S*|в течение|поддержк\S*|(?<![а-яё])за(?![а-яё]))[^.\n]{0,30}24[\s-]*(hours?|h\b|час)/i,
  /24[\s-]*(hours?|h\b|час\S*)[^.\n]{0,20}(support|reply|response|turnaround|поддержк|ответ)/i,
  /24\s*\/\s*7|круглосуточн/i,
  // specific lead-time figures (fact sheet Q2/Q3): '15-day lead time', 'production 20–25 days', «срок 15 дней», «за 15 дней».
  // Context-bound so privacy/retention durations (after 180 days, через 30 дней, 2 years) pass; stops at '(' so «образцов (раз в 30 дней)» passes.
  /\b\d+\s*(?:[-–]\s*\d+\s*)?-?\s*(?:business[-\s]|working[-\s])?(?:days?|weeks?)\s+(?:lead[-\s]?time|turnaround|production|delivery|shipping|dispatch)|(?:lead[-\s]?times?|turnaround|production|delivery|ship(?:ping|s)?|dispatch|ready|samples?|proofs?)[^.\n()]{0,25}?\b\d+\s*(?:[-–]\s*\d+\s*)?(?:business\s+|working\s+)?(?:days?|weeks?)\b|\b\d+\s*[-–]\s*\d+\s*(?:business\s+|working\s+)?(?:days|weeks)\b/i,
  /(?:срок\S*|производств\S*|изготовлен\S*|доставк\S*|отгрузк\S*|образц\S*|образец|готов\S*)[^.\n()]{0,25}?\d+\s*(?:[-–]\s*\d+\s*)?(?:рабоч\S*\s+)?(?:дн|недел)|(?<![а-яё])за\s*\d+\s*(?:[-–]\s*\d+\s*)?(?:рабоч\S*\s+)?(?:дн|недел)|\d+\s*[-–]\s*\d+\s*(?:рабоч\S*\s+)?(?:дн|недел)/i,
  // MOQ figures (fact sheet Q1): «от 500 шт.», 'MOQ from 500 pcs', 'minimum order 1,000'
  /\bMOQ\b[^.\n]{0,15}\d|min(imum)?\.?\s+order(\s+quantity)?[^.\n]{0,15}\d|\bfrom\s+\d[\d,.\s]*\s*(pcs|pieces|units)\b/i,
  /(?<![а-яё])от\s*\d[\d\s\u00a0\u202f]*\s*(шт|экз)|минимальн\S*\s+(тираж|заказ|парти)\S*[^.\n]{0,15}\d/i,
  /factory[-\s]direct/i,
  /food[-\s]safe/i,
  /\bPLA\b/,
  /пищев\S*\s+краск/i,
  /samples?\s+(are\s+)?free|free\s+(of\s+charge\s+)?samples?/i,
  /бесплатн\S*\s+образц|образц\S*\s+бесплатн/i,
  /прям\S*\s+поставк\S*\s+с\s+фабрик/i,
  // F22: plastic-free / water-based coating / FDA / EPS-replacement claims
  /plastic[-\s]free/i,
  /без\s+пластик|вместо\s+пластик/i,
  /water[-\s]based/i,
  /водн\S*\s+(покрыти|основ)|на\s+водной\s+основе/i,
  /\bFDA\b/,
  /\bEPS\b|polystyrene|styrofoam|пенопласт|полистирол/i,
  // equipment brand / export claims (offset-printing): Heidelberg, for export, export worldwide
  /heidelberg|хайдельберг|гейдельберг/i,
  /for\s+export|export\s+worldwide|worldwide\s+export|export\s+to\s+\d+\s+countries|экспорт/i,
];
const files = [
  ...readdirSync('messages').filter((f) => f.endsWith('.json')).map((f) => join('messages', f)),
  'src/lib/seo/categoryMeta.ts',
];
for (const file of files) {
  test(`no unconfirmed claims in ${file}`, () => {
    const src = readFileSync(file, 'utf8');
    for (const re of FORBIDDEN) assert.ok(!re.test(src), `${file} matches ${re}`);
  });
}

const REPLY_TIME = FORBIDDEN.slice(0, 3);
const replyHit = (t: string) => REPLY_TIME.some((re) => re.test(t));
const strings = (o: unknown): string[] =>
  typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : [];

test('24h rules block reply/support-time promises and 24/7', () => {
  for (const bad of ['24h support', '24-hour support', 'ответ за 24 часа', 'поддержка 24 часа', 'reply within 24 hours',
    'ответим в течение 24 часов', '24/7 support', 'круглосуточная поддержка',
    'Our team will get back to you within 24 hours.', 'Наш менеджер свяжется с вами в течение 24 часов.'])
    assert.ok(replyHit(bad), bad);
});

test('24h rules allow retention facts and the whole privacy page (fix/privacy-page fixtures)', () => {
  for (const ok of ['Logos are deleted 24 hours after upload', 'Логотип удаляется через 24 часа после загрузки'])
    assert.ok(!replyHit(ok), ok);
  for (const l of ['en', 'ru']) {
    const all = strings(JSON.parse(readFileSync(`tests/fixtures/privacy-${l}.json`, 'utf8')).Privacy);
    assert.ok(all.some((t) => /24/.test(t)), `${l} fixture has the 24-hour logo rule`);
    for (const t of all) for (const re of FORBIDDEN) assert.ok(!re.test(t), `${l}: ${re} hits «${t}»`);
  }
});

test('MOQ figures are blocked; neutral quantity wording passes', () => {
  const moq = FORBIDDEN.filter((re) => /MOQ|шт/.test(re.source));
  const hit = (t: string) => moq.some((re) => re.test(t));
  for (const bad of ['MOQ from 500 pcs', 'MOQ: 1,000', 'Minimum order 1,000 pieces', 'from 10,000 pcs', 'Тираж от 500 шт.', 'Тираж от 1 000 шт.', 'минимальный тираж 300'])
    assert.ok(hit(bad), bad);
  for (const ok of ['Quantities confirmed per order', 'Тираж уточняем под заказ', '4–22 oz, single or double wall', 'Up to 4-color flexo or digital print', 'от 2 до 4 недель'])
    assert.ok(!hit(ok), ok);
});

test('lead-time figures are blocked; privacy durations and form options pass', () => {
  const lt = FORBIDDEN.filter((re) => /lead|срок/.test(re.source));
  assert.equal(lt.length, 2);
  const hit = (t: string) => lt.some((re) => re.test(t));
  for (const bad of ['15-day lead time', 'Lead time: 15 days', 'production 20–25 days', 'Samples in 5 days', '5–7 days', 'ships in 2 weeks',
    'за 15 дней', 'срок 15 дней', 'Срок производства — 20 дней', 'образец за 7 рабочих дней', '5–7 дней'])
    assert.ok(hit(bad), bad);
  for (const ok of ['Within 2 weeks', '1–2 months', 'В течение 2 недель', 'Logos are deleted 24 hours after upload, at most 48 hours',
    'Inquiries are anonymized after 2 years', 'inactive for 90 days', 'Сохранённые дизайны истекают через 180 дней'])
    assert.ok(!hit(ok), ok);
});
