import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_ACTIVITY_THROTTLE_MS,
  createAdminActivityReporter,
  resetAdminActivityReporter,
} from '../src/components/admin/auth/AdminSessionActivity';
import { ADMIN_SESSION_POLICY } from '../src/lib/server/config';

const shell = readFileSync('src/components/admin/AdminShell.tsx', 'utf8');
const account = readFileSync('src/lib/client/account.ts', 'utf8');
const activity = readFileSync('src/components/admin/auth/AdminSessionActivity.tsx', 'utf8');
const css = readFileSync('src/app/admin/admin.css', 'utf8');
const tokens = readFileSync('src/styles/tokens.css', 'utf8');
const spec = readFileSync('e2e/admin-shell-activity.spec.ts', 'utf8');

function harness(overrides: Partial<Parameters<typeof createAdminActivityReporter>[0]> = {}) {
  const calls: Array<{ signal: AbortSignal }> = [];
  const pending: Array<(r: { ok: true } | { ok: false; action?: string; status?: number }) => void> = [];
  const assigned: string[] = [];
  let unauthorized = 0;
  let now = 1_000_000;
  let visible = true;
  let focus = true;
  const reporter = createAdminActivityReporter({
    send: (signal) => {
      calls.push({ signal });
      return new Promise((resolve) => { pending.push(resolve); });
    },
    onUnauthorized: () => { unauthorized += 1; },
    assign: (url) => { assigned.push(url); },
    path: () => '/admin/settings?section=org',
    now: () => now,
    isVisible: () => visible,
    hasFocus: () => focus,
    ...overrides,
  });
  const flush = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };
  const settle = (r: { ok: true } | { ok: false; action?: string; status?: number }) => {
    const resolve = pending.at(-1);
    if (!resolve) throw new Error('missing request');
    resolve(r);
  };
  return { reporter, calls, pending, assigned, flush, settle, get unauthorized() { return unauthorized; }, setNow: (n: number) => { now = n; }, setVisible: (v: boolean) => { visible = v; }, setFocus: (v: boolean) => { focus = v; } };
}

test('M3-T7 节流常量与服务端 activityThrottleMs 一致', () => {
  assert.equal(ADMIN_ACTIVITY_THROTTLE_MS, ADMIN_SESSION_POLICY.activityThrottleMs);
  assert.equal(ADMIN_ACTIVITY_THROTTLE_MS, 15 * 60 * 1000);
});

test('真实操作后只发一次，15 分钟内重复操作不再发', async () => {
  const h = harness();
  h.reporter.report();
  h.reporter.report();
  assert.equal(h.calls.length, 1, '同一时刻只发一个');
  h.settle({ ok: true });
  await h.flush();
  h.setNow(1_000_000 + ADMIN_ACTIVITY_THROTTLE_MS - 1);
  h.reporter.report();
  assert.equal(h.calls.length, 1, '未满 15 分钟不发');
  h.setNow(1_000_000 + ADMIN_ACTIVITY_THROTTLE_MS);
  h.reporter.report();
  assert.equal(h.calls.length, 2, '满 15 分钟后真实操作才再发');
});

test('隐藏页或失焦页丢弃事件，不发 activity', () => {
  const hidden = harness();
  hidden.setVisible(false);
  hidden.reporter.report();
  assert.equal(hidden.calls.length, 0, '隐藏页不发');
  const blurred = harness();
  blurred.setFocus(false);
  blurred.reporter.report();
  assert.equal(blurred.calls.length, 0, '失焦页不发');
});

test('在途未完成时重复操作不会并发第二个请求', async () => {
  const h = harness();
  h.reporter.report();
  h.reporter.report();
  assert.equal(h.calls.length, 1);
  h.settle({ ok: true });
  await h.flush();
  h.setNow(1_000_000 + ADMIN_ACTIVITY_THROTTLE_MS + 1);
  h.reporter.report();
  assert.equal(h.calls.length, 2);
});

