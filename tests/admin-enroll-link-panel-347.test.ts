import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React; // tsx 用经典 JSX 转换
import { renderToStaticMarkup } from 'react-dom/server';
import { ENROLL_LINK_RE, ISSUE_ERROR_TEXT, PANEL_TEXT, SITE_URL_INVALID_TEXT, fmtEnrollExpiry, panelReducer, pickEnrollLink, scopeIssueError, submitCreate } from '../src/lib/admin/enroll-link';
import { installLeaveGuard, isInSiteNavigation } from '../src/lib/admin/leave-guard';
import EnrollLinkPanel, { EnrollLinkPanelView } from '../src/components/admin/users/EnrollLinkPanel';

// 假令牌：43 个 base64url 字符的占位值，不是真链接
const TOKEN = 'FAKE_tok3n-000000000000000000000000000000000'.slice(0, 43);
const LINK = `https://geiom.com/admin-enroll#t=${TOKEN}`;
const RES = { id: 'u1', email: 'a@x.com', enrollLink: LINK, expiresAt: '2026-10-19T13:00:00.000Z', expiresTruncated: false };
const render = (p: Partial<Parameters<typeof EnrollLinkPanel>[0]> = {}) =>
  renderToStaticMarkup(React.createElement(EnrollLinkPanel, { issued: pickEnrollLink(RES)!, email: 'a@x.com', onDismiss: () => {}, ...p }));

test('pickEnrollLink：后端没返回字段（main 现状）→ null，页面不多显示任何东西', () => {
  assert.equal(TOKEN.length, 43);
  assert.equal(pickEnrollLink({ id: 'u1', email: 'a@x.com' }), null);
  assert.equal(pickEnrollLink({ ok: true, reenrollRequired: true }), null);
  assert.equal(pickEnrollLink(null), null);
  assert.equal(pickEnrollLink('x'), null);
  assert.deepEqual(pickEnrollLink(RES), { link: LINK, expiresAt: RES.expiresAt, truncated: false });
  assert.equal(pickEnrollLink({ ...RES, expiresTruncated: true })!.truncated, true);
  assert.equal(pickEnrollLink({ ...RES, expiresTruncated: 'true' })!.truncated, false, '只认布尔 true');
  assert.equal(pickEnrollLink({ ...RES, expiresTruncated: undefined })!.truncated, false);
});

test('pickEnrollLink：链接格式不对、截止时间无效一律不显示', () => {
  for (const bad of [
    `javascript:alert(1)//admin-enroll#t=${TOKEN}`, `https://geiom.com/admin-enroll?t=${TOKEN}`, `https://geiom.com/admin/enroll#t=${TOKEN}`,
    `https://geiom.com/admin-enroll#t=${TOKEN.slice(1)}`, `https://geiom.com/admin-enroll#t=${TOKEN}x`, `https://u:p@geiom.com/admin-enroll#t=${TOKEN}`,
    `https://geiom.com/x/admin-enroll#t=${TOKEN}`, `https://geiom.com/admin-enroll#t=${TOKEN.slice(0, 42)}=`, '', 42,
  ]) assert.equal(pickEnrollLink({ ...RES, enrollLink: bad }), null, String(bad));
  assert.ok(ENROLL_LINK_RE.test(`http://localhost:3000/admin-enroll#t=${TOKEN}`));
  assert.equal(pickEnrollLink({ ...RES, expiresAt: 'not-a-date' }), null);
  assert.equal(pickEnrollLink({ ...RES, expiresAt: undefined }), null);
});

test('fmtEnrollExpiry：固定按 America/Los_Angeles、24 小时制显示「YYYY-MM-DD HH:mm PT」（UX v1.0.6），夏令时 / 冬令时都对', () => {
  assert.equal(fmtEnrollExpiry('2026-10-19T13:41:00.000Z'), '2026-10-19 06:41 PT'); // PDT UTC-7
  assert.equal(fmtEnrollExpiry('2026-10-19T13:00:00.000Z'), '2026-10-19 06:00 PT');
  assert.equal(fmtEnrollExpiry('2026-12-01T20:05:00Z'), '2026-12-01 12:05 PT'); // PST UTC-8
  assert.equal(fmtEnrollExpiry('2026-11-01T07:59:00Z'), '2026-11-01 00:59 PT'); // 跨日
  assert.equal(fmtEnrollExpiry('2026-10-19T00:30:00Z'), '2026-10-18 17:30 PT');
  assert.equal(fmtEnrollExpiry('2026-10-19T06:15:00Z'), '2026-10-18 23:15 PT', '24 小时制');
  assert.equal(fmtEnrollExpiry('garbage'), null);
});

