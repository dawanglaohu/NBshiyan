import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  afterConfirm, afterEnroll, assertEnrollPath, canFinish, CONFIRM_PATH, ENROLL_PAGE, ENROLL_PATH, ERROR_TEXT, errorText, groupSecret,
  codeCheck, CODE_LEN, inProgress, INITIAL, isCompleteCode, NEXT_CODE_WAIT_MS, normalizeCode, parseSecret, postEnroll, recoveryTxt, SIGNIN_HREF, stepStatus, waitLeft, type EnrollState,
} from '../src/lib/admin/enroll';
import { qrSvgDataUrl } from '../src/lib/admin/enroll-qr';

// 源码断言按逻辑行比较。recovery .txt 的 CRLF 是文件格式，不从这里读。
const lf = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const read = (p: string) => lf(readFileSync(new URL(p, import.meta.url), 'utf8'));
const URI = 'otpauth://totp/PackJoyU%20Admin:a%40b.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=PackJoyU%20Admin';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CODES = Array.from({ length: 10 }, (_, i) => `abcdef012${i}`);

test('P1 enroll: every backend error code maps to the UX spec §6 copy', () => {
  for (const c of ['bad_credentials', 'bad_totp', 'invalid', 'rate_limited', 'forbidden_origin']) assert.ok(ERROR_TEXT[c], c);
  assert.equal(errorText('bad_credentials'), '链接无效或已过期、邮箱或密码不正确，或尝试次数过多。请稍后重试；仍然不行的话，请联系管理员重新发送绑定链接。');
  assert.equal(errorText('bad_totp'), '验证码不正确或已过期');
  assert.equal(errorText('rate_limited'), '尝试过多，请稍后再试');
  assert.equal(errorText('invalid'), '请求无效，请刷新页面重试');
  assert.match(errorText('forbidden_origin'), /^请求无效，请刷新页面重试/);
  assert.match(errorText('forbidden_origin'), /配置错误.*运维/);
  assert.equal(errorText('http_500'), errorText(undefined));
  assert.ok(errorText('whatever').length > 0);
  // 文案只说「身份验证器 App」，不提具体品牌
  const all = Object.values(ERROR_TEXT).join() + read('../src/components/admin/enroll/EnrollWizard.tsx');
  assert.doesNotMatch(all, /Google Authenticator|Authy|Microsoft Authenticator|1Password/i);
  assert.match(all, /身份验证器 App/);
});

