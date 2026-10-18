'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  afterConfirm, afterEnroll, canFinish, CONFIRM_PATH, ENROLL_PATH, errorText, groupSecret, inProgress, INITIAL, isCompleteCode,
  normalizeCode, parseSecret, postEnroll, recoveryFilename, recoveryTxt, SIGNIN_HREF, STEPS, stepStatus, waitLeft,
  type EnrollState, type Step,
} from '@/lib/admin/enroll';
import { qrSvgDataUrl } from '@/lib/admin/enroll-qr';

const LEAVE_WARNING = '尚未完成绑定';
const TITLES: Record<Step, string> = { 1: '绑定两步验证', 2: '扫码并确认', 3: '保存恢复码' };

/**
 * P1：新管理员首次绑定 2FA（UX 稿 spec §6：账号验证 → 扫码并确认 → 保存恢复码）。
 * 密码、otpauth URI、恢复码只放在 React state 里：不写 URL、不写浏览器本地存储、不打日志；
 * 去登录、页面隐藏（pagehide）、卸载时都清掉。
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

  // 第 3 步：确认后 30 秒倒计时（确认用掉的码登录时再用会失败并计入锁定次数）
  const left = Math.ceil(waitLeft(s, now) / 1000);
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
    const r = await postEnroll<{ otpauthUri: string }>(ENROLL_PATH, { email: email.trim(), password });
    setBusy(false);
    if (!r.ok) { setError({ code: r.code, at: 'top' }); return; }
    if (!parseSecret(r.data.otpauthUri)) { setError({ code: 'unknown', at: 'top' }); return; }
    setShowPw(false);
    setS((p) => afterEnroll(p, r.data.otpauthUri));
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!isCompleteCode(code)) { setError({ code: 'code_incomplete', at: 'code' }); return; }
    setBusy(true); setError(null);
    const r = await postEnroll<{ recoveryCodes: string[] }>(CONFIRM_PATH, { email: email.trim(), password, totp: code });
    setBusy(false);
    // 出错不清空输入框；验证码类错误显示在输入框下方，其他在顶部
    if (!r.ok) { setError({ code: r.code, at: r.code === 'bad_totp' || r.code === 'invalid' ? 'code' : 'top' }); return; }
    if (!Array.isArray(r.data.recoveryCodes) || r.data.recoveryCodes.length === 0) { setError({ code: 'unknown', at: 'top' }); return; }
    const t = Date.now();
    setPassword(''); setCode(''); setNow(t);
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
    URL.revokeObjectURL(url);
    say('已下载恢复码文件');
  };

  // 去登录：回跳地址写死（SIGNIN_HREF），先清掉内存里的密码、密钥和恢复码
  const goSignin = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!ready) { e.preventDefault(); return; }
    leaving.current = true;
    wipe(); setEmail('');
  };

  const topErr = error?.at === 'top' ? <div className="en-err" role="alert">{errorText(error.code)}</div> : null;
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
            <p className="en-lead">第一次登录后台前需要完成绑定。请输入管理员发给你的邮箱和初始密码。</p>
            {topErr}
            <div className="en-f">
              <label htmlFor="en-email">邮箱</label>
              <input id="en-email" type="email" name="username" required maxLength={200} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="en-f">
              <label htmlFor="en-pw">初始密码</label>
              <div className="en-pw">
                <input id="en-pw" type={showPw ? 'text' : 'password'} name="password" required maxLength={200} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="en-link" aria-pressed={showPw} aria-controls="en-pw" aria-label={showPw ? '隐藏密码' : '显示密码'} onClick={() => setShowPw((v) => !v)}>{showPw ? '隐藏' : '显示'}</button>
              </div>
            </div>
            <button className="en-btn" type="submit" disabled={busy}>{busy ? '验证中…' : '下一步'}</button>
            <p className="en-foot">已经绑定过？<a href={SIGNIN_HREF}>去登录</a></p>
          </form>
        )}

        {s.step === 2 && qr && secret && (
          <form onSubmit={confirm}>
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
                id="en-otp" className="en-otp" type="text" name="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required
                value={code} aria-invalid={error?.at === 'code' ? true : undefined}
                aria-describedby={error?.at === 'code' ? 'en-otp-e en-otp-h' : 'en-otp-h'}
                onChange={(e) => setCode(normalizeCode(e.target.value))}
                onPaste={(e) => { e.preventDefault(); setCode(normalizeCode(e.clipboardData.getData('text'))); }}
              />
              {error?.at === 'code' && <p className="en-ferr" id="en-otp-e" role="alert">{errorText(error.code)}</p>}
              <p className="en-hint" id="en-otp-h">每个验证码只能用一次。刚用过或刚报错，请等 App 换下一个码（约 30 秒）再输入。</p>
            </div>
            <button className="en-btn" type="submit" disabled={busy}>{busy ? '确认中…' : '确认绑定'}</button>
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
