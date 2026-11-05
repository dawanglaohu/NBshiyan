import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #347 曾用内存 prisma 替身断言「无 body 直重置他人 2FA：清 TOTP、解锁、发一次性 enrollLink、删限流 key」。
// M3-T4 起该旁路被 E-13 与 10 节明确否定：reset-2fa 只消费目标绑定的 RECOVERY_AUTHORIZE grant、
// 签发 15min permit，目标因素零改动。旧断言已失效，这里改成静态守卫防止旧旁路回归；
// 新语义的真实运行时覆盖在 tests/admin-recovery-authorizations.http.test.ts（CI 专用 PostgreSQL）。

const ROUTE = 'src/app/api/admin/users/[id]/reset-2fa/route.ts';
const MAIN_ROUTE = 'src/app/api/admin/account/recovery-authorizations/route.ts';
const UI = 'src/components/admin/users/UsersAdmin.tsx';

test('reset-2fa is a thin alias of the recovery-authorization handler, not a direct 2FA reset', () => {
  const src = readFileSync(ROUTE, 'utf8');
  assert.match(src, /handleRecoveryAuthorization\(/);
  assert.match(src, /targetIdFromPath: id/);
  assert.match(src, /requireAdmin\(request, \['ADMIN'\]\)/);
  assert.match(src, /assertSameOrigin\(request\)/);
  for (const legacy of [/reset2faData/, /newEnrollToken/, /issueResponse/, /enrollLinkBase/, /publicUser/, /clearAccountRateLimits/, /mutateUser/]) {
    assert.doesNotMatch(src, legacy, `legacy direct-reset symbol ${legacy} must stay removed`);
  }
});

test('both entry points share the same handler and refuse the legacy no-body reset', () => {
  const alias = readFileSync(ROUTE, 'utf8');
  const main = readFileSync(MAIN_ROUTE, 'utf8');
  for (const src of [alias, main]) {
    assert.match(src, /handleRecoveryAuthorization/);
    assert.match(src, /RECOVERY_AUTHORIZE/);
    assert.doesNotMatch(src, /NextResponse\.json\(\{ \.\.\.publicUser\(u\), \.\.\.issueResponse\(t, base\) \}/);
  }
  assert.match(alias, /RESET_2FA_ALIAS_ROUTE_ID/);
  assert.match(main, /RECOVERY_AUTHORIZE_ROUTE_ID/);
});

test('recovery-authorizations responses are never cacheable (no-store on success and every denial)', () => {
  const handler = readFileSync('src/lib/server/admin/recovery-authorizations.ts', 'utf8');
  assert.match(handler, /'cache-control': 'private, no-store'/);
  assert.match(handler, /classifyThrown\(error, requestId\)/);
  const alias = readFileSync(ROUTE, 'utf8');
  assert.match(alias, /'cache-control': 'private, no-store'/);
});

test('admin UI reset-2fa call carries a reason and no longer consumes a one-time enroll link', () => {
  const ui = readFileSync(UI, 'utf8');
  assert.match(ui, /body: JSON\.stringify\(\{ reason: '目标账号 2FA 恢复授权申请' \}\)/);
  assert.doesNotMatch(ui, /pickEnrollLink\(await api<unknown>\(`\/\$\{u\.id\}\/reset-2fa`/);
  assert.match(ui, /`\/\$\{u\.id\}\/reset-2fa`/);
  // 一次性链接面板仍服务「新建账号」，不因本任务删掉。
  assert.equal((ui.match(/<EnrollLinkPanel /g) ?? []).length, 1);
});

test('admin UI: Reset 2FA confirm copy, danger button, and self-row suppression are unchanged', () => {
  const ui = readFileSync(UI, 'utf8');
  assert.match(ui, /<ConfirmDialog title=\{RESET_2FA_CONFIRM\(resetTarget\.email\)\}/);
  assert.match(ui, /onConfirm=\{\(\) => reset2fa\(resetTarget\)\}/);
  assert.ok(!/localStorage|sessionStorage|console\.|history\./.test(ui));
});
