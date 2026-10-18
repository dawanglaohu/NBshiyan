import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  afterConfirm, afterEnroll, assertEnrollPath, canFinish, CONFIRM_PATH, ENROLL_PAGE, ENROLL_PATH, ERROR_TEXT, errorText, groupSecret,
  inProgress, INITIAL, isCompleteCode, NEXT_CODE_WAIT_MS, normalizeCode, parseSecret, postEnroll, recoveryTxt, SIGNIN_HREF, stepStatus, waitLeft, type EnrollState,
} from '../src/lib/admin/enroll';
import { qrSvgDataUrl } from '../src/lib/admin/enroll-qr';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const URI = 'otpauth://totp/PackJoyU%20Admin:a%40b.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=PackJoyU%20Admin';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CODES = Array.from({ length: 10 }, (_, i) => `abcdef012${i}`);

test('P1 enroll: every backend error code maps to the UX spec §6 copy', () => {
  for (const c of ['bad_credentials', 'bad_totp', 'invalid', 'rate_limited', 'forbidden_origin']) assert.ok(ERROR_TEXT[c], c);
  assert.equal(errorText('bad_credentials'), '邮箱或密码错误，或该账号已绑定');
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

test('P1 enroll: code input keeps digits only (paste with spaces / dashes), max 6', () => {
  assert.equal(normalizeCode(' 123 456 '), '123456');
  assert.equal(normalizeCode('123-456'), '123456');
  assert.equal(normalizeCode('1234567'), '123456');
  assert.equal(normalizeCode('12a3'), '123');
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
  assert.match(ui, /maxLength=\{6\}/);
});

test('P1 enroll: page lives outside /admin, noindex + no-store, no locale prefix, robots covers it', () => {
  const layout = read('../src/app/admin-enroll/layout.tsx');
  assert.match(layout, /robots: \{ index: false, follow: false \}/);
  assert.match(layout, /<html lang="zh-CN"/);
  assert.doesNotMatch(layout, /checkAdminSession|redirect\(/);
  assert.match(read('../src/app/admin-enroll/page.tsx'), /export const dynamic = 'force-dynamic'/);
  const cfg = read('../next.config.ts');
  assert.match(cfg, /'\/api\/admin\/:path\*', '\/admin-enroll'\]\.map\(\(source\) => \(\{ source, headers: adminHeaders \}\)\)/);
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
  // 入口：账号权限页的「待绑定 2FA」
  const users = read('../src/components/admin/users/UsersAdmin.tsx');
  assert.match(users, /!u\.totpEnabled && <><br \/><a href=\{ENROLL_PAGE\}/);
  assert.doesNotMatch(users, /enroll-qr/);
});
