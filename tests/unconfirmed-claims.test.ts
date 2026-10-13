// Guard: unconfirmed claims stay hidden until Ryan confirms (ru-proofreading F19/F20).
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
  /прям\S*\s+поставк\S*\s+с\s+фабрик/i,
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
