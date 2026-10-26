import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';
import {
  ERROR_LINE, ORDINARY_ABSOLUTE_MS, REMEMBERED_ABSOLUTE_MS, USAGE_LINE,
  fillNullHardExpiresAt, runBackfill, type ExecuteDb,
} from '../scripts/backfill-hard-expires-at-lib.mjs';

const POLICY = { ordinaryAbsoluteMs: ORDINARY_ABSOLUTE_MS, absoluteMs: REMEMBERED_ABSOLUTE_MS };

test('backfill script prints two counts and can run again', async () => {
  const lines: string[] = [];
  const errors: string[] = [];
  assert.equal(await runBackfill({
    argv: [],
    backfill: async () => ({ ordinary: 4, remembered: 1 }),
    out: (chunk) => { lines.push(chunk); },
    err: (chunk) => { errors.push(chunk); },
  }), 0);
  assert.deepEqual(lines, ['ordinary=4\nremembered=1\n']);
  assert.deepEqual(errors, []);
  const again: string[] = [];
  const againErrors: string[] = [];
  assert.equal(await runBackfill({
    argv: [],
    backfill: async () => ({ ordinary: 0, remembered: 0 }),
    out: (chunk) => { again.push(chunk); },
    err: (chunk) => { againErrors.push(chunk); },
  }), 0);
  assert.deepEqual(again, ['ordinary=0\nremembered=0\n']);
  assert.deepEqual(againErrors, []);
});

test('backfill script rejects arguments and hides failures', async () => {
  let called = false;
  const errors: string[] = [];
  assert.equal(await runBackfill({
    argv: ['--url'],
    backfill: async () => { called = true; return { ordinary: 1, remembered: 1 }; },
    out: () => { throw new Error('stdout'); },
    err: (chunk) => { errors.push(chunk); },
  }), 2);
  assert.equal(called, false);
  assert.deepEqual(errors, [USAGE_LINE]);
  const lines: string[] = [];
  const hidden: string[] = [];
  assert.equal(await runBackfill({
    argv: [],
    backfill: async () => { throw new Error('postgres://secret@db-host/app user@example.com'); },
    out: (chunk) => { lines.push(chunk); },
    err: (chunk) => { hidden.push(chunk); },
  }), 1);
  assert.deepEqual(lines, []);
  assert.deepEqual(hidden, [ERROR_LINE]);
  const text = hidden.join('');
  assert.equal(text.includes('secret'), false);
  assert.equal(text.includes('db-host'), false);
  assert.equal(text.includes('example.com'), false);
  const badCounts: string[] = [];
  assert.equal(await runBackfill({
    argv: [],
    backfill: async () => ({ ordinary: 1.5, remembered: 0 }),
    out: () => { throw new Error('stdout'); },
    err: (chunk) => { badCounts.push(chunk); },
  }), 1);
  assert.deepEqual(badCounts, [ERROR_LINE]);
});

test('durations match ADMIN_SESSION_POLICY and the two updates match backfillHardExpiresAt', async () => {
  assert.equal(ORDINARY_ABSOLUTE_MS, ADMIN_SESSION_POLICY.ordinaryAbsoluteMs);
  assert.equal(REMEMBERED_ABSOLUTE_MS, ADMIN_SESSION_POLICY.absoluteMs);
  assert.equal(ORDINARY_ABSOLUTE_MS, 12 * 60 * 60 * 1000);
  assert.equal(REMEMBERED_ABSOLUTE_MS, 30 * 24 * 60 * 60 * 1000);
  const lib = readFileSync('scripts/backfill-hard-expires-at-lib.mjs', 'utf8');
  const source = readFileSync('src/lib/server/admin/device-session.ts', 'utf8');
  assert.deepEqual(updateTexts(lib), updateTexts(source));
  assert.deepEqual(secondLines(lib), secondLines(source));
  const queries: { sql: string; values: unknown[] }[] = [];
  const db: ExecuteDb = {
    $executeRaw: async (strings, ...values) => {
      queries.push({ sql: strings.join(' '), values });
      return queries.length === 1 ? 4 : 1;
    },
  };
  assert.deepEqual(await fillNullHardExpiresAt(db, POLICY), { ordinary: 4, remembered: 1 });
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /"remembered" = false/);
  assert.match(queries[1].sql, /"remembered" = true/);
  assert.deepEqual(queries[0].values, [ADMIN_SESSION_POLICY.ordinaryAbsoluteMs / 1000]);
  assert.deepEqual(queries[1].values, [ADMIN_SESSION_POLICY.absoluteMs / 1000]);
  assert.equal(queries[0].values[0], 12 * 60 * 60);
  assert.equal(queries[1].values[0], 30 * 24 * 60 * 60);
  for (const query of queries) {
    assert.match(query.sql, /SET "hardExpiresAt"/);
    assert.doesNotMatch(query.sql, /absoluteExpiresAt/);
    assert.match(query.sql, /"hardExpiresAt" IS NULL/);
  }
});

test('backfill command does not connect or print when the database address is absent', () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  env.NODE_NO_WARNINGS = '1';
  const result = spawnSync(process.execPath, ['scripts/backfill-hard-expires-at.mjs'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, ERROR_LINE);
  const refused = spawnSync(process.execPath, ['scripts/backfill-hard-expires-at.mjs', 'postgresql://user:secret@db-host/app'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, '');
  assert.equal(refused.stderr, USAGE_LINE);
  assert.equal(refused.stderr.includes('secret'), false);
  assert.equal(refused.stderr.includes('db-host'), false);
});

test('prod entry is the mjs, traced into the image, and does not use tsx', () => {
  const entry = readFileSync('scripts/backfill-hard-expires-at.mjs', 'utf8');
  const lib = readFileSync('scripts/backfill-hard-expires-at-lib.mjs', 'utf8');
  assert.equal(existsSync('scripts/backfill-hard-expires-at.ts'), false);
  assert.match(entry, /import\('@prisma\/client'\)/);
  assert.match(entry, /ordinaryAbsoluteMs: ORDINARY_ABSOLUTE_MS/);
  assert.match(entry, /absoluteMs: REMEMBERED_ABSOLUTE_MS/);
  for (const src of [entry, lib]) {
    assert.doesNotMatch(src, /tsx|backfill-hard-expires-at\.ts|from '\.\.\/src\//);
    assert.doesNotMatch(src, /console\./);
  }
  assert.match(readFileSync('next.config.ts', 'utf8'), /'\.\/scripts\/backfill-hard-expires-at\.mjs', '\.\/scripts\/backfill-hard-expires-at-lib\.mjs'/);
  assert.match(readFileSync('Dockerfile', 'utf8'), /test -f scripts\/backfill-hard-expires-at\.mjs && test -f scripts\/backfill-hard-expires-at-lib\.mjs/);
  const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts['admin:backfill-hard-expires'];
  assert.equal(script, 'node scripts/backfill-hard-expires-at.mjs');
});

function updateTexts(src: string): string[] {
  return [...src.matchAll(/UPDATE "AdminDeviceSession"[\s\S]*?"hardExpiresAt" IS NULL/g)]
    .map((match) => match[0].replace(/\$\{[^}]+\}/g, '${}').replace(/\s+/g, ' ').trim());
}

function secondLines(src: string): string[] {
  return [...src.matchAll(/const (?:ordinary|remembered)Seconds = [^;]+;/g)]
    .map((match) => match[0].replace(/\s+/g, ' '));
}
