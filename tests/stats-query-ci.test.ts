import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('PG17 CI provisions the dedicated statistics database and rejects missing or skipped results', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const step = workflow.split('- name: Analytics, chat, and other PostgreSQL regressions')[1]?.split('\n      - name:')[0];
  assert.ok(step, 'PG regression step');
  assert.ok(workflow.includes('CREATE DATABASE "m6t1_stats_test"'), 'dedicated database provision');
  assert.match(step, /M6T1_TEST_DATABASE_URL: postgresql:\/\/postgres:postgres@localhost:5432\/m6t1_stats_test\s/);
  assert.match(step, /M6T1_REQUIRE_DATABASE: 'true'/);

  const path = 'tests/stats-query.db.test.ts';
  for (const [start, end] of [
    ['const wanted = [', '];'],
    ['node --import tsx --test', '|| { status='],
    ['const files = [', '];'],
  ]) {
    const section = step.split(start)[1]?.split(end)[0];
    assert.ok(section, start);
    assert.equal(section.split(path).length - 1, 1, start);
  }
});
