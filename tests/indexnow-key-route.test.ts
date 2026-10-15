import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../src/app/api/indexnow-key/[file]/route';

const KEY = 'abcDEF12-3456';
const call = (file: string) => GET(new Request('https://x/' + file), { params: Promise.resolve({ file }) });
function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const old = { ...process.env }; Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  return fn().finally(() => { process.env = old; });
}

test('key file: exact /{key}.txt in production → 200 text/plain', () => withEnv({ VERCEL_ENV: 'production', INDEXNOW_KEY: KEY }, async () => {
  const r = await call(`${KEY}.txt`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type')!, /^text\/plain/);
  assert.equal(await r.text(), KEY);
  for (const bad of [`${KEY}.TXT`, `${KEY}x.txt`, `abcDEF12-3457.txt`, 'robots.txt', `${KEY}`, `x${KEY}.txt`])
    assert.equal((await call(bad)).status, 404, bad);
}));

test('key file: 404 when unset, invalid or not production', async () => {
  for (const env of [{ VERCEL_ENV: 'production', INDEXNOW_KEY: undefined }, { VERCEL_ENV: 'preview', INDEXNOW_KEY: KEY }, { VERCEL_ENV: 'production', INDEXNOW_KEY: 'bad key!' }])
    await withEnv(env, async () => assert.equal((await call(`${env.INDEXNOW_KEY}.txt`)).status, 404));
});
