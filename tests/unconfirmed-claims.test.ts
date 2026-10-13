// Guard: unconfirmed claims stay hidden until Ryan confirms (ru-proofreading F19/F20/F21/F22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN: RegExp[] = [
  // reply-time promises only (F19); retention facts like 'deleted 24 hours after upload' are allowed
  /(reply|respond|response|get back|within|ответ\S*|в течение)[^.\n]{0,30}24\s*(hours?|h\b|час)/i,
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

test('24h rule blocks reply-time promises only', () => {
  const re = FORBIDDEN[0];
  for (const ok of ['Logos not attached to an inquiry are deleted 24 hours after upload (at most 48 hours).',
    'Логотипы, не привязанные к запросу, удаляются через 24 часа после загрузки (не позднее 48 часов).'])
    assert.ok(!re.test(ok), ok);
  for (const bad of ['Tell us what you need — we reply within 24 hours.', 'Our team will get back to you within 24 hours.',
    'Расскажите, что вам нужно, — ответим в течение 24 часов.', 'Наш менеджер свяжется с вами в течение 24 часов.'])
    assert.ok(re.test(bad), bad);
});
