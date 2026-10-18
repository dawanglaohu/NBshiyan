'use client';
import { useEffect, useRef, useState, type Ref } from 'react';
import ConfirmDialog from '@/components/admin/settings/ConfirmDialog'; // 样式 settings.css 由 /admin/users 页面引入（node 单测不能 import css）
import { COPIED_MS, PANEL_TEXT, fmtEnrollExpiry, type IssuedEnrollLink } from '@/lib/admin/enroll-link';
import { installLeaveGuard } from '@/lib/admin/leave-guard';

type Props = { issued: IssuedEnrollLink; email?: string; onDismiss: () => void };

/**
 * #347 只显示一次的绑定链接面板（UX spec v1.0 第 7 条、v1.0.1、v1.0.6）：只读链接框 +「复制链接」（2 秒「已复制」）、
 * 「有效至 <YYYY-MM-DD HH:mm PT>」（被 72 小时窗口截短时多一行）、只私信发给本人的提示、关闭按钮「我已复制」。
 * 按钮主次：还没复制过时「复制链接」是主按钮；复制过一次后「我已复制」变成主按钮。
 * 离开提醒：面板挂载期间（= 显示中且没点「我已复制」）装 beforeunload + 站内链接拦截，卸载即移除。
 * 链接只从 props 进来（父组件 state）；这里只有按钮状态、待确认的跳转和 DOM / 计时器 ref，没有保存链接的 ref / 变量，
 * 不写 URL / 路由 state / storage / console / toast / 错误上报。复制失败时只选中链接框，不记录错误内容。
 */
export default function EnrollLinkPanel({ issued, email, onDismiss }: Props) {
  const [copied, setCopied] = useState(false);
  const [hasCopied, setHasCopied] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { panel.current?.focus(); setCopied(false); setHasCopied(false); }, [issued]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => installLeaveGuard({
    win: window, doc: document, here: () => document.URL, message: PANEL_TEXT.leave,
    onIntercept: (proceed) => setPending(() => proceed),
  }), []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(issued.link);
      setCopied(true); setHasCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      box.current?.select(); // 剪贴板不可用（权限 / 非安全上下文）：选中后手动复制
    }
  };
  const leave = () => { const go = pending; setPending(null); onDismiss(); go?.(); };
  return (
    <>
      <EnrollLinkPanelView issued={issued} email={email} copied={copied} hasCopied={hasCopied} onCopy={onCopy} onDismiss={onDismiss} boxRef={box} panelRef={panel} />
      {pending && (
        <ConfirmDialog title={PANEL_TEXT.leave} confirmLabel={PANEL_TEXT.leaveOk} onCancel={() => setPending(null)} onConfirm={leave}>{null}</ConfirmDialog>
      )}
    </>
  );
}

/** 纯展示（无 hooks），方便单测直接调用并触发按钮 */
export function EnrollLinkPanelView({ issued, email, copied, hasCopied = false, onCopy, onDismiss, boxRef, panelRef }: Props & {
  copied: boolean; hasCopied?: boolean; onCopy: () => void; boxRef?: Ref<HTMLInputElement>; panelRef?: Ref<HTMLElement>;
}) {
  const when = fmtEnrollExpiry(issued.expiresAt);
  return (
    <section ref={panelRef} tabIndex={-1} className="adm-sec adm-enroll-link" aria-labelledby="adm-enroll-link-title" data-testid="enroll-link-panel">
      <h2 id="adm-enroll-link-title">{PANEL_TEXT.title}{email ? `：${email}` : ''}</h2>
      <div className="adm-enroll-link-row">
        <input ref={boxRef} readOnly aria-label={PANEL_TEXT.linkLabel} className="adm-plain-url" value={issued.link}
          autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className={hasCopied ? 'adm-btn' : 'adm-btn primary'} onClick={onCopy} aria-live="polite">{copied ? PANEL_TEXT.copied : PANEL_TEXT.copy}</button>
      </div>
      {when && <p className="adm-enroll-link-exp">{PANEL_TEXT.expires(when)}</p>}
      {when && issued.truncated && <p className="adm-enroll-link-exp">{PANEL_TEXT.truncated}</p>}
      <p className="adm-enroll-link-warn">{PANEL_TEXT.warn}</p>
      <button type="button" className={hasCopied ? 'adm-btn primary' : 'adm-btn'} onClick={onDismiss}>{PANEL_TEXT.done}</button>
    </section>
  );
}
