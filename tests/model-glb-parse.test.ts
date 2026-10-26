import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectGlb, modelLogText } from '../src/lib/server/models';

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

test('glTF version echo keeps only a short numeric version', async () => {
  const long = '9'.repeat(80);
  const cases: [string, string][] = [
    ['{"asset":{"version":"1234.5"}}', 'glTF 版本 未知，需要 2.0'],
    [`{"asset":{"version":"${long}.1"}}`, 'glTF 版本 未知，需要 2.0'],
    ['{"asset":{"version":"2.0.1"}}', 'glTF 版本 未知，需要 2.0'],
    ['{"asset":{"version":2}}', 'glTF 版本 未知，需要 2.0'],
    ['{"asset":{"version":{"n":"2.0"}}}', 'glTF 版本 未知，需要 2.0'],
    ['{"asset":{"version":"2.0\\n1"}}', 'glTF 版本 未知，需要 2.0'],
  ];
  for (const [json, detail] of cases) {
    const result = await inspectGlb(glb(json), { animated: false });
    assert.equal(result.checks.find((c) => c.key === 'format')?.detail, detail, json);
    assert.equal(result.checks.find((c) => c.key === 'format')?.detail?.includes('\n'), false, json);
    assert.equal(JSON.stringify(result).includes(long), false);
  }
});

/**
 * JSON 块能解析，但没有按 4 字节对齐，后面再接一段损坏的 BIN。
 * 自己的 JSON 检查会通过；NodeIO 读二进制块头时抛错。
 */
function glbWithCorruptBin(json: string): Buffer {
  const jsonBuf = Buffer.from(json);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const brokenBin = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x42, 0x49, 0x4e, 0x00]);
  const body = Buffer.concat([jsonHeader, jsonBuf, brokenBin]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'latin1');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

test('a valid JSON chunk with a corrupt BIN chunk fails in NodeIO and keeps the fixed detail', async () => {
  const json = '{"asset":{"version":"2.0"}}';
  const file = glbWithCorruptBin(json);
  const jsonLen = file.readUInt32LE(12);
  assert.notEqual(jsonLen % 4, 0);
  assert.deepEqual(JSON.parse(file.toString('utf8', 20, 20 + jsonLen)), JSON.parse(json));
  const logs: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const result = await inspectGlb(file, { animated: false });
    assert.equal(result.checks.find((c) => c.key === 'format')?.detail, 'GLB 解析失败');
    assert.equal(JSON.stringify(result).includes('GLB 解析失败：'), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], '[model-upload] glb parse failed:');
    const logged = String(logs[0][1]);
    assert.notEqual(logged, 'JSON 块无效');
    assert.equal(logged.includes('Unexpected'), false);
    assert.match(logged, /offset|bounds|Range|Invalid glTF/i);
    assert.equal([...logged].some((c) => c.charCodeAt(0) <= 0x1f || c.charCodeAt(0) === 0x7f), false);
  } finally {
    console.error = orig;
  }
});

test('parse logs drop newlines and other control characters', async () => {
  const nasty = `line\r\nnext\u0000\u0007\u007fEND`;
  const text = modelLogText(nasty.repeat(20));
  assert.ok(text.length <= 120);
  assert.equal(text.includes('\n'), false);
  assert.equal(text.includes('\r'), false);
  assert.equal([...text].some((c) => c.charCodeAt(0) <= 0x1f || c.charCodeAt(0) === 0x7f), false);
  assert.match(text, /^line  nextEND/);
  const logs: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const result = await inspectGlb(glb('\u0000'), { animated: false });
    assert.equal(result.checks.find((c) => c.key === 'format')?.detail, 'GLB 解析失败');
    const logged = String(logs[0][1]);
    assert.equal([...logged].some((c) => c.charCodeAt(0) <= 0x1f || c.charCodeAt(0) === 0x7f), false);
    assert.match(logged, /Unexpected token/);
  } finally {
    console.error = orig;
  }
});

test('both GLB parse catches log a truncated message and return the fixed detail', () => {
  const src = readFileSync('src/lib/server/models.ts', 'utf8');
  assert.equal(src.match(/catch \(e\) \{ push\('format', false, glbParseDetail\(e\)\); return fail\(\); \}/g)?.length, 2);
  assert.equal(src.includes('GLB 解析失败：'), false);
  assert.match(src, /console\.error\('\[model-upload\] glb parse failed:', modelLogText\(raw\)\)/);
  assert.match(src, /raw\.replace\(\/\[\\r\\n\]\/g, ' '\)\.replace\(\/\[\\x00-\\x1f\\x7f\]\/g, ''\)\.slice\(0, 120\)/);
});
