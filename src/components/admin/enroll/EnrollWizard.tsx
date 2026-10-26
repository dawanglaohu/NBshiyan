'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { commitAndReveal } from '@/components/admin/reveal-error';
import {
  afterConfirm, afterEnroll, afterVoid, canFinish, codeCheck, CONFIRM_PATH, ENROLL_PATH, ENROLL_RESTART, ENROLL_VOID_FOOT, ENROLL_VOID_HINT, ENROLL_VOID_TEXT, errorText, isVoidCode, groupSecret, inProgress, INITIAL, isCompleteCode,
  KEEP_PAGE_HINT, NO_TOKEN_BODY, NO_TOKEN_SIGNIN, NO_TOKEN_TITLE, normalizeCode, parseSecret, postEnroll, recoveryFilename, recoveryTxt, SIGNIN_HREF, STEPS, stepStatus,
  takeEnrollToken, tokenStateOf, waitLeft, type EnrollState, type Step, type TokenState,
} from '@/lib/admin/enroll';
import { qrSvgDataUrl } from '@/lib/admin/enroll-qr';

const LEAVE_WARNING = '尚未完成绑定';
const TITLES: Record<Step, string> = { 1: '绑定两步验证', 2: '扫码并确认', 3: '保存恢复码' };

/**
 * P1：新管理员首次绑定 2FA（UX 稿 spec §6：账号验证 → 扫码并确认 → 保存恢复码）。
 * 密码、otpauth URI、恢复码只放在 React state 里：不写 URL、不写浏览器本地存储、不打日志；
 * 去登录、页面隐藏（pagehide）、卸载时都清掉。
 * #347 方案 A：打开时从 #t= 读一次性绑定令牌，立即 history.replaceState 去掉，令牌只放在内存（ref）里，随 enroll / confirm 一起提交；
 * 确认成功或去登录时清掉。UX spec v1.0–v1.0.4：hash 里没有 t →「需要绑定链接」页；有 t → 表单上方灰色「不要刷新或关闭」提示；
 * 401 bad_credentials 统一文案（不区分令牌 / 密码 / 锁定），保留邮箱、清空密码并聚焦，不标红单个字段。
 */
