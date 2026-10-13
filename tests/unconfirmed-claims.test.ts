// Guard: unconfirmed claims stay hidden until Ryan confirms (ru-proofreading F19/F20/F21/F22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN: RegExp[] = [
  /24\s*(hours?|h\b|час)/i,
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
