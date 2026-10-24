// #347 前端完整页面：绑定页状态（UX spec v1.0–v1.0.4）、账号页重置 2FA（v1.0.5 / v1.0.6 验收）、离开确认框规则
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  errorText, KEEP_PAGE_HINT, NO_TOKEN_BODY, NO_TOKEN_SIGNIN, NO_TOKEN_TITLE, RESET_2FA_CONFIRM, SIGNIN_HREF, takeEnrollToken, tokenStateOf,
} from '../src/lib/admin/enroll';

const read = (f: string) => readFileSync(f, 'utf8');
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const WIZ = 'src/components/admin/enroll/EnrollWizard.tsx';
const USERS = 'src/components/admin/users/UsersAdmin.tsx';
const PANEL = 'src/components/admin/users/EnrollLinkPanel.tsx';
const TOKEN = 'FAKE_tok3n-000000000000000000000000000000000'.slice(0, 43);

test('绑定页文案按 spec：需要绑定链接 / 灰色提示 / 401 统一文案；429、invalid 沿用现有', () => {
  assert.equal(NO_TOKEN_TITLE, '需要绑定链接');
  assert.equal(NO_TOKEN_BODY, '这个页面只能从管理员发给你的绑定链接打开。如果你刚刚刷新了页面，请重新点开那个链接；链接失效的话请联系管理员重新发送。');
  assert.equal(NO_TOKEN_SIGNIN, '去登录');
  assert.equal(KEEP_PAGE_HINT, '请在这个页面完成绑定，不要刷新或关闭');
  assert.equal(errorText('bad_credentials'), '链接无效或已过期、邮箱或密码不正确，或尝试次数过多。请稍后重试；仍然不行的话，请联系管理员重新发送绑定链接。');
  assert.equal(errorText('rate_limited'), '尝试过多，请稍后再试');
  assert.equal(errorText('invalid'), '请求无效，请刷新页面重试');
  assert.ok(!/锁定/.test(errorText('bad_credentials')), '不单独说锁定（v1.0.4）');
});

test('令牌状态：hash 里没有 t → none；有 t（格式不对也算）→ present；query 里的 t 不读', () => {
  const none = takeEnrollToken({ pathname: '/admin-enroll', search: '', hash: '' });
  assert.equal(tokenStateOf(none.cleanUrl), 'none');
  const ok = takeEnrollToken({ pathname: '/admin-enroll', search: '', hash: `#t=${TOKEN}` });
  assert.deepEqual(ok, { token: TOKEN, cleanUrl: '/admin-enroll' });
  assert.equal(tokenStateOf(ok.cleanUrl), 'present');
  const bad = takeEnrollToken({ pathname: '/admin-enroll', search: '', hash: '#t=short' });
  assert.equal(bad.token, null); assert.equal(tokenStateOf(bad.cleanUrl), 'present');
  assert.equal(tokenStateOf(takeEnrollToken({ pathname: '/admin-enroll', search: `?t=${TOKEN}`, hash: '' }).cleanUrl), 'none');
});

test('EnrollWizard：读一次令牌（ref 防 StrictMode 二次执行误判）→ replaceState；首帧不闪；无令牌页；灰色提示', () => {
  const src = code(WIZ);
  assert.match(src, /if \(tokenRead\.current\) return;\s*tokenRead\.current = true;/);
  assert.match(src, /window\.history\.replaceState\(window\.history\.state, '', cleanUrl\)/);
  assert.match(src, /setTok\(tokenStateOf\(cleanUrl\)\)/);
  assert.match(src, /if \(tok === 'unknown'\) return <main className="en-wrap"><div className="en-card" aria-busy="true" \/><\/main>;/);
  assert.match(src, /if \(tok === 'none' && s\.step === 1\)/);
  assert.match(src, /<h1 ref=\{heading\} tabIndex=\{-1\}>\{NO_TOKEN_TITLE\}<\/h1>/);
  assert.match(src, /<a className="en-btn ghost" href=\{SIGNIN_HREF\}>\{NO_TOKEN_SIGNIN\}<\/a>/, '次要按钮「去登录」');
  assert.equal((src.match(/\{keepHint\}/g) ?? []).length, 2, '第 1、2 步的表单上方');
  assert.equal(SIGNIN_HREF, '/api/auth/signin?callbackUrl=%2Fadmin');
});

