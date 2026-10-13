import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortableText } from '../src/lib/server/portableText';

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
