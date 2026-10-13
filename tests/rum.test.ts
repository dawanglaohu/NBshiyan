import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRum } from '../src/lib/server/rum';

test('parseRum: 合法数据', () => {
  assert.ok(parseRum(JSON.stringify({ name: 'LCP', value: 1200, rating: 'good', id: 'v4-1', path: '/en/products', device: 'mobile' })));
});
test('parseRum: 拒绝未知字段、未知指标、非法路径、异常值', () => {
  assert.equal(parseRum(JSON.stringify({ name: 'LCP', value: 1, id: 'a', path: '/en', email: 'x@y' })), null);
  assert.equal(parseRum(JSON.stringify({ name: 'FOO', value: 1, id: 'a', path: '/en' })), null);
  assert.equal(parseRum(JSON.stringify({ name: 'CLS', value: 0.1, id: 'a', path: 'https://evil/x' })), null);
  assert.equal(parseRum(JSON.stringify({ name: 'CLS', value: -1, id: 'a', path: '/' })), null);
  assert.equal(parseRum('not json'), null);
});
