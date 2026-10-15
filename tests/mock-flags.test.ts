import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminMockEnabled, logoUploadMockEnabled } from '../src/lib/mockFlags';

test('production ignores NEXT_PUBLIC_LOGO_UPLOAD_MOCK', () => {
  for (const v of ['1', '0', 'true', undefined]) assert.equal(logoUploadMockEnabled({ NODE_ENV: 'production', NEXT_PUBLIC_LOGO_UPLOAD_MOCK: v }), false);
});
test('production always uses the real admin API, whatever NEXT_PUBLIC_ADMIN_API is', () => {
  for (const v of ['http', 'mock', '', undefined]) assert.equal(adminMockEnabled({ NODE_ENV: 'production', NEXT_PUBLIC_ADMIN_API: v }), false);
});
test('non-production behavior unchanged', () => {
  for (const NODE_ENV of ['development', 'test', undefined]) {
    assert.equal(logoUploadMockEnabled({ NODE_ENV, NEXT_PUBLIC_LOGO_UPLOAD_MOCK: '1' }), true);
    assert.equal(logoUploadMockEnabled({ NODE_ENV, NEXT_PUBLIC_LOGO_UPLOAD_MOCK: '0' }), false);
    assert.equal(logoUploadMockEnabled({ NODE_ENV }), false);
    assert.equal(adminMockEnabled({ NODE_ENV, NEXT_PUBLIC_ADMIN_API: 'http' }), false);
    assert.equal(adminMockEnabled({ NODE_ENV }), true);
  }
});