test('面板：只读链接框、复制链接、有效至 PT、只私信提示、我已复制；未截短时没有截短行', () => {
  const html = render();
  assert.match(html, /<input[^>]*readOnly=""/i);
  assert.ok(html.includes(`value="${LINK}"`));
  assert.ok(html.includes(`>${PANEL_TEXT.copy}<`));
  assert.ok(html.includes('有效至 2026-10-19 06:00 PT'));
  assert.ok(html.includes('只私信发给本人，离开此页后无法再查看。'));
  assert.ok(html.includes('>我已复制<'));
  assert.ok(!html.includes('已按账号绑定截止时间缩短'));
  assert.ok(!html.includes('24 小时'), '不写死 24 小时（v1.0.1）');
  // 不放外链、不加载任何资源；链接只出现在只读框的 value 里一次
  assert.doesNotMatch(html, /<a\b|href=|src=|<img|<script|<link/i);
  assert.equal(html.split(TOKEN).length - 1, 1);
});

test('面板：expiresTruncated 为 true 时在有效至下面多一行「已按账号绑定截止时间缩短」', () => {
  const html = render({ issued: pickEnrollLink({ ...RES, expiresTruncated: true })! });
  const i = html.indexOf('有效至 2026-10-19 06:00 PT'), j = html.indexOf('已按账号绑定截止时间缩短');
  assert.ok(i > 0 && j > i);
});

test('令牌不进 localStorage / sessionStorage / console（spy）', () => {
  const writes: string[] = [];
  const fakeStore = () => ({ setItem: (k: string, v: string) => writes.push(`${k}=${v}`), getItem: () => null, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 });
  const g = globalThis as Record<string, unknown>;
  const saved = { localStorage: g.localStorage, sessionStorage: g.sessionStorage };
  g.localStorage = fakeStore(); g.sessionStorage = fakeStore();
  const logged: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const orig = methods.map((m) => console[m]);
  methods.forEach((m) => { console[m] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); }; });
  try {
    const issued = pickEnrollLink(RES)!;
    let s = panelReducer(null, { type: 'issued', issued, email: 'a@x.com' });
    render({ issued }); render({ issued: { ...issued, truncated: true } });
    pickEnrollLink({ ...RES, enrollLink: `https://geiom.com/admin-enroll?t=${TOKEN}` });
    s = panelReducer(s, { type: 'dismiss' });
    assert.equal(s, null);
  } finally {
    methods.forEach((m, i) => { console[m] = orig[i]; });
    g.localStorage = saved.localStorage; g.sessionStorage = saved.sessionStorage;
  }
  assert.deepEqual(writes, []);
  assert.ok(!logged.some((l) => l.includes(TOKEN)), 'console 里不能出现令牌');
});

test('面板 state：签发→显示；「我已复制」→ 清空；重新签发直接替换旧链接', () => {
  const a = pickEnrollLink(RES)!;
  const b = pickEnrollLink({ ...RES, enrollLink: `https://geiom.com/admin-enroll#t=${'B'.repeat(43)}` })!;
  const s1 = panelReducer(null, { type: 'issued', issued: a, email: 'a@x.com' });
  assert.equal(s1?.issued.link, LINK);
  const s2 = panelReducer(s1, { type: 'issued', issued: b, email: 'a@x.com' });
  assert.ok(!JSON.stringify(s2).includes(TOKEN), '旧链接不留在 state 里');
  assert.equal(panelReducer(s2, { type: 'dismiss' }), null);
});

