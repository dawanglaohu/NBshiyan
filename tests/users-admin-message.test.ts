import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userAdminMessage } from '../src/components/admin/users/UsersAdmin';
import { outageFormGeneric } from '../src/lib/admin/outage-copy';

test('user admin error lookup ignores prototype keys', () => {
  const generic = outageFormGeneric();
  assert.equal(userAdminMessage('email_taken'), '这个邮箱已经有账号了。');
  assert.equal(userAdminMessage('unauthorized'), '登录已过期，请重新登录。');
  for (const code of ['constructor', 'toString', '__proto__', 'zz_unknown_user_code']) {
    const text = userAdminMessage(code);
    assert.equal(typeof text, 'string', code);
    assert.equal(text, generic, code);
    assert.equal(text.includes(code), false, code);
    assert.equal(text.includes('function'), false, code);
  }
});
