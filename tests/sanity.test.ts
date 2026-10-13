import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanityConfig, buildQueryUrl, bySlugQuery } from '../src/lib/server/sanity';

test('sanityConfig: 未配置或非法 projectId 返回 null', () => {
  assert.equal(sanityConfig({}), null);
  assert.equal(sanityConfig({ SANITY_PROJECT_ID: 'evil.com/x' }), null);
  assert.equal(sanityConfig({ SANITY_PROJECT_ID: 'abc123', SANITY_DATASET: '../x' }), null);
  assert.deepEqual(sanityConfig({ SANITY_PROJECT_ID: 'abc123' }), { projectId: 'abc123', dataset: 'production', token: undefined });
});
test('buildQueryUrl: 主机固定为 sanity.io，参数 JSON 编码', () => {
  const u = buildQueryUrl({ projectId: 'abc123', dataset: 'production' }, '*[slug==$slug]', { slug: 'a"b' });
  assert.equal(u.host, 'abc123.apicdn.sanity.io');
  assert.equal(u.searchParams.get('$slug'), '"a\\"b"');
  assert.equal(buildQueryUrl({ projectId: 'abc123', dataset: 'production', token: 't' }, 'x').host, 'abc123.api.sanity.io');
});
test('bySlugQuery: slug 走参数而不是拼接', () => {
  assert.match(bySlugQuery('product', 'ru'), /slug\.ru\.current == \$slug/);
});