test('401 / login 动作：清内容一次、停止后续上报、跳登录页，不重试', async () => {
  const h = harness();
  h.reporter.report();
  h.settle({ ok: false, action: 'login', status: 401 });
  await h.flush();
  assert.equal(h.unauthorized, 1, '必须清本账号内容');
  assert.equal(h.assigned.length, 1, '跳登录页');
  assert.match(h.assigned[0], /^\/admin-login\?callbackUrl=/);
  h.setNow(1_000_000 + ADMIN_ACTIVITY_THROTTLE_MS * 2);
  h.reporter.report();
  assert.equal(h.calls.length, 1, '撤销后不再拿旧 cookie 上报');
});

test('503 / 网络错误静默结束，不重试不跳转', async () => {
  const h = harness();
  h.reporter.report();
  h.settle({ ok: false, status: 503 });
  await h.flush();
  assert.equal(h.unauthorized, 0);
  assert.equal(h.assigned.length, 0);
  h.setNow(1_000_000 + ADMIN_ACTIVITY_THROTTLE_MS);
  h.reporter.report();
  assert.equal(h.calls.length, 2, '节流仍按本次发起时间生效，但允许下一次真实操作');
});

test('stop() 丢弃在途并暂停；dispose 供失焦/卸载清理', () => {
  const h = harness();
  h.reporter.report();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, false);
  h.reporter.stop();
  assert.equal(h.calls[0].signal.aborted, true, '失焦必须 abort 在途请求');
  h.setNow(1_000_000 + ADMIN_ACTIVITY_THROTTLE_MS * 2);
  h.reporter.report();
  assert.equal(h.calls.length, 1, 'stop 后不再上报');
});