test('P1 enroll: secret parsed from otpauth URI and grouped by 4', () => {
  assert.equal(parseSecret(URI), SECRET);
  assert.equal(parseSecret('otpauth://totp/x?secret=jbsw y3dp=='), 'JBSWY3DP');
  for (const bad of [null, '', 'not a uri', 'https://evil.test/?secret=JBSWY3DP', 'otpauth://totp/x', 'otpauth://totp/x?secret=abc!1'])
    assert.equal(parseSecret(bad), null, String(bad));
  assert.equal(groupSecret(SECRET), 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
  assert.equal(groupSecret('ABCDEF'), 'ABCD EF');
});

test('P1 enroll: code input keeps digits only (paste with spaces / dashes); >6 digits kept and flagged, not truncated', () => {
  assert.equal(normalizeCode(' 123 456 '), '123456');
  assert.equal(normalizeCode('123-456'), '123456');
  assert.equal(normalizeCode('12a3'), '123');
  // e2e/admin-enroll.spec.ts 的场景 + PM 要求的用例
  assert.equal(normalizeCode('751 940'), '751940');
  assert.equal(normalizeCode('751-940'), '751940');
  assert.equal(normalizeCode(' 751940 '), '751940');
  assert.equal(normalizeCode('751\u00a0940\n'), '751940');
  assert.equal(normalizeCode('７５１ ９４０'), '751940'); // 全角数字转半角
  assert.equal(normalizeCode('٧٥١٩٤٠'), ''); // 其他文字的数字不接受（后端只认 ASCII 0-9）
  assert.equal(normalizeCode(''), '');
  // 超过 6 位：不截断，全部保留，交给 codeCheck 判 long
  assert.equal(normalizeCode('7519401'), '7519401');
  assert.equal(normalizeCode('751 940 1234'), '7519401234');
  assert.equal(codeCheck(normalizeCode('751 940')), 'ok');
  assert.equal(codeCheck(normalizeCode(' 751940 ')), 'ok');
  assert.equal(codeCheck(normalizeCode('7519401')), 'long');
  assert.equal(codeCheck(normalizeCode('75194')), 'short');
  assert.equal(codeCheck(''), 'short');
  assert.equal(CODE_LEN, 6);
  assert.ok(isCompleteCode('012345'));
  assert.ok(!isCompleteCode('12345'));
  assert.ok(!isCompleteCode('12345a'));
});

test('P1 enroll: steps cannot be skipped; 2 and 3 only reachable via successful API calls; no regenerate', () => {
  let s: EnrollState = INITIAL;
  assert.equal(s.step, 1);
  assert.equal(inProgress(s), false);
  assert.equal(afterConfirm(s, CODES, 0), s, 'confirm result ignored on step 1');
  assert.equal(afterEnroll(s, 'otpauth://totp/x'), s, 'URI without secret ignored');
  s = afterEnroll(s, URI);
  assert.equal(s.step, 2);
  assert.equal(inProgress(s), true);
  assert.equal(afterEnroll(s, URI), s, 'no second enroll from step 2 (no regenerate)');
  assert.equal(afterConfirm(s, [], 0), s);
  assert.equal(canFinish(s, 1e15), false);
  s = afterConfirm(s, CODES, 1_000);
  assert.equal(s.step, 3);
  assert.equal(s.otpauthUri, null, 'secret dropped once confirmed');
  assert.equal(s.confirmedAt, 1_000);
  assert.equal(inProgress(s), true);
  assert.equal(canFinish(s, 1e15), false, 'must tick "saved" first');
  s = { ...s, saved: true };
  assert.equal(NEXT_CODE_WAIT_MS, 30_000);
  assert.equal(waitLeft(s, 1_000), 30_000);
  assert.equal(canFinish(s, 1_000 + 29_999), false, 'wait for the next TOTP code (reuse counts toward lockout)');
  assert.equal(waitLeft(s, 1_000 + 29_001), 999);
  assert.equal(canFinish(s, 1_000 + 30_000), true);
  assert.deepEqual([1, 2, 3].map((n) => stepStatus(2, n as 1 | 2 | 3)), ['done', 'current', 'todo']);
});

test('P1 enroll: recovery .txt is exactly 10 lines, one code per line', () => {
  const t = recoveryTxt(CODES);
  assert.equal(t, CODES.map((c) => `${c}\r\n`).join(''));
  assert.equal(t.trimEnd().split('\r\n').length, 10);
  assert.doesNotMatch(t, /secret|otpauth|@/i);
});

test('P1 enroll: requests only go to the two same-origin relative enroll endpoints', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ otpauthUri: URI }), { status: 200 }); };
  const r = await postEnroll<{ otpauthUri: string }>(ENROLL_PATH, { email: 'a@b.test', password: 'pw' }, f);
  assert.deepEqual(r, { ok: true, data: { otpauthUri: URI } });
  await postEnroll(CONFIRM_PATH, { email: 'a@b.test', password: 'pw', totp: '123456' }, f);
  assert.deepEqual(calls.map((c) => c.url), [ENROLL_PATH, CONFIRM_PATH]);
  for (const c of calls) {
    assert.ok(c.url.startsWith('/api/auth-admin/') && !c.url.startsWith('//'), c.url);
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.credentials, 'same-origin');
    assert.equal(c.init.cache, 'no-store');
  }
  for (const bad of ['https://api.qrserver.com/v1/create-qr-code/', '//evil.test/api/auth-admin/enroll', '/api/auth-admin/enroll?x=1', '/api/admin/users']) {
    assert.throws(() => assertEnrollPath(bad), /enroll_path_not_allowed/, bad);
    const n = calls.length;
    await assert.rejects(postEnroll(bad, {}, f));
    assert.equal(calls.length, n, `no fetch for ${bad}`);
  }
});

