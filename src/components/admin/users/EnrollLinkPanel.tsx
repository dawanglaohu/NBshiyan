'use client';
import { useEffect, useRef, useState, type Ref } from 'react';
import { COPIED_MS, PANEL_TEXT, fmtEnrollExpiry, type IssuedEnrollLink } from '@/lib/admin/enroll-link';

type Props = { issued: IssuedEnrollLink; email?: string; onDismiss: () => void };

/**
 * #347 只显示一次的绑定链接面板（UX spec v1.0 第 7 条 + v1.0.1）：只读链接框 +「复制链接」（2 秒「已复制」）、
 * 「有效至 <日期 时间 PT>」（被 72 小时窗口截短时多一行）、只私信发给本人的提示、关闭按钮「我已复制」。
 * 链接只从 props 进来（父组件 state）；这里只有「已复制」布尔值和 DOM ref，没有任何保存链接的 ref / 变量，
 * 不写 URL / 路由 state / storage / console / toast / 错误上报。父组件在 onDismiss 里把 state 置 null，面板卸载即释放。
 * 复制失败时只选中链接框让管理员手动复制，不记录错误内容。
 */
export default function EnrollLinkPanel({ issued, email, onDismiss }: Props) {
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { panel.current?.focus(); setCopied(false); }, [issued]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(issued.link);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      box.current?.select(); // 剪贴板不可用（权限 / 非安全上下文）：选中后手动复制
    }
  };
  return <EnrollLinkPanelView issued={issued} email={email} copied={copied} onCopy={onCopy} onDismiss={onDismiss} boxRef={box} panelRef={panel} />;
}

/** 纯展示（无 hooks），方便单测直接调用并触发按钮 */
export function EnrollLinkPanelView({ issued, email, copied, onCopy, onDismiss, boxRef, panelRef }: Props & {
  copied: boolean; onCopy: () => void; boxRef?: Ref<HTMLInputElement>; panelRef?: Ref<HTMLElement>;
}) {
  const when = fmtEnrollExpiry(issued.expiresAt);
  return (
    <section ref={panelRef} tabIndex={-1} className="adm-sec adm-enroll-link" aria-labelledby="adm-enroll-link-title" data-testid="enroll-link-panel">
      <h2 id="adm-enroll-link-title">{PANEL_TEXT.title}{email ? `：${email}` : ''}</h2>
      <div className="adm-enroll-link-row">
        <input ref={boxRef} readOnly aria-label={PANEL_TEXT.linkLabel} className="adm-plain-url" value={issued.link}
          autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="adm-btn" onClick={onCopy} aria-live="polite">{copied ? PANEL_TEXT.copied : PANEL_TEXT.copy}</button>
      </div>
      {when && <p className="adm-enroll-link-exp">{PANEL_TEXT.expires(when)}</p>}
      {when && issued.truncated && <p className="adm-enroll-link-exp">{PANEL_TEXT.truncated}</p>}
      <p className="adm-enroll-link-warn">{PANEL_TEXT.warn}</p>
      <button type="button" className="adm-btn primary" onClick={onDismiss}>{PANEL_TEXT.done}</button>
    </section>
  );
}