test('account.ts 是唯一请求入口：GET account 与 POST activity，后继只追加方法', () => {
  assert.match(account, /export function getAccount\(/);
  assert.match(account, /path: '\/api\/admin\/account'/);
  assert.match(account, /method: 'GET'/);
  assert.match(account, /schema: AccountDTOSchema/);
  assert.match(account, /export function postSessionActivity\(/);
  assert.match(account, /path: '\/api\/admin\/account\/session\/activity'/);
  assert.match(account, /method: 'POST'/);
  assert.match(account, /schema: SessionActivityDTOSchema/);
  assert.match(account, /body: \{\}/, 'activity 请求体固定空对象');
  assert.match(account, /audience: 'admin'/, '用 admin 受众，401 映射成 login');
  // 不重造请求基础：两个方法都走 requestApi，不自己 fetch。
  assert.equal(account.includes('fetch('), false);
  assert.match(account, /import \{ requestApi/);
});

test('AdminShell 保留三个真实事件监听与路由首帧守卫，且无轮询/可见性/无参 session', () => {
  assert.match(shell, /addEventListener\('pointerdown'/);
  assert.match(shell, /addEventListener\('keydown'/);
  assert.match(shell, /addEventListener\('submit'/);
  assert.match(shell, /seenPath\.current === null/);
  assert.equal(shell.includes('visibilitychange'), false, '不监听可见性变化');
  assert.equal(shell.includes('setInterval'), false, '不轮询');
  assert.equal(shell.includes('useSession'), false, '不读无参 session');
  assert.equal(shell.includes("addEventListener('focus'"), false, '不在 shell 注册 focus 监听');
  // 活动上报统一走新组件导出的 reportAdminActivity（共享节流状态）。
  assert.match(shell, /import AdminSessionActivity, \{ reportAdminActivity \} from '@\/components\/admin\/auth\/AdminSessionActivity'/);
  assert.match(shell, /<AdminSessionActivity onUnauthorized=\{onUnauthorized\} \/>/);
});

test('账号数据源来自 GET /api/admin/account，401 清内容并取消在途', () => {
  assert.match(shell, /getAccount\(\{ signal: controller\.signal \}\)/);
  assert.match(shell, /const \[account, setAccount\] = useState<AccountDTO \| null>\(null\)/);
  assert.match(shell, /setAccountCleared\(true\)/);
  assert.match(shell, /accountAbort\.current\?\.abort\(\)/, '401 取消在途账号读取');
  assert.match(shell, /controller\.abort\(\)/, '卸载时取消在途');
});

test('admin-signout 执行真实 Auth.js signOut', () => {
  assert.match(shell, /import \{ signOut \} from 'next-auth\/react'/);
  assert.match(shell, /data-testid="admin-signout"/);
  assert.match(shell, /signOut\(\{ callbackUrl: '\/admin-login' \}\)/);
  assert.match(shell, /aria-label="退出登录"/);
});

test('角色菜单来自服务端会话；账号区展示 GET account 的角色', () => {
  assert.match(shell, /NAV\.filter\(\(n\) => !n\.adminOnly \|\| role === 'ADMIN'\)/);
  assert.match(shell, /data-testid="admin-account-role"/);
  assert.match(shell, /\{account\.role\}/);
});

test('活动组件只处理失焦/卸载取消与 401 清内容，不注册 DOM 真实事件监听', () => {
  assert.match(activity, /window\.addEventListener\('blur', onBlur\)/);
  assert.match(activity, /window\.addEventListener\('focus', onFocus\)/);
  assert.equal(activity.includes("document.addEventListener('pointerdown'"), false);
  assert.equal(activity.includes("addEventListener('visibilitychange'"), false, '不注册可见性监听');
  assert.equal(activity.includes('setInterval'), false);
});

test('admin.css 壳元素按 minimalist-flat：2px 黑边 / 0 圆角 / 无阴影 / #b45700 强调', () => {
  assert.match(css, /\.adm-top,\.adm-side,\.adm-main,\.adm-account\{/);
  assert.match(css, /border:var\(--pj-border-width\) solid var\(--pj-border\)/);
  assert.match(css, /border-radius:var\(--pj-radius\)/);
  assert.match(css, /box-shadow:var\(--pj-shadow\)/);
  assert.match(tokens, /--pj-accent:#b45700/, '强调色来自唯一 token');
  assert.match(css, /var\(--pj-accent\)/, '壳样式消费该 token');
  assert.match(css, /border-left:var\(--pj-border-width\) solid var\(--pj-accent\)/, '当前导航项用强调色标记');
  // 聚焦可见、触屏目标 ≥44px
  assert.match(css, /min-width:var\(--pj-touch-target\)/);
  assert.match(css, /min-height:var\(--pj-touch-target\)/);
  assert.match(css, /outline:var\(--pj-focus-width\) solid var\(--pj-accent\)/);
});

test('e2e 规格用独立管理员（不碰全局 E2E_ADMIN）、signOut 独立会话、开 video 供 CI 转 GIF', () => {
  assert.match(spec, /import \{ useSharedAdmin \} from '\.\/shared-admin'/);
  assert.match(spec, /useSharedAdmin\(\{ emailPrefix: 'e2e-shell'/);
  assert.equal(/import\s*\{[^}]*E2E_ADMIN[^}]*\}\s*from/.test(spec), false, '不得 import 全局共享管理员');
  assert.equal(/E2E_ADMIN\.(?:email|password)/.test(spec), false, '不得使用全局共享管理员的凭据');
  assert.equal(spec.includes('test.skip('), false, '不得靠 skip 换 CI 绿');
  // signOut 会撤销设备会话，必须单独建管理员/会话，不与主体组共用 beforeAll 的旧 cookie。
  assert.match(spec, /useSharedAdmin\(\{ emailPrefix: 'e2e-shell-signout'/, 'signOut 必须独立会话');
  assert.match(spec, /admin-signout 真退出（独立会话）/);
  assert.match(spec, /test\.use\(\{ video: 'on' \}\)/, '视频留给 CI 转 GIF');
  // 三尺寸真实壳元素与强调色都要断言，不能只量 signout 控件。
  assert.match(spec, /\.adm-side/);
  assert.match(spec, /\.adm-main/);
  assert.match(spec, /rgb\(180, 87, 0\)/, '当前导航强调色');
  assert.match(spec, /--pj-accent/, '强调色 token');
  // 顶栏桌面 display:none，只在窄屏断言其 2px/0/none。
  assert.match(spec, /顶栏桌面隐藏/);
  for (const w of ['1920', '1440', '390']) assert.ok(spec.includes(w), `${w} 尺寸必须覆盖`);
});

test('resetAdminActivityReporter 可丢弃单例，供测试与壳重置', () => {
  assert.doesNotThrow(() => resetAdminActivityReporter());
});