test('P1 enroll: server error codes and network failures surface as codes', async () => {
  const reply = (status: number, body: unknown) => async () => new Response(body === undefined ? 'x' : JSON.stringify(body), { status });
  assert.deepEqual(await postEnroll(ENROLL_PATH, {}, reply(401, { error: 'bad_credentials' })), { ok: false, code: 'bad_credentials' });
  assert.deepEqual(await postEnroll(CONFIRM_PATH, {}, reply(401, { error: 'bad_totp' })), { ok: false, code: 'bad_totp' });
  assert.deepEqual(await postEnroll(ENROLL_PATH, {}, reply(400, { error: 'invalid' })), { ok: false, code: 'invalid' });
  assert.deepEqual(await postEnroll(ENROLL_PATH, {}, reply(429, undefined)), { ok: false, code: 'rate_limited' });
  assert.deepEqual(await postEnroll(ENROLL_PATH, {}, reply(403, undefined)), { ok: false, code: 'forbidden_origin' });
  assert.deepEqual(await postEnroll(ENROLL_PATH, {}, reply(502, undefined)), { ok: false, code: 'http_502' });
  assert.deepEqual(await postEnroll(ENROLL_PATH, {}, async () => { throw new TypeError('fail'); }), { ok: false, code: 'network' });
});

