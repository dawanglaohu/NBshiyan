import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelApiError } from '../src/lib/admin/models';
import { FORM_INVALID, outageFormMessage } from '../src/lib/admin/outage-copy';
import { MODEL_UPLOAD_ERRORS, ModelCheckDetail, ModelUploadAlert, modelUploadErrorText } from '../src/components/admin/models/ModelUploadAlert';

const LEAK = 'postgres://upload-secret-should-not-render';
const CODE = 'zz_unknown_upload_code';
const GENERIC = '服务暂时出错，请稍后重试。';
const FILE_TOO_LARGE = '文件超过上限（主 GLB ≤1.5MB、高精度层 ≤1MB、封面 ≤512KB）';
const OUTAGE = outageFormMessage();

/** 白名单期望。新增错误码必须在这里写上固定句，不能只跟组件里的表走。 */
const EXPECTED: Record<string, string> = {
  too_large: FILE_TOO_LARGE,
  http_413: FILE_TOO_LARGE,
  unsupported_type: '不是有效的 GLB 文件',
  not_ready: '检查未全部通过，不能上架',
  forbidden_origin: '请求被拒绝：来源校验失败，请刷新页面后重试',
  unauthorized: '登录已过期，请重新登录',
  forbidden: '没有权限（需要 ADMIN 或 EDITOR 角色）',
  upload_too_large: '本次上传的文件合计超过 4MB 上限（服务器单个请求不能超过 4MB），请先压缩后再上传',
  length_required: '上传请求缺少大小信息，请刷新页面后重试',
  rate_limited: '操作太频繁，请稍后再试',
  not_found: '这条内容不存在或已被删除，请刷新列表。',
  published: '这个模型已上架，不能直接删除，请先下架再删除。',
  invalid_image: '图片格式不支持或文件已损坏，请换一张再上传。',
  missing_file: '请先选择要上传的文件。',
  invalid: FORM_INVALID.zh,
  account_disabled: '你的账号已被停用，请联系管理员。',
  service_unavailable: OUTAGE,
  http_503: OUTAGE,
};

const NO_RETRY = ['not_found', 'published', 'invalid_image', 'missing_file', 'invalid', 'account_disabled'] as const;

function alert(error: unknown) {
  return renderToStaticMarkup(React.createElement(ModelUploadAlert, { text: modelUploadErrorText(error) }));
}

test('model upload renders a fixed sentence for every whitelist code', () => {
  assert.deepEqual(Object.keys(MODEL_UPLOAD_ERRORS).sort(), Object.keys(EXPECTED).sort());
  for (const [code, sentence] of Object.entries(EXPECTED)) {
    assert.equal(MODEL_UPLOAD_ERRORS[code], sentence, code);
    const err = new ModelApiError(code);
    err.message = LEAK;
    const html = alert(err);
    assert.equal(html.includes(LEAK), false, code);
    assert.equal(html.includes(code), false, code);
    assert.match(html, /role="alert"/);
    assert.ok(html.includes(sentence), code);
    assert.notEqual(sentence, GENERIC, code);
  }
  for (const code of NO_RETRY) assert.equal(EXPECTED[code].includes('重试'), false, code);
  assert.equal(EXPECTED.service_unavailable, OUTAGE);
  assert.equal(EXPECTED.http_503, OUTAGE);
  assert.equal(EXPECTED.invalid, '部分内容没有通过检查，请核对后再提交。');
});

test('model upload renders only whitelist copy for unknown codes and raw messages', () => {
  const unknown = new ModelApiError(CODE);
  unknown.message = LEAK;
  const html = alert(unknown);
  assert.equal(html.includes(CODE), false);
  assert.equal(html.includes(LEAK), false);
  assert.match(html, /role="alert"/);
  assert.match(html, /服务暂时出错，请稍后重试。/);

  const plain = alert(new Error(LEAK));
  assert.equal(plain.includes(LEAK), false);
  assert.match(plain, /服务暂时出错，请稍后重试。/);

  const http = new ModelApiError('http_500');
  http.message = LEAK;
  const five = alert(http);
  assert.equal(five.includes('http_500'), false);
  assert.equal(five.includes(LEAK), false);
  assert.match(five, /服务暂时出错，请稍后重试。/);

  const src = readFileSync('src/components/admin/models/ModelUpload.tsx', 'utf8');
  assert.match(src, /modelUploadErrorText\(/);
  assert.match(src, /<ModelUploadAlert text=\{err\} \/>/);
  assert.equal(src.includes('${e.code}'), false);
  assert.equal(src.includes('e.message'), false);
  assert.equal(src.includes('操作失败：'), false);
});

test('GLB check detail renders the fixed sentence, not the parser message', () => {
  const leak = 'Unexpected end of JSON input PARSER_LEAK_TOKEN';
  const html = renderToStaticMarkup(React.createElement(ModelCheckDetail, { detail: 'GLB 解析失败' }));
  assert.equal(html, '<span>GLB 解析失败</span>');
  assert.equal(html.includes(leak), false);
  const warn = renderToStaticMarkup(React.createElement(ModelCheckDetail, { detail: 'GLB 解析失败', warn: true }));
  assert.equal(warn, '<span>GLB 解析失败（仅提示）</span>');
  const src = readFileSync('src/components/admin/models/ModelUpload.tsx', 'utf8');
  assert.match(src, /<ModelCheckDetail detail=\{c\.detail\} warn=\{state === 'warn'\} \/>/);
});
