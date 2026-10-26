import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectGlb } from '../src/lib/server/models';

function glb(json: string): Buffer {
  const body = Buffer.from(json);
  const total = 20 + body.length;
  const buf = Buffer.alloc(total);
  buf.write('glTF', 0, 'latin1');
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(total, 8);
  buf.writeUInt32LE(body.length, 12);
  buf.writeUInt32LE(0x4e4f534a, 16);
  body.copy(buf, 20);
  return buf;
}

test('corrupt GLB detail is the fixed sentence and the parser message stays in the log', async () => {
  const token = 'PARSER_LEAK_TOKEN';
  const json = `{"${token}":`;
  let parserMessage = '';
  try { JSON.parse(json); } catch (e) { parserMessage = e instanceof Error ? e.message : String(e); }
  assert.ok(parserMessage.length > 0);
  assert.ok(parserMessage.length <= 120);
  const logs: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const result = await inspectGlb(glb(json), { animated: false });
    const detail = result.checks.find((c) => c.key === 'format')?.detail;
    assert.equal(detail, 'GLB 解析失败');
    const dumped = JSON.stringify(result);
    assert.equal(dumped.includes(parserMessage), false);
    assert.equal(dumped.includes(token), false);
    assert.equal(dumped.includes('GLB 解析失败：'), false);
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0], ['[model-upload] glb parse failed:', parserMessage]);
    assert.equal(String(logs[0][1]).includes('.glb'), false);
    assert.equal(String(logs[0][1]).includes(token), false);
  } finally {
    console.error = orig;
  }
});

test('glTF version and unsupported extension messages stay as plain text', async () => {
  const version = await inspectGlb(glb('{"asset":{"version":"1.0"}}'), { animated: false });
  assert.equal(version.checks.find((c) => c.key === 'format')?.detail, 'glTF 版本 1.0，需要 2.0');
  const ext = await inspectGlb(glb('{"asset":{"version":"2.0"},"extensionsUsed":["NOT_AN_EXT"]}'), { animated: false });
  assert.equal(ext.checks.find((c) => c.key === 'format')?.detail, '不支持的扩展：NOT_AN_EXT');
});

test('both GLB parse catches log a truncated message and return the fixed detail', () => {
  const src = readFileSync('src/lib/server/models.ts', 'utf8');
  assert.equal(src.match(/catch \(e\) \{ push\('format', false, glbParseDetail\(e\)\); return fail\(\); \}/g)?.length, 2);
  assert.equal(src.includes('GLB 解析失败：'), false);
  assert.match(src, /console\.error\('\[model-upload\] glb parse failed:', raw\.replace\(\/\[\\r\\n\]\/g, ' '\)\.slice\(0, 120\)\)/);
});