test('EnrollWizard 401：保留邮箱、清空密码并聚焦，不标红单个字段；令牌只在内存', () => {
  const src = code(WIZ);
  assert.match(src, /if \(r\.code === 'bad_credentials'\) \{ setPassword\(''\); setShowPw\(false\); focusPw\.current = true; \}/);
  assert.match(src, /pwInput\.current\?\.focus\(\)/);
  assert.match(src, /<input ref=\{pwInput\} id="en-pw"/);
  const step1 = src.slice(src.indexOf('<form onSubmit={start}>'), src.indexOf('</form>'));
  assert.doesNotMatch(step1, /aria-invalid/);
  assert.doesNotMatch(step1, /setEmail\(''\)/);
  assert.doesNotMatch(src, /localStorage|sessionStorage|console\.|router|searchParams/);
  // 页面上没有外链 / 第三方资源：所有 href / src 都是站内或本地生成
  for (const m of src.matchAll(/(?:href|src)=\{?["'`]?([^"'`}\s>]+)/g)) assert.doesNotMatch(m[1], /^https?:|^\/\//, m[0]);
  assert.doesNotMatch(src, /https?:\/\//);
});

test('账号页：一个面板服务新建和重置；重置用 pickEnrollLink + panelReducer；后端的 issued 块已删除', () => {
  const src = code(USERS);
  assert.doesNotMatch(src, /setIssued|issued &&|enrollLink: string/);
  assert.match(src, /const issued = pickEnrollLink\(await api<unknown>\(`\/\$\{u\.id\}\/reset-2fa`, \{ method: 'POST' \}\)\);/);
  assert.match(src, /if \(issued\) setLinkPanel\(\(s\) => panelReducer\(s, \{ type: 'issued', issued, email: u\.email \}\)\);/);
  assert.equal((src.match(/<EnrollLinkPanel /g) ?? []).length, 1);
  assert.ok(src.indexOf('<EnrollLinkPanel ') < src.indexOf('<form '), '面板在页面顶部（表单和表格之前），两个入口都看得到');
});

test('账号页「重置 2FA」：危险样式、行内最后一个、和其他按钮隔开；自己那一行不显示；确认框文案是后端的 RESET_2FA_CONFIRM', () => {
  const src = code(USERS);
  const cell = src.slice(src.lastIndexOf('<td>', src.indexOf('重置 2FA</button>')), src.indexOf('</td>', src.indexOf('重置 2FA</button>')));
  const parts = cell.split('<button ').slice(1);
  assert.ok(parts.length >= 3, '停用/启用、解锁、重置 2FA');
  assert.match(parts.at(-1)!, /重置 2FA<\/button>/, '「重置 2FA」是最后一个');
  for (const p of parts.slice(0, -1)) assert.doesNotMatch(p, /重置 2FA|danger/);
  assert.match(parts.at(-1)!, /className="adm-btn danger adm-row-last"/);
  assert.match(cell, /\{u\.id !== selfId && <button className="adm-btn danger adm-row-last"/);
  assert.doesNotMatch(cell, /编辑/);
  assert.match(src, /<ConfirmDialog title=\{RESET_2FA_CONFIRM\(resetTarget\.email\)\} confirmLabel="重置 2FA" danger onCancel=\{\(\) => setResetTarget\(null\)\}/);
  assert.match(RESET_2FA_CONFIRM('a@x.com'), /之前发出的绑定链接会立即失效，同时会解除这个账号的登录锁定。重置后，对方可能还要等最多 10 分钟才能重新登录。$/);
  assert.doesNotMatch(RESET_2FA_CONFIRM('a@x.com'), /按真实 IP 计的登录限流/);
  const page = code('src/app/admin/users/page.tsx');
  assert.match(page, /<UsersAdmin selfId=\{c\.ok \? c\.user\.id : undefined\} \/>/);
  const css = read('src/app/admin/admin.css');
  assert.match(css, /\.adm-btn\.danger\{[^}]*color:var\(--err\)/);
});

test('site_url_invalid 提示：后台错误样式（红底红边）+ role="alert"，位置不变（标题下方）', () => {
  const src = code(USERS);
  assert.match(src, /<h1>账号权限<\/h1>\s*\{err && <p role="alert" className="adm-msg err">\{err\}<\/p>\}/);
  assert.match(read('src/app/admin/admin.css'), /\.adm-msg\.err\{background:var\(--errb\);border-color:[^;]+;color:var\(--err\)/);
});

test('离开确认框 / 重置确认框：复用 ConfirmDialog（「离开」/「重置 2FA」为危险按钮，初始焦点在「取消」，Esc = 取消）', () => {
  assert.match(code(PANEL), /<ConfirmDialog title=\{PANEL_TEXT\.leave\} confirmLabel=\{PANEL_TEXT\.leaveOk\} onCancel=\{\(\) => setPending\(null\)\} onConfirm=\{leave\} danger>/);
  const dlg = code('src/components/admin/settings/ConfirmDialog.tsx');
  assert.match(dlg, /cancelRef\.current\?\.focus\(\);/, '打开时焦点在「取消」');
  assert.match(dlg, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); cancelCb\.current\(\); return; \}/, 'Esc = 取消');
  assert.match(dlg, /className=\{`adm-btn primary\$\{danger \? ' danger' : ''\}`\}/);
  assert.match(dlg, /role="alertdialog" aria-modal="true"/);
  assert.match(read('src/components/admin/settings/settings.css'), /\.adm-btn\.primary\.danger\{background:#C0392B/);
});