test('P1 enroll: QR is a locally built SVG data URL with only our own markup', () => {
  const url = qrSvgDataUrl(URI);
  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'));
  const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) \1"[^>]*><rect [^>]*\/><path d="[Mhvz0-9 -]+" fill="#000"\/><\/svg>$/);
  assert.ok(!svg.includes('secret') && !svg.includes(SECRET), 'URI text is not embedded in the SVG');
  assert.equal(qrSvgDataUrl(URI), url, 'deterministic');
  // 版本 ≥ 1：21 模块 + 2×4 边距
  assert.ok(Number(svg.match(/viewBox="0 0 (\d+)/)![1]) >= 29);
});

test('P1 enroll: no storage / logging / innerHTML / external URLs; download revokes Blob URL; callback hardcoded', () => {
  const ui = read('../src/components/admin/enroll/EnrollWizard.tsx');
  const libs = read('../src/lib/admin/enroll.ts') + read('../src/lib/admin/enroll-qr.ts');
  for (const src of [ui, libs]) {
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/);
    assert.doesNotMatch(src, /console\.|dangerouslySetInnerHTML|innerHTML/);
    assert.doesNotMatch(src, /useSearchParams|location\.(search|href|hash)|searchParams\.get\('(callback|redirect)/);
    assert.doesNotMatch(src.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ''), /https?:\/\//, 'no absolute URLs (no external QR service)');
  }
  assert.equal(SIGNIN_HREF, '/api/auth/signin?callbackUrl=%2Fadmin');
  const dl = ui.slice(ui.indexOf('const download'), ui.indexOf('const goto'));
  assert.ok(dl.indexOf('new Blob(') > 0 && dl.indexOf('a.click()') > dl.indexOf('createObjectURL') && dl.indexOf('revokeObjectURL(url)') > dl.indexOf('a.click()'), dl);
  assert.match(dl, /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 10_000\)/, 'revoke must be deferred (#353 P2)');
  // 敏感数据清理：完成、pagehide、卸载
  assert.match(ui, /addEventListener\('pagehide', wipe\)/);
  assert.match(ui, /return \(\) => \{ window\.removeEventListener\('pagehide', wipe\); wipe\(\); \}/);
  const go = ui.slice(ui.indexOf('const goSignin'), ui.indexOf('const topErr'));
  assert.match(go, /if \(!ready\) \{ e\.preventDefault\(\); return; \}/);
  assert.match(go, /wipe\(\); setEmail\(''\);/);
  assert.match(ui, /const wipe = useCallback\(\(\) => \{ setPassword\(''\); setCode\(''\); setS\(INITIAL\); \}/);
  assert.match(ui, /href=\{SIGNIN_HREF\}/);
  // 「请等待下一个验证码」常驻在「去登录」正上方
  const w = ui.indexOf('请等待下一个验证码（约 30 秒）再登录'), btn = ui.indexOf('>去登录</a>\n');
  assert.ok(w > 0 && btn > w && !ui.slice(w, btn).includes('</div>'), 'wait hint sits right above the sign-in button');
  const rawUi = readFileSync(new URL('../src/components/admin/enroll/EnrollWizard.tsx', import.meta.url), 'utf8');
  const crlfUi = lf(rawUi).replace(/\n/g, '\r\n');
  const above = (src: string) => {
    const hint = src.indexOf('请等待下一个验证码（约 30 秒）再登录');
    const signIn = src.indexOf('>去登录</a>\n');
    return hint > 0 && signIn > hint && !src.slice(hint, signIn).includes('</div>');
  };
  assert.equal(above(crlfUi), false, 'CRLF checkout misses an LF-only needle');
  assert.equal(above(lf(crlfUi)), true);
  assert.equal(above(lf(crlfUi).replace('请等待下一个验证码（约 30 秒）再登录', '请等待下一个验证码（约 30 秒）再登录</div>')), false);
  assert.doesNotMatch(ui, /重新生成/);
  assert.match(ui, /尚未完成绑定/);
  // a11y：错误 role=alert、状态 aria-live、标题可聚焦、验证码输入属性
  assert.match(ui, /role="alert"/);
  assert.match(ui, /aria-live="polite"/);
  assert.match(ui, /ref=\{heading\} tabIndex=\{-1\}/);
  assert.match(ui, /inputMode="numeric" autoComplete="one-time-code"/);
  assert.match(ui, /autoComplete="username"/);
  assert.match(ui, /autoComplete="current-password"/);
  assert.match(ui, /aria-disabled=\{ready \? undefined : true\}/);
  assert.match(ui, /width=\{216\} height=\{216\}/);
  // 验证码框不能用 maxLength：浏览器会按原始字符截断，「751 940」会丢最后一位；长度由 normalizeCode 限制
  assert.doesNotMatch(ui.slice(ui.indexOf('id="en-otp"'), ui.indexOf('/>', ui.indexOf('id="en-otp"'))), /maxLength/);
  assert.match(ui, /onChange=\{\(e\) => setCode\(normalizeCode\(e\.target\.value\)\)\}/);
  // 不是正好 6 位就禁用提交；超过 6 位时输入框下方提示
  assert.match(ui, /disabled=\{busy \|\| codeLen !== 'ok'\}/);
  assert.match(ui, /codeLen === 'long' \? 'code_incomplete'/);
  assert.match(ui, /codeCheck\(code\) !== 'ok' \|\| !isCompleteCode\(code\)\) return;/);
});

test('P1 enroll: page lives outside /admin, noindex + no-store, no locale prefix, robots covers it', () => {
  const layout = read('../src/app/admin-enroll/layout.tsx');
  assert.match(layout, /robots: \{ index: false, follow: false \}/);
  assert.match(layout, /<html lang="zh-CN"/);
  assert.doesNotMatch(layout, /checkAdminSession|redirect\(/);
  assert.match(read('../src/app/admin-enroll/page.tsx'), /export const dynamic = 'force-dynamic'/);
  const cfg = read('../next.config.ts');
  assert.match(cfg, /'\/api\/admin\/:path\*', '\/admin-enroll', '\/admin-login'\]\.map\(\(source\) => \(\{ source, headers: adminHeaders \}\)\)/);
  assert.match(cfg, /key: 'Cache-Control', value: 'no-store'/);
  // middleware matcher 的前缀排除覆盖 /admin-enroll（不走 next-intl，不会被加 /en 前缀）
  const mw = read('../src/middleware.ts');
  const m = mw.match(/'\/\(\(\?!([^)]*)\)\.\*\)'/)!;
  const re = new RegExp(`^/((?!${m[1].replace(/\\\\/g, '\\')}).*)$`);
  assert.equal(re.test('/admin-enroll'), false);
  assert.equal(re.test('/en/about'), true);
  assert.match(read('../src/app/robots.ts'), /disallow: \['\/admin',/);
  assert.equal(ENROLL_PAGE, '/admin-enroll');
  assert.ok(ENROLL_PAGE.startsWith('/admin'), 'robots Disallow: /admin is a prefix match');
  // 入口：#347 起只能从一次性绑定链接打开（UX v1.0.6），账号权限页「待绑定 2FA」下面只写「等本人打开绑定链接」，不再链到 /admin-enroll
  const users = read('../src/components/admin/users/UsersAdmin.tsx');
  assert.match(users, /!u\.totpEnabled && <><br \/><span className="adm-sub">等本人打开绑定链接<\/span><\/>/);
  assert.doesNotMatch(users, /href=\{ENROLL_PAGE\}/);
  assert.doesNotMatch(users, /enroll-qr/);
});

test('#350 enroll_reset（401）：绑定作废 → 清掉二维码 / 密钥，「重新开始绑定」回到第 1 步；文案不透露账号是否存在', async () => {
  const m = await import('../src/lib/admin/enroll');
  assert.ok(m.isVoidCode('enroll_reset'));
  for (const c of ['bad_credentials', 'bad_totp', 'rate_limited', 'invalid', 'forbidden_origin', undefined, null, ''])
    assert.equal(m.isVoidCode(c as string), false, String(c));
  // 其他码保持原文案
  assert.equal(m.errorText('bad_credentials'), '链接无效或已过期、邮箱或密码不正确，或尝试次数过多。请稍后重试；仍然不行的话，请联系管理员重新发送绑定链接。');
  assert.equal(m.errorText('bad_totp'), '验证码不正确或已过期');
  assert.equal(m.errorText('rate_limited'), '尝试过多，请稍后再试');
  // 作废：只在第 2 步发生，丢掉 otpauth URI，离开不再提醒，不能再确认
  let s = m.afterEnroll(m.INITIAL, URI);
  s = m.afterVoid(s);
  assert.equal(s.voided, true);
  assert.equal(s.otpauthUri, null);
  assert.equal(m.parseSecret(s.otpauthUri), null);
  assert.equal(m.inProgress(s), false);
  assert.equal(m.afterConfirm(s, CODES, 0), s, 'voided binding cannot be confirmed');
  assert.equal(m.afterVoid(m.INITIAL), m.INITIAL, 'void only applies on step 2');
  // 「重新开始绑定」= 回到初始状态（第 1 步）
  const wiz = read('../src/components/admin/enroll/EnrollWizard.tsx');
  assert.match(wiz, /const restart = \(\) => \{ setError\(null\); setShowPw\(false\); wipe\(\); setEmail\(''\); \}/);
  assert.match(wiz, /const wipe = useCallback\(\(\) => \{ setPassword\(''\); setCode\(''\); setS\(INITIAL\); \}/);
  assert.match(wiz, /isVoidCode\(r\.code\)\) \{ setCode\(''\); setS\(\(p\) => afterVoid\(p\)\)/);
  assert.equal(m.INITIAL.step, 1);
  // 文案（PM 定稿，集中在常量里）
  assert.equal(m.ENROLL_VOID_TEXT, '验证失败次数过多，此绑定已作废，请重新开始绑定');
  assert.equal(m.ENROLL_RESTART, '重新开始绑定');
  for (const t of [m.ENROLL_VOID_TEXT, m.ENROLL_VOID_HINT, m.ENROLL_VOID_FOOT]) assert.doesNotMatch(t, /不存在|未注册|账号存在|exist/i);
});
