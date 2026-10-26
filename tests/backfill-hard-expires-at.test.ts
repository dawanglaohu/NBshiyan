import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_LINE, USAGE_LINE, runBackfill } from '../scripts/backfill-hard-expires-at';

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
    backfill: async () => { throw new Error('postgres://secret@db-host/app'); },
    out: (chunk) => { lines.push(chunk); },
    err: (chunk) => { hidden.push(chunk); },
  }), 1);
  assert.deepEqual(lines, []);
  assert.deepEqual(hidden, [ERROR_LINE]);
  assert.equal(hidden.join('').includes('secret'), false);
});

test('backfill command does not connect or print when the database address is absent', () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  env.NODE_NO_WARNINGS = '1';
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backfill-hard-expires-at.ts'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, ERROR_LINE);
  const refused = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/backfill-hard-expires-at.ts', 'extra'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, '');
  assert.equal(refused.stderr, USAGE_LINE);
});
