import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAssignInquiry } from '../src/components/admin/format';

test('#225 只有 ADMIN 能改询盘负责人', () => {
  assert.equal(canAssignInquiry('ADMIN'), true);
  for (const r of ['SALES', 'EDITOR', undefined, null, '']) assert.equal(canAssignInquiry(r), false);
});