export default function EnrollWizard() {
  const [s, setS] = useState<EnrollState>(INITIAL);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<{ code: string; at: 'top' | 'code' } | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const leaving = useRef(false);
  const enrollToken = useRef<string | null>(null);
  const tokenRead = useRef(false);
  const pwInput = useRef<HTMLInputElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLParagraphElement>(null);
  const showError = (code: string, at: 'top' | 'code') => {
    commitAndReveal(at === 'code' ? codeRef : topRef, () => setError({ code, at }));
  };
  const focusPw = useRef(false);
  const [tok, setTok] = useState<TokenState>('unknown');

  // #347：读出地址栏里的令牌后马上去掉（不进历史记录、Referer、截图），StrictMode 下第二次执行时地址栏已经没有 t，不覆盖
  // 只读一次（ref 标记）：StrictMode 第二次执行时地址栏已经没有 t，不能因此切成「需要绑定链接」
  useEffect(() => {
    if (tokenRead.current) return;
    tokenRead.current = true;
    const { token, cleanUrl } = takeEnrollToken(window.location);
    if (cleanUrl !== null) {
      enrollToken.current = token;
      window.history.replaceState(window.history.state, '', cleanUrl);
    }
    setTok(tokenStateOf(cleanUrl));
  }, []);
  const withToken = (body: Record<string, string>) => (enrollToken.current ? { ...body, token: enrollToken.current } : body);

  const secret = useMemo(() => parseSecret(s.otpauthUri), [s.otpauthUri]);
  const qr = useMemo(() => (s.otpauthUri ? qrSvgDataUrl(s.otpauthUri) : null), [s.otpauthUri]);

  const wipe = useCallback(() => { setPassword(''); setCode(''); setS(INITIAL); }, []);

  // 每一步切换后焦点移到该步标题（首次进入页面不抢焦点）
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    heading.current?.focus();
  }, [s.step]);

  // 绑定进行中离开页面要提醒（点「去登录」除外）；页面隐藏 / 卸载时清掉所有敏感数据
  const enrolling = inProgress(s);
  useEffect(() => {
    if (!enrolling) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault(); e.returnValue = LEAVE_WARNING; return LEAVE_WARNING;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [enrolling]);
  useEffect(() => {
    window.addEventListener('pagehide', wipe);
    return () => { window.removeEventListener('pagehide', wipe); wipe(); };
  }, [wipe]);

  useEffect(() => {
    if (!focusPw.current || error?.code !== 'bad_credentials') return;
    focusPw.current = false;
    pwInput.current?.focus();
  }, [error]);

  // 第 3 步：确认后 30 秒倒计时（确认用掉的码登录时再用会失败并计入锁定次数）
  const left = Math.ceil(waitLeft(s, now) / 1000);
  // 验证码框下方的红字：超过 6 位时提示「请输入 6 位数字验证码」，优先于接口返回的验证码错误；不足 6 位不提示
  const codeLen = codeCheck(code);
  const codeErr = codeLen === 'long' ? 'code_incomplete' : error?.at === 'code' ? error.code : null;
  useEffect(() => {
    if (s.step !== 3 || s.confirmedAt === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [s.step, s.confirmedAt]);
  const ready = canFinish(s, now);
  const waitDone = s.step === 3 && left === 0;
  useEffect(() => { if (waitDone) setStatus('已过 30 秒，可以用下一个验证码登录了。'); }, [waitDone]);

  const say = (m: string) => { setStatus(''); requestAnimationFrame(() => setStatus(m)); };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const r = await postEnroll<{ otpauthUri: string }>(ENROLL_PATH, withToken({ email: email.trim(), password }));
    setBusy(false);
    if (!r.ok) {
      // 401 统一文案：保留邮箱、清空密码并聚焦（下面的 effect 在渲染后聚焦）
      if (r.code === 'bad_credentials') { setPassword(''); setShowPw(false); focusPw.current = true; }
      showError(r.code, 'top'); return;
    }
    if (!parseSecret(r.data.otpauthUri)) { showError('unknown', 'top'); return; }
    setShowPw(false);
    setS((p) => afterEnroll(p, r.data.otpauthUri));
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    // 不是正好 6 位数字就不发请求（按钮已禁用；这里再挡一次回车提交）
    if (codeCheck(code) !== 'ok' || !isCompleteCode(code)) return;
    setBusy(true); setError(null);
    const r = await postEnroll<{ recoveryCodes: string[] }>(CONFIRM_PATH, withToken({ email: email.trim(), password, totp: code }));
    setBusy(false);
    // 出错不清空输入框；验证码类错误显示在输入框下方，其他在顶部
    // #350 失败过多、绑定作废：清掉验证码和二维码，只留「重新开始绑定」（错误码待后端定，见 ENROLL_VOID_CODES）
    if (!r.ok && isVoidCode(r.code)) { setCode(''); setS((p) => afterVoid(p)); return; }
    if (!r.ok) { showError(r.code, r.code === 'bad_totp' || r.code === 'invalid' ? 'code' : 'top'); return; }
    if (!Array.isArray(r.data.recoveryCodes) || r.data.recoveryCodes.length === 0) { showError('unknown', 'top'); return; }
    const t = Date.now();
    setPassword(''); setCode(''); setNow(t);
    enrollToken.current = null; // 令牌已被后端消耗
    setS((p) => afterConfirm(p, r.data.recoveryCodes, t));
  };

  const copy = async (text: string, okMsg: string) => {
    try { await navigator.clipboard.writeText(text); say(okMsg); } catch { say('复制失败，请手动选中后复制'); }
  };

  const download = () => {
    if (!s.recoveryCodes) return;
    const url = URL.createObjectURL(new Blob([recoveryTxt(s.recoveryCodes)], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = recoveryFilename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    // 延后释放：同步 revoke 在个别浏览器里会让下载失败（与 MailParts 一致）
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    say('已下载恢复码文件');
  };

  // 重新开始：回到第 1 步，清空内存里的邮箱、密码和验证码
  const restart = () => { setError(null); setShowPw(false); wipe(); setEmail(''); };

  // 去登录：回跳地址写死（SIGNIN_HREF），先清掉内存里的密码、密钥和恢复码
  const goSignin = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!ready) { e.preventDefault(); return; }
    leaving.current = true;
    enrollToken.current = null;
    wipe(); setEmail('');
  };

  const topErr = error?.at === 'top' ? <div ref={topRef} tabIndex={-1} className="en-err" role="alert">{errorText(error.code)}</div> : null;
  // 首帧（服务端渲染、还没读地址栏）只渲染空卡片，避免先闪一下「需要绑定链接」或表单
  if (tok === 'unknown') return <main className="en-wrap"><div className="en-card" aria-busy="true" /></main>;
  if (tok === 'none' && s.step === 1) {
    return (
      <main className="en-wrap">
        <div className="en-card" data-testid="enroll-no-token">
          <h1 ref={heading} tabIndex={-1}>{NO_TOKEN_TITLE}</h1>
          <p className="en-lead">{NO_TOKEN_BODY}</p>
          <a className="en-btn ghost" href={SIGNIN_HREF}>{NO_TOKEN_SIGNIN}</a>
        </div>
      </main>
    );
  }
  const keepHint = s.step < 3 && !s.voided ? <p className="en-keep" data-testid="enroll-keep-hint">{KEEP_PAGE_HINT}</p> : null;
  return (
    <main className="en-wrap">
      <div className="en-card">
        <ol className="en-steps" aria-label="绑定进度">
          {STEPS.map((label, i) => {
            const st = stepStatus(s.step, (i + 1) as Step);
            return (
              <li key={label} className={st === 'done' ? 'done' : st === 'current' ? 'cur' : ''} aria-current={st === 'current' ? 'step' : undefined}>
                <i aria-hidden="true">{st === 'done' ? '✓' : i + 1}</i>
                <span>{label}<span className="sr-only">{st === 'done' ? '（已完成）' : st === 'current' ? '（当前步骤）' : '（未开始）'}</span></span>
              </li>
            );
          })}
        </ol>

        <h1 ref={heading} tabIndex={-1}>{TITLES[s.step]}</h1>
        <p role="status" aria-live="polite" className="sr-only">{status}</p>

        {s.step === 1 && (
          <form onSubmit={start}>
            {keepHint}
            <p className="en-lead">第一次登录后台前需要完成绑定。请输入管理员发给你的邮箱和初始密码。</p>
            {topErr}
            <div className="en-f">
              <label htmlFor="en-email">邮箱</label>
              <input id="en-email" type="email" name="username" required maxLength={200} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="en-f">
              <label htmlFor="en-pw">初始密码</label>
              <div className="en-pw">
                <input ref={pwInput} id="en-pw" type={showPw ? 'text' : 'password'} name="password" required maxLength={200} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="en-link" aria-pressed={showPw} aria-controls="en-pw" aria-label={showPw ? '隐藏密码' : '显示密码'} onClick={() => setShowPw((v) => !v)}>{showPw ? '隐藏' : '显示'}</button>
              </div>
            </div>
            <button className="en-btn" type="submit" disabled={busy}>{busy ? '验证中…' : '下一步'}</button>
            <p className="en-foot">已经绑定过？<a href={SIGNIN_HREF}>去登录</a></p>
          </form>
        )}

        {s.step === 2 && s.voided && (
          <div>
            <div className="en-err" role="alert">{ENROLL_VOID_TEXT}</div>
            <p className="en-lead">{ENROLL_VOID_HINT}</p>
            <button className="en-btn" type="button" onClick={restart}>{ENROLL_RESTART}</button>
            <p className="en-foot">{ENROLL_VOID_FOOT}</p>
          </div>
        )}

        {s.step === 2 && !s.voided && qr && secret && (
          <form onSubmit={confirm}>
            {keepHint}
            <p className="en-lead">用手机上的身份验证器 App 扫描下方二维码，然后输入 App 显示的 6 位验证码。</p>
            {topErr}
            <div className="en-qr">
              {/* eslint-disable-next-line @next/next/no-img-element -- 本地生成的 data URL，不需要图片优化 */}
              <img className="qr" src={qr} width={216} height={216} alt="绑定用二维码（本地生成）" />
              <div className="en-key">
                <details>
                  <summary>无法扫码？显示密钥</summary>
                  <p className="en-keytxt"><code aria-label="密钥">{groupSecret(secret)}</code></p>
                  <button className="en-btn ghost sm" type="button" onClick={() => copy(secret, '已复制密钥')}>复制密钥</button>
                  <p className="en-hint">手动添加时选择「基于时间」，账号名填你的邮箱。</p>
                </details>
              </div>
            </div>
            <div className="en-f">
              <label htmlFor="en-otp">6 位验证码</label>
              <input
                id="en-otp" className="en-otp" type="text" name="totp" inputMode="numeric" autoComplete="one-time-code" required
                value={code} aria-invalid={codeErr ? true : undefined}
                aria-describedby={codeErr ? 'en-otp-e en-otp-h' : 'en-otp-h'}
                onChange={(e) => setCode(normalizeCode(e.target.value))}
                onPaste={(e) => { e.preventDefault(); setCode(normalizeCode(e.clipboardData.getData('text'))); }}
              />
              {codeErr && <p ref={codeRef} tabIndex={-1} className="en-ferr" id="en-otp-e" role="alert">{errorText(codeErr)}</p>}
              <p className="en-hint" id="en-otp-h">每个验证码只能用一次。刚用过或刚报错，请等 App 换下一个码（约 30 秒）再输入。</p>
            </div>
            <button className="en-btn" type="submit" disabled={busy || codeLen !== 'ok'}>{busy ? '确认中…' : '确认绑定'}</button>
            <p className="en-foot">二维码只在本页显示一次，请勿截图分享。离开本页需要重新从第 1 步开始，原二维码作废。</p>
          </form>
        )}

        {s.step === 3 && s.recoveryCodes && (
          <div>
            <p className="en-lead">两步验证已开启。手机丢失时，每个恢复码可代替验证码登录一次。<b>这些码只显示这一次</b>，请保存到安全的地方。</p>
            <ol className="en-codes" aria-label="10 个恢复码">{s.recoveryCodes.map((c) => <li key={c}><code>{c}</code></li>)}</ol>
            <div className="en-row">
              <button className="en-btn ghost" type="button" onClick={() => copy(s.recoveryCodes!.join('\n'), '已复制全部恢复码')}>复制全部</button>
              <button className="en-btn ghost" type="button" onClick={download}>下载 .txt</button>
            </div>
            <label className="en-chk"><input type="checkbox" checked={s.saved} onChange={(e) => { const saved = e.target.checked; setS((p) => ({ ...p, saved })); }} /> 我已保存恢复码</label>
            <p className="en-wait" id="en-wait">
              <b>请等待下一个验证码（约 30 秒）再登录。</b>
              刚才确认绑定用掉的验证码不能再用来登录，重复使用会登录失败并计入账号锁定次数。
              {left > 0 && <> 还需等待 <span className="en-count">{left}</span> 秒。</>}
            </p>
            <a className="en-btn" href={SIGNIN_HREF} aria-disabled={ready ? undefined : true} aria-describedby="en-wait en-go-h" onClick={goSignin}>去登录</a>
            {!ready && <p className="en-hint en-center" id="en-go-h">{!s.saved ? '勾选「我已保存恢复码」后才能继续' : `${left} 秒后可以去登录`}</p>}
          </div>
        )}
      </div>
    </main>
  );
}