test('源码：链接相关文件不碰 URL / 路由 / storage / console / toast / 上报；关闭按钮只清 state', () => {
  const files = ['src/lib/admin/enroll-link.ts', 'src/lib/admin/leave-guard.ts', 'src/components/admin/users/EnrollLinkPanel.tsx', 'src/components/admin/users/UsersAdmin.tsx'];
  for (const f of files) {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|idb-keyval|document\.cookie|console\.|toast|Sentry|captureException|reportError|analytics|gtag|useRouter|next\/navigation|history\.|location\.|searchParams|postMessage|sendBeacon/, f);
  }
  const ua = readFileSync('src/components/admin/users/UsersAdmin.tsx', 'utf8');
  assert.match(ua, /onDismiss=\{\(\) => setLinkPanel\(\(s\) => panelReducer\(s, \{ type: 'dismiss' \}\)\)\}/);
  assert.match(ua, /\{linkPanel && <EnrollLinkPanel /, '只在 state 非 null 时渲染，置 null 即卸载');
  const panelSrc = readFileSync('src/components/admin/users/EnrollLinkPanel.tsx', 'utf8');
  // 面板里只有输入框、面板两个 DOM ref 和一个计时器 ref 和一个布尔 state，没有保存链接的 ref
  assert.equal(panelSrc.match(/\buseRef\b/g)?.length, 4, 'import + 3 个 ref');
  for (const r of ['useRef<HTMLInputElement>(null)', 'useRef<HTMLElement>(null)', 'useRef<ReturnType<typeof setTimeout> | null>(null)']) assert.ok(panelSrc.includes(r), r);
  // state 只有两个按钮布尔值和待确认的跳转函数，没有字符串 state
  assert.equal(panelSrc.match(/\buseState\b[<(]/g)?.length, 3);
  assert.match(panelSrc, /const \[copied, setCopied\] = useState\(false\)/);
  assert.match(panelSrc, /const \[hasCopied, setHasCopied\] = useState\(false\)/);
  assert.match(panelSrc, /const \[pending, setPending\] = useState<\(\(\) => void\) \| null>\(null\)/);
  // 离开提醒装在挂载 effect 里，effect 返回卸载函数（面板卸载 = 移除监听）
  assert.match(panelSrc, /useEffect\(\(\) => installLeaveGuard\(\{/);
  assert.match(ua, /submitCreate\(\(f\) => api<unknown>\('', \{ method: 'POST'/);
  // v1.0.6 文案：不再有 /admin-enroll 链接
  assert.doesNotMatch(ua, /ENROLL_PAGE|admin-enroll|绑定页：/);
  assert.ok(ua.includes('创建后会生成一次性绑定链接，只显示一次。请把初始密码和绑定链接分开私下发给本人，对方打开链接后用邮箱和初始密码绑定 2FA。链接失效或 2FA 被重置时，在这里重新签发。'));
  assert.ok(ua.includes('<span className="adm-sub">等本人打开绑定链接</span>'));
  assert.match(ua, /<div className="adm-table-wrap">\s*<table/);
});

type El = React.ReactElement<{ children?: unknown; onClick?: () => void }>;
function buttons(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { node.forEach((n) => buttons(n, out)); return out; }
  if (!node || typeof node !== 'object' || !('props' in node)) return out;
  const el = node as El;
  if (el.type === 'button') out.push(el);
  buttons(el.props.children, out);
  return out;
}
const textOf = (el: El) => [el.props.children].flat().join('');

test('点「我已复制」（关闭面板）：调用 onDismiss，父组件 state 置 null，链接不留在内存 / console / storage', () => {
  const logged: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const orig = methods.map((m) => console[m]);
  methods.forEach((m) => { console[m] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); }; });
  try {
    // 模拟 UsersAdmin：state 只有一处，onDismiss 用同一个 reducer 置 null
    let state = panelReducer(null, { type: 'issued', issued: pickEnrollLink(RES)!, email: 'a@x.com' });
    let copies = 0;
    const tree = EnrollLinkPanelView({ issued: state!.issued, email: state!.email, copied: false, onCopy: () => { copies++; }, onDismiss: () => { state = panelReducer(state, { type: 'dismiss' }); } });
    const bs = buttons(tree);
    assert.deepEqual(bs.map(textOf), ['复制链接', '我已复制']);
    bs[0].props.onClick!(); // 复制不关闭面板
    assert.equal(copies, 1); assert.notEqual(state, null);
    bs[1].props.onClick!(); // 「我已复制」= 关闭
    assert.equal(state, null);
    assert.ok(!JSON.stringify({ state }).includes(TOKEN));
  } finally { methods.forEach((m, i) => { console[m] = orig[i]; }); }
  assert.deepEqual(logged, [], '整个流程没有任何 console 输出');
});

test('「已复制」状态：按钮文案切换为「已复制」，链接值不变', () => {
  const tree = EnrollLinkPanelView({ issued: pickEnrollLink(RES)!, copied: true, onCopy: () => {}, onDismiss: () => {} });
  assert.deepEqual(buttons(tree).map(textOf), ['已复制', '我已复制']);
});

const cls = (el: El) => (el.props as { className?: string }).className;
test('按钮主次（UX v1.0.6）：没复制过时「复制链接」是主按钮；复制过后「我已复制」变主按钮', () => {
  const base = { issued: pickEnrollLink(RES)!, onCopy: () => {}, onDismiss: () => {} };
  const before = buttons(EnrollLinkPanelView({ ...base, copied: false, hasCopied: false }));
  assert.deepEqual(before.map(cls), ['adm-btn primary', 'adm-btn']);
  const after = buttons(EnrollLinkPanelView({ ...base, copied: false, hasCopied: true }));
  assert.deepEqual(after.map(cls), ['adm-btn', 'adm-btn primary']);
});

test('site_url_invalid：按接口分文案，不出现错误码', () => {
  assert.equal(SITE_URL_INVALID_TEXT.create, '账号没有创建：站点地址配置有误，请联系运维。');
  assert.equal(SITE_URL_INVALID_TEXT.reset2fa, '没有生成绑定链接：站点地址配置有误，请联系运维。');
  assert.equal(SITE_URL_INVALID_TEXT.self, '2FA 没有重置：站点地址配置有误，请联系运维。');
  assert.equal(ISSUE_ERROR_TEXT[scopeIssueError(new Error('site_url_invalid'), 'create').message], SITE_URL_INVALID_TEXT.create);
  assert.equal(ISSUE_ERROR_TEXT[scopeIssueError(new Error('site_url_invalid'), 'reset2fa').message], SITE_URL_INVALID_TEXT.reset2fa);
  assert.equal(ISSUE_ERROR_TEXT[scopeIssueError(new Error('site_url_invalid'), 'self').message], SITE_URL_INVALID_TEXT.self);
  assert.equal(scopeIssueError(new Error('email_taken'), 'create').message, 'email_taken');
  for (const t of Object.values(ISSUE_ERROR_TEXT)) assert.ok(!t.includes('site_url_invalid'));
  assert.ok(!Object.values(ISSUE_ERROR_TEXT).some((t) => t.includes('2FA 已重置')), '没有「已重置但链接失败」的备用文案');
});

test('新建账号 site_url_invalid：表单不清空（含初始密码），不显示面板；成功才清空', async () => {
  const form = { email: 'new@x.com', name: 'New', role: 'SALES', password: 'Initial-Password-123' };
  let current = { ...form };
  let issuedCalls = 0;
  const h = { onIssued: () => { issuedCalls++; }, onCreated: () => { current = { email: '', name: '', role: 'SALES', password: '' }; } };
  const fail = async () => { throw new Error('site_url_invalid'); };
  await assert.rejects(submitCreate(fail, current, h), (e: Error) => e.message === 'site_url_invalid:create');
  assert.deepEqual(current, form, '所有值保留，包括密码');
  assert.equal(issuedCalls, 0);
  let sent: unknown = null;
  await submitCreate(async (f) => { sent = f; return RES; }, current, h);
  assert.deepEqual(sent, form, '提交的是原样的表单');
  assert.equal(issuedCalls, 1);
  assert.deepEqual(current, { email: '', name: '', role: 'SALES', password: '' });
  // 后端未上线（没有链接字段）：照常清空，不显示面板
  await submitCreate(async () => ({ id: 'u' }), form, h);
  assert.equal(issuedCalls, 1);
});

// ---- 离开提醒（UX v1.0.6）----
type Rec = { type: string; h: unknown; capture: unknown };
function fakeTarget() {
  const added: Rec[] = [], removed: Rec[] = [];
  const cap = (o: unknown) => (typeof o === 'boolean' ? o : !!(o as { capture?: boolean } | undefined)?.capture);
  return {
    added, removed,
    t: { addEventListener: (type: string, h: unknown, o?: unknown) => { added.push({ type, h, capture: cap(o) }); }, removeEventListener: (type: string, h: unknown, o?: unknown) => { removed.push({ type, h, capture: cap(o) }); } },
  };
}
const HERE = 'https://geiom.com/admin/users';
function click(a: Partial<{ href: string; target: string; download: boolean }> | null, over: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; defaultPrevented: boolean }> = {}) {
  let clicked = 0;
  const anchor = a && { href: a.href ?? '', target: a.target ?? '', hasAttribute: (n: string) => n === 'download' && !!a.download, click: () => { clicked++; } };
  const ev = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over, prevented: 0, stopped: 0,
    target: { closest: () => anchor }, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } };
  return { ev, clicked: () => clicked };
}

test('离开提醒：装上时加 beforeunload（window）和捕获阶段 click（document）；卸载时用同一个函数和 capture 移除', () => {
  const w = fakeTarget(), d = fakeTarget();
  const off = installLeaveGuard({ win: w.t, doc: d.t, here: () => HERE, message: PANEL_TEXT.leave, onIntercept: () => {} });
  assert.deepEqual(w.added.map((r) => r.type), ['beforeunload']);
  assert.deepEqual(d.added.map((r) => [r.type, r.capture]), [['click', true]]);
  assert.equal(w.removed.length + d.removed.length, 0);
  off();
  assert.deepEqual(w.removed, w.added);
  assert.deepEqual(d.removed, d.added);
  off(); // 重复卸载不重复移除
  assert.equal(w.removed.length + d.removed.length, 2);
});

test('离开提醒：beforeunload 调 preventDefault 并设 returnValue', () => {
  const w = fakeTarget(), d = fakeTarget();
  installLeaveGuard({ win: w.t, doc: d.t, here: () => HERE, message: PANEL_TEXT.leave, onIntercept: () => {} });
  const e = { prevented: false, returnValue: '' as unknown, preventDefault() { this.prevented = true; } };
  (w.added[0].h as (e: unknown) => void)(e);
  assert.equal(e.prevented, true); assert.equal(e.returnValue, '绑定链接还没复制，离开后就不能再查看了。确定离开吗？');
});

test('离开提醒：站内链接被拦下并弹确认；确认后先移除监听再重新点原链接', () => {
  const w = fakeTarget(), d = fakeTarget();
  let proceed = null as (() => void) | null;
  installLeaveGuard({ win: w.t, doc: d.t, here: () => HERE, message: PANEL_TEXT.leave, onIntercept: (p) => { proceed = p; } });
  const handler = d.added[0].h as (e: unknown) => void;
  const c = click({ href: 'https://geiom.com/admin/inquiries' });
  handler(c.ev);
  assert.equal(c.ev.prevented, 1); assert.equal(c.ev.stopped, 1, '阻止 next/link 的 onClick');
  assert.ok(proceed); assert.equal(c.clicked(), 0);
  proceed!();
  assert.equal(w.removed.length, 1); assert.equal(d.removed.length, 1);
  assert.equal(c.clicked(), 1);
});

test('离开提醒：不拦外站、新窗口、下载、修饰键、非左键、只改 hash、非链接点击', () => {
  const cases = [
    click({ href: 'https://example.org/x' }), click({ href: '/admin/inquiries', target: '_blank' }), click({ href: '/admin/x.csv', download: true }),
    click({ href: '/admin/inquiries' }, { metaKey: true }), click({ href: '/admin/inquiries' }, { ctrlKey: true }), click({ href: '/admin/inquiries' }, { button: 1 }),
    click({ href: '/admin/users#top' }), click(null), click({ href: '/admin/inquiries' }, { defaultPrevented: true }),
  ];
  for (const c of cases) assert.equal(isInSiteNavigation(c.ev, HERE), null);
  assert.ok(isInSiteNavigation(click({ href: '/admin/settings' }).ev, HERE));
  assert.ok(isInSiteNavigation(click({ href: '/admin/users?all=1' }).ev, HERE));
});
