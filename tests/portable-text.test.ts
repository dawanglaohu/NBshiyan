import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortableText, safeInternalHref } from '../src/lib/server/portableText';

test('portable text: 只保留 block/span，丢弃图片、未知标记和非字符串', () => {
  const out = parsePortableText([
    { _type: 'block', style: 'h2', children: [{ _type: 'span', text: 'Hi', marks: ['strong', 'javascript:x'] }] },
    { _type: 'image', asset: { _ref: 'x' } },
    { _type: 'block', listItem: 'bullet', children: [{ _type: 'span', text: 'a' }] },
    { _type: 'block', listItem: 'bullet', children: [{ _type: 'span', text: 'b' }] },
    { _type: 'block', style: 'script', children: [{ _type: 'span', text: '<script>' }, { _type: 'span', text: 1 }] }
  ]);
  assert.deepEqual(out, [
    { kind: 'block', style: 'h2', spans: [{ text: 'Hi', marks: ['strong'] }] },
    { kind: 'list', ordered: false, items: [[{ text: 'a', marks: [] }], [{ text: 'b', marks: [] }]] },
    { kind: 'block', style: 'p', spans: [{ text: '<script>', marks: [] }] }
  ]);
  assert.deepEqual(parsePortableText('x'), []);
});

test('safeInternalHref: 只允许 /en/、/ru/ 站内相对路径', () => {
  assert.equal(safeInternalHref('/en/x'), '/en/x');
  assert.equal(safeInternalHref('/ru/x#a'), '/ru/x#a');
  assert.equal(safeInternalHref('/en/x?a=1#b'), '/en/x?a=1#b');
  for (const bad of ['https://evil.com/en/x', '//evil', '/\\evil', '/%2F%2Fevil', '/%252F%252Fevil', '/en/%2e%2e/x', '/en/../../x',
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', '/de/x', 'x', 'en/x', '', ' /en/x', '/en/a b', '/en/\tx', '/en/%5Cevil', null, 42]) {
    assert.equal(safeInternalHref(bad), null, String(bad));
  }
});

test('portable text: link 注解只对安全 href 生效，其他输出纯文本', () => {
  const out = parsePortableText([{ _type: 'block', markDefs: [
    { _key: 'a', _type: 'link', href: '/en/products' }, { _key: 'b', _type: 'link', href: 'javascript:alert(1)' },
  ], children: [
    { _type: 'span', text: 'ok', marks: ['a', 'strong'] }, { _type: 'span', text: 'bad', marks: ['b'] },
  ] }]);
  assert.deepEqual(out, [{ kind: 'block', style: 'p', spans: [
    { text: 'ok', marks: ['strong'], href: '/en/products' }, { text: 'bad', marks: [] },
  ] }]);
});
