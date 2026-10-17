import { NextResponse } from 'next/server';
import { noStore } from '../admin/guard';
import { hitRateLimit } from '../security';
import { mailApiEnabled, mailRateLimits, smtpConfig, mockAdapterAllowed } from './config';
import type { MailSendAdapter } from './adapter';
import { createSmtpAdapter } from './smtp';
import type { SendResponse } from './send';

/**
 * 每个 /api/admin/mail/*（以及发信、收信 webhook、邮件 cron）路由第一行调用：邮件开关不是 http → 404 not_found。
 * 在鉴权之前判断：关闭时这些接口对任何人都“不存在”，与 /admin/mail/* 页面的 notFound() 一致。
 */
export function mailSwitchGate(env: Record<string, string | undefined> = process.env): Response | null {
  return mailApiEnabled(env) ? null : NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
}

export const sendResponse = (r: SendResponse) => NextResponse.json(r.body, { status: r.status, headers: noStore });

/** 8.0 的 429 结构：{ error, scope, retryAfterSec, limit, windowSec:3600 } + Retry-After（= retryAfterSec） */
export function mailRateLimited(scope: 'admin' | 'global', limit: number, retryAfterSec = 3600) {
  const s = Math.max(1, Math.ceil(retryAfterSec));
  return NextResponse.json({ error: 'rate_limited', scope, retryAfterSec: s, limit, windowSec: 3600 }, { status: 429, headers: { ...noStore, 'Retry-After': String(s) } });
}

/** §7：先全局、再按 userId；存储不可用时拒绝（closed） */
export async function enforceMailRateLimit(userId: string): Promise<Response | null> {
  const l = mailRateLimits();
  if (!(await hitRateLimit('mail:rl:global', l.global, 3_600_000, { onStoreError: 'closed' }))) return mailRateLimited('global', l.global);
  if (!(await hitRateLimit(`mail:rl:admin:${userId}`, l.admin, 3_600_000, { onStoreError: 'closed' }))) return mailRateLimited('admin', l.admin);
  return null;
}

/** 生产发信适配器：SMTP；非生产且 MAIL_SEND_ADAPTER=mock 时用 mock（动态 import，生产包里不会走到） */
export async function defaultAdapter(): Promise<MailSendAdapter | null> {
  if (mockAdapterAllowed()) return (await import('./mock')).createMockAdapter();
  const c = smtpConfig();
  return c.ok ? createSmtpAdapter(c.cfg) : null;
}
