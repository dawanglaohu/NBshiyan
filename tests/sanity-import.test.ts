// Regenerating the Sanity import from the sources must reproduce the committed file byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
