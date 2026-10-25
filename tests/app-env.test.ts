import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProdEnvFrom } from '../src/lib/site';
import { isProductionDeploy } from '../prod-env-check';
import robots from '../src/app/robots';

const cases: [string, Record<string, string | undefined>, boolean][] = [
  ['only APP_ENV=production', { APP_ENV: 'production' }, true],
  ['only VERCEL_ENV=production is not production', { VERCEL_ENV: 'production' }, false],
  ['neither set → non-prod', {}, false],
  ['APP_ENV=staging → non-prod', { APP_ENV: 'staging' }, false],
  ['NODE_ENV=production alone → non-prod', { NODE_ENV: 'production' }, false]
];
for (const [name, env, want] of cases) {
  test(`isProdEnvFrom: ${name}`, () => {
    assert.equal(isProdEnvFrom(env), want);
    assert.equal(isProductionDeploy(env), want);
  });
}

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = { APP_ENV: process.env.APP_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
  delete process.env.APP_ENV; delete process.env.VERCEL_ENV;
  Object.assign(process.env, env);
  try { fn(); } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
for (const [name, env, want] of cases.slice(0, 3)) {
  test(`robots: ${name}`, () => withEnv(env, () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    if (want) { assert.equal(rules.allow, '/'); assert.ok(r.sitemap); }
    else { assert.equal(rules.disallow, '/'); assert.equal(r.sitemap, undefined); }
  }));
}
