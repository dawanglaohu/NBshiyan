import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { Button, Input, Select, Status } from '../src/components/ui';

const upload = readFileSync('src/components/admin/models/ModelUpload.tsx', 'utf8');
const preview = readFileSync('src/components/admin/models/ModelPreview.tsx', 'utf8');
const css = readFileSync('src/components/admin/models/models.css', 'utf8');

test('model styles remain local, flat and consume only the existing pj token palette', () => {
  const flat = css.replace(/@media[^{}]+\{/g, '').replace(/\}\s*\}/g, '}');
  for (const block of flat.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const selector of block[1].trim().split(',')) assert.match(selector.trim(), /^\.mdl(?:\s|\.|$)/, selector);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|gradient\(|blur\(/i);
  assert.doesNotMatch(css, /var\(--(?:ink|line|accent|bg|ok|err|warn|r-)/);
  assert.doesNotMatch(css, /box-shadow:\s*(?!var\(--pj-shadow\))[^;}]+/);
  assert.doesNotMatch(css, /border-radius:\s*(?!var\(--pj-radius\))[^;}]+/);
  assert.match(css, /\.mdl \.mdl-layout\{[^}]*width:min\(100%,calc\(var\(--pj-form-column-width\) \+ var\(--pj-form-aside-width\) \+ var\(--pj-admin-block-gap\)\)\)[^}]*minmax\(0,var\(--pj-form-column-width\)\) var\(--pj-form-aside-width\)/);
  assert.match(css, /\.mdl \.mdl-section\{[^}]*padding:var\(--pj-admin-card-pad\)/);
  assert.match(css, /\.mdl \.mdl-drop\{[^}]*align-items:flex-start[^}]*text-align:left/);
  assert.match(css, /\.mdl \.pj-button\.pj-button[^}]*min-height:var\(--pj-admin-control-height\)/);
  assert.match(css, /@media\(pointer:coarse\),\(max-width:1023px\)\{\.mdl \.pj-button\.pj-button[^}]*min-height:var\(--pj-touch-target\)/);
  assert.match(css, /@media\(pointer:coarse\),\(max-width:1023px\)\{[^}]*\}\.mdl \.pj-button\.pj-button\{min-width:var\(--pj-touch-target\)/);
  assert.doesNotMatch(css, /(^|\})\s*\.adm-/);
});

test('the model upload page reuses M1 controls without changing guards or API operations', () => {
  assert.match(upload, /import \{ Button, Input, Select, Status \} from '@\/components\/ui'/);
  assert.doesNotMatch(upload, /className="(?:adm-btn|adm-sec|adm-g2|badge WON)/);
  for (const action of ['modelApi.upload', 'modelApi.update', 'modelApi.recheck', 'modelApi.publish']) assert.ok(upload.includes(action), action);
  assert.match(upload, /uploadTotalError\(/);
  assert.match(upload, /disabled=\{!files\.glb \|\| missingLod\}/);
  assert.match(upload, /disabled=\{!!nextReason \|\| busy\}/);
  assert.match(upload, /aria-describedby="mdl-next-why"/);
  assert.match(upload, /href="\/admin\/models"/);
  assert.match(upload, /href="\/admin\/inquiries"/);
  assert.match(upload, /confirmPublish \?/);
  assert.match(upload, /modelApi\.publish\(model\.id, true\)/);
  assert.match(upload, /aria-label="选择模型与封面文件"/);
  assert.match(upload, /URL\.revokeObjectURL\(u\)/);
  assert.match(upload, /<ModelUploadAlert text=\{err\} \/>/);
  assert.match(upload, /<ModelCheckDetail detail=\{c\.detail\} warn=\{state === 'warn'\} \/>/);
  assert.match(readFileSync('src/app/admin/models/page.tsx', 'utf8'), /redirect\('\/admin\/models\/new'\)/);
  assert.match(readFileSync('src/app/admin/models/new/page.tsx', 'utf8'), /enforceAdminPage\(\['ADMIN', 'EDITOR'\]/);
});

test('real model decoding, theme and preview lifecycle remain in the Canvas', () => {
  for (const symbol of ['useGLTF', 'setMeshoptDecoder', 'setKTX2Loader', "'/draco/'", 'Bounds fit clip observe', 'OrbitControls enablePan={false}']) assert.ok(preview.includes(symbol), symbol);
  assert.match(preview, /<Canvas aria-label="模型 3D 预览"/);
  assert.match(preview, /dark \? 'var\(--pj-inverse\)' : 'var\(--pj-bg\)'/);
  assert.match(preview, /useEffect\(\(\) => \{ onReady\(\); \}, \[scene, onReady\]\)/);
  assert.match(preview, /data-preview-state=\{ready \? 'ready' : 'loading'\}/);
  assert.match(preview, /<Status className="mdl-preview-error"/);
  assert.match(upload, /<ModelPreview key=\{glbUrl\}/);
});

test('reused primitives retain named native actions, busy/disabled and state semantics', () => {
  const busy = render(h(Button, { busy: true, busyLabel: '上传中…' }, '上传并检查'));
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /disabled=""/);
  assert.match(busy, /上传并检查/);
  const disabled = render(h(Button, { disabled: true, disabledReason: '请先选择模型文件' }, '下一步'));
  assert.match(disabled, /aria-describedby=/);
  assert.match(disabled, /请先选择模型文件/);
  assert.match(render(h(Input, { id: 'sort', label: '排序', type: 'number' })), /for="sort"/);
  assert.match(render(h(Select, { label: '产品' }, h('option', { value: 'wine-boxes' }, '酒盒'))), /<select/);
  for (const tone of ['loading', 'empty', 'error', 'success'] as const) assert.match(render(h(Status, { tone, prefix: '状态', children: '事实' })), /role="status"/);
});
