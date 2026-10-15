import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seoMockEnabled, categoryPagesLive } from '../src/lib/seo/mock';
import { CATEGORY_PAGES_LIVE } from '../src/lib/seo/categoryPages';
import { prodEnvProblems } from '../prod-env-check';

// #291：SEO_AUDIT_MOCK 只看正式部署标记（APP_ENV/VERCEL_ENV），不看 NODE_ENV：本地审计用 next build/start，NODE_ENV 总是 production
test('SEO_AUDIT_MOCK ignored on production deploy (APP_ENV / VERCEL_ENV), even with NODE_ENV=production', () => {
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', NODE_ENV: 'production', APP_ENV: 'production' }), false);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', NODE_ENV: 'production', VERCEL_ENV: 'production' }), false);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', APP_ENV: 'production', VERCEL_ENV: 'preview' }), false);
  assert.equal(categoryPagesLive({ SEO_AUDIT_MOCK: '1', NODE_ENV: 'production', APP_ENV: 'production' }), CATEGORY_PAGES_LIVE);
});

test('default-safe: APP_ENV and VERCEL_ENV both unset -> off', () => {
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1' }), false);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', NODE_ENV: 'production' }), false);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', APP_ENV: '  ' }), false);
});

test('explicit APP_ENV=development/test + SEO_AUDIT_MOCK=1 -> on (local audit build, NODE_ENV=production)', () => {
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', APP_ENV: 'development' }), true);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', APP_ENV: 'development', NODE_ENV: 'production' }), true);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', APP_ENV: 'test', NODE_ENV: 'production' }), true);
  assert.equal(seoMockEnabled({ SEO_AUDIT_MOCK: '1', VERCEL_ENV: 'preview' }), true);
  assert.equal(categoryPagesLive({ SEO_AUDIT_MOCK: '1', APP_ENV: 'development', NODE_ENV: 'production' }), true);
  assert.equal(seoMockEnabled({ APP_ENV: 'development' }), false);
});

test('SEO_AUDIT_MOCK does not change prod-env-check result', () => {
  const env = { APP_ENV: 'production' };
  assert.deepEqual(prodEnvProblems({ ...env, SEO_AUDIT_MOCK: '1' }), prodEnvProblems(env));
});

test('sanityMock is only reached via import() behind the build-time SEO_AUDIT_MOCK_BUILD constant', () => {
  const cfg = readFileSync('next.config.ts', 'utf8');
  assert.match(cfg, /SEO_AUDIT_MOCK_BUILD: seoMockEnabled\(\) \? '1' : ''/);
  for (const f of ['src/lib/server/sanity.ts', 'src/app/sitemap.ts']) {
    const s = readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /^import[^\n]*sanityMock/m, `${f} must not statically import sanityMock`);
  }
  for (const f of ['src/lib/server/sanity.ts', 'src/app/sitemap.ts']) assert.match(readFileSync(f, 'utf8'), /process\.env\.SEO_AUDIT_MOCK_BUILD === '1' && seoMockEnabled\(\) \? \(?(\(await )?import\(/);
});
