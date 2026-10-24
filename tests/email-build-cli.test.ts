import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { emailBuildPlan, invokedDirectly } from '../scripts/build-email-templates.mjs';

const script = path.resolve('scripts/build-email-templates.mjs');
const metaUrl = pathToFileURL(script).href;

test('normalized path counts as a direct run, including a different drive-letter case', () => {
  assert.equal(invokedDirectly(['node', script], metaUrl), true);
  assert.equal(invokedDirectly(['node', 'scripts/build-email-templates.mjs'], metaUrl), true);
  if (process.platform === 'win32') {
    const flipped = script.replace(/^([A-Za-z]):/, (_, letter: string) => `${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}:`);
    assert.notEqual(flipped, script);
    assert.equal(invokedDirectly(['node', flipped], metaUrl), true);
  }
  assert.equal(emailBuildPlan({ argv: ['node', script], metaUrl, lifecycle: 'email:build' }).action, 'write');
});

test('importing the builder is a skip and does not fail the process', () => {
  assert.equal(emailBuildPlan({ argv: ['node', 'tests/email.test.ts'], metaUrl, lifecycle: 'test' }).action, 'skip');
  assert.equal(emailBuildPlan({ argv: ['node'], metaUrl, lifecycle: undefined }).code, 0);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/build-email-templates.mjs')"], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20000,
  });
  assert.equal(imported.status, 0, imported.stderr);
});

test('email:build with a failed invokedDirectly check exits non-zero and does not write', () => {
  const plan = emailBuildPlan({
    argv: ['node', 'C:\\not-the-repo\\build-email-templates.mjs'],
    metaUrl,
    lifecycle: undefined,
  });
  assert.equal(plan.action, 'fail');
  assert.equal(plan.code, 1);
  assert.equal(plan.action === 'fail' && /invokedDirectly\(\) failed/.test(plan.error), true);
  const viaNpm = emailBuildPlan({ argv: ['node', 'tests/email.test.ts'], metaUrl, lifecycle: 'email:build' });
  assert.equal(viaNpm.code, 1);

  const before = readFileSync('src/lib/server/email/templates.generated.ts');
  const failed = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/build-email-templates.mjs')"], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, npm_lifecycle_event: 'email:build' },
  });
  assert.equal(failed.status, 1, failed.stdout ?? '');
  assert.match(failed.stderr ?? '', /invokedDirectly\(\) failed/);
  assert.equal(readFileSync('src/lib/server/email/templates.generated.ts').equals(before), true);
});
