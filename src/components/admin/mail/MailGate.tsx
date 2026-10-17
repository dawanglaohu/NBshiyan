'use client';
// #74：邮件开关上下文。AdminShell 进入后台时请求一次 GET /api/admin/mail/config，下面的页面（询盘详情、往来邮件）直接读。
import { createContext, useContext, useEffect, useState } from 'react';
import { fetchMailGate, MAIL_OFF_TEXT, type MailGate } from '@/lib/admin/mail/gate';
import { mailApi, usingMailMock } from '@/lib/admin/mail/api';

export const MailGateContext = createContext<MailGate>({ state: 'loading' });
export const useMailGate = () => useContext(MailGateContext);

/** 同一次页面加载只请求一次（AdminShell 重新挂载也复用结果）；NEXT_PUBLIC_ADMIN_MAIL=mock 只用示例数据，其他情况一律问真实接口（服务端开关以运行时为准） */
let pending: Promise<MailGate> | null = null;
const loadGate = () => (pending ??= usingMailMock
  ? mailApi.getConfig().then((c) => ({ state: 'on' as const, sendingEnabled: c.sendingEnabled }), () => ({ state: 'on' as const, sendingEnabled: true }))
  : fetchMailGate());

export function useMailGateFetch(): MailGate {
  const [gate, setGate] = useState<MailGate>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void loadGate().then((g) => { if (live) setGate(g); });
    return () => { live = false; };
  }, []);
  return gate;
}

/** 邮件开关关闭时，询盘详情里替代回复区的一行灰色小字 */
export function MailOffNote() {
  return <p className="adm-mail-off" data-testid="mail-off">{MAIL_OFF_TEXT}</p>;
}
