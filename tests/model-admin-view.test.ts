import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Model3D } from '@prisma/client';
import { adminView } from '../src/lib/server/model-service';

test('adminView normalizes GLB parse details without writing them back', () => {
  const checks = [
    { key: 'format', ok: false, severity: 'error', detail: 'GLB 解析失败：PARSER_LEAK_TOKEN' },
    { key: 'size', ok: true, severity: 'warn', detail: '0.10MB / 1.00MB' },
    { key: 'format', ok: false, severity: 'error', detail: 'GLB 解析失败' },
  ];
  const row = {
    sourceKey: 'models/secret-key/main.glb',
    glbKey: 'models/secret-key/out.glb',
    lodKey: null,
    posterKey: 'models/secret-key/poster.webp',
    checks,
  } as unknown as Model3D;
  const view = adminView(row);
  const shown = view.checks as { detail: string }[];
  assert.equal(shown[0].detail, 'GLB 解析失败');
  assert.equal(shown[1].detail, '0.10MB / 1.00MB');
  assert.equal(shown[2].detail, 'GLB 解析失败');
  assert.equal(checks[0].detail, 'GLB 解析失败：PARSER_LEAK_TOKEN');
  assert.equal(JSON.stringify(view).includes('PARSER_LEAK_TOKEN'), false);
  assert.equal(JSON.stringify(view).includes('secret-key'), false);
  assert.equal(view.hasPoster, true);
  assert.equal(view.hasLod, false);
});

test('processModel stores process_failed and logs the truncated exception', () => {
  const src = readFileSync('src/lib/server/model-service.ts', 'utf8');
  assert.match(src, /error: 'process_failed'/);
  assert.match(src, /console\.error\('\[model-upload\] process failed:', modelLogText\(raw\)\)/);
  assert.equal(src.includes('.message).slice'), false);
  assert.match(src, /viewChecks\(checks\)/);
});
