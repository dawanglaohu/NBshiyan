import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React;
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelApiError } from '../src/lib/admin/models';
import { ModelUploadAlert, modelUploadErrorText } from '../src/components/admin/models/ModelUploadAlert';

const LEAK = 'postgres://upload-secret-should-not-render';
const CODE = 'zz_unknown_upload_code';

function alert(error: unknown) {
  return renderToStaticMarkup(React.createElement(ModelUploadAlert, { text: modelUploadErrorText(error) }));
}

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

  const known = new ModelApiError('unauthorized');
  known.message = LEAK;
  const login = alert(known);
  assert.match(login, /登录已过期，请重新登录/);
  assert.equal(login.includes('unauthorized'), false);
  assert.equal(login.includes(LEAK), false);
  assert.equal(login.includes(CODE), false);

  const src = readFileSync('src/components/admin/models/ModelUpload.tsx', 'utf8');
  assert.match(src, /modelUploadErrorText\(/);
  assert.match(src, /<ModelUploadAlert text=\{err\} \/>/);
  assert.equal(src.includes('${e.code}'), false);
  assert.equal(src.includes('e.message'), false);
  assert.equal(src.includes('操作失败：'), false);
});
