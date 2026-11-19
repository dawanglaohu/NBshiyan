import { createConnection, type Socket } from 'node:net';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { classifySmtpError, headerInjection } from '../mail/adapter';
import { smtpBaseConfig, parseMailbox, type SmtpBaseConfig } from '../mail/config';
import { smtpTransportOptions } from '../mail/smtp';
import {
  CHAT_SMTP_DEADLINE_MS, CHAT_SMTP_SOCKET_IDLE_MS,
  type NotificationEnv, type NotificationOutcome,
} from './notification-policy';
import type { NotificationContent, NotificationRow } from './notification-repo';

export type NotificationMailConfig = { smtp: SmtpBaseConfig; to: string; site: string };
export type NotificationMail = { stableMessageId: string; conversationId: string; locale: string; receivedAt: Date };
export type NotificationMailer = { send(mail: NotificationMail, signal: AbortSignal): Promise<NotificationOutcome> };
type Transport = { sendMail(mail: SendMailOptions): Promise<unknown>; close?: () => void };
type SocketCallback = (error: Error | null, result?: { connection: Socket }) => void;
export type NotificationTransportOptions = SMTPTransport.Options & {
  getSocket(options: unknown, callback: SocketCallback): void;
};

/** Independent of the legacy mail UI switch and reply-domain configuration. */
export function notificationMailConfig(env: NotificationEnv = process.env): NotificationMailConfig | null {
  const base = smtpBaseConfig(env);
  const to = parseMailbox(env.CHAT_NOTIFICATION_TO);
  if (!base.ok || !to) return null;
  try {
    const site = new URL(env.NEXT_PUBLIC_SITE_URL ?? '');
    const testSite = env.APP_ENV === 'test' && process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD === '1';
    if (base.cfg.host.toLowerCase() === 'smtp.evidence.test' && env.APP_ENV !== 'test') return null;
    if (site.username || site.password || site.search || site.hash || site.pathname !== '/') return null;
    if (site.protocol !== 'https:' && !(testSite && site.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname))) return null;
    return { smtp: base.cfg, to: to.address, site: site.origin };
  } catch { return null; }
}

/** Network codes alone never prove that this attempt failed before DATA. */
export function classifyNotificationFailure(error: unknown, beforeHandoff: boolean): NotificationOutcome {
  const candidate = classifySmtpError(error);
  const shaped = error as { responseCode?: unknown; command?: unknown } | null;
  const explicitRefusal = typeof shaped?.responseCode === 'number' && Number.isInteger(shaped.responseCode)
    && shaped.responseCode >= 400 && shaped.responseCode <= 599
    && typeof shaped.command === 'string' && /^(?:CONN|EHLO|HELO|STARTTLS|AUTH|MAIL|RCPT|DATA)(?: |$)/.test(shaped.command);
  if (explicitRefusal) {
    switch (candidate.reason) {
      case 'provider_throttled': return { kind: 'retry', code: 'CHAT_SMTP_TEMPORARY' };
      case 'send_auth': return { kind: 'failed', code: 'CHAT_SMTP_AUTH' };
      case 'recipient_rejected': return { kind: 'failed', code: 'CHAT_SMTP_RECIPIENT' };
      case 'message_rejected': return { kind: 'failed', code: 'CHAT_SMTP_REJECTED' };
    }
  }
  if (beforeHandoff && candidate.reason === 'smtp_tls') return { kind: 'failed', code: 'CHAT_SMTP_TLS' };
  if (beforeHandoff && candidate.reason === 'send_unavailable') return { kind: 'retry', code: 'CHAT_SMTP_UNAVAILABLE' };
  return { kind: 'unknown', code: 'CHAT_SMTP_UNKNOWN' };
}

export function createNotificationMailer(cfg: NotificationMailConfig, deps: {
  createTransport?: (options: NotificationTransportOptions) => Transport;
  connect?: (options: { host: string; port: number; signal: AbortSignal }) => Socket;
  monotonic?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
} = {}): NotificationMailer {
  const connect = deps.connect ?? createConnection;
  const monotonic = deps.monotonic ?? (() => performance.now());
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  return {
    async send(mail, signal) {
      const link = new URL(`/admin/chat/${encodeURIComponent(mail.conversationId)}`, cfg.site);
      const subject = 'New customer message';
      if (!Number.isFinite(mail.receivedAt.getTime()) || headerInjection({ to: cfg.to, replyTo: cfg.smtp.from.address, subject, messageId: mail.stableMessageId })) {
        return { kind: 'failed', code: 'CHAT_LOCAL_INVALID' };
      }
      const transportOptions = smtpTransportOptions(cfg.smtp);
      const startedAt = monotonic();
      return new Promise<NotificationOutcome>((resolve) => {
        const controller = new AbortController();
        let socket: Socket | undefined;
        let transport: Transport | undefined;
        let settled = false;
        let handedOff = false;
        let cancelSocketWait: (() => void) | undefined;
        const timers: { overall?: ReturnType<typeof setTimeout> } = {};
        let connectionTimer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => finish({ kind: 'unknown', code: 'CHAT_SMTP_ABORTED' });
        const finish = (outcome: NotificationOutcome) => {
          if (settled) return;
          if (monotonic() - startedAt >= CHAT_SMTP_DEADLINE_MS) outcome = { kind: 'unknown', code: 'CHAT_SMTP_DEADLINE' };
          // Seal before destroying the socket: synchronous error callbacks cannot replace the result.
          settled = true;
          controller.abort();
          socket?.destroy();
          cancelSocketWait?.();
          if (timers.overall) clearTimer(timers.overall);
          if (connectionTimer) clearTimer(connectionTimer);
          signal.removeEventListener('abort', abort);
          try { transport?.close?.(); } catch { /* outcome is already sealed */ }
          resolve(outcome);
        };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        timers.overall = setTimer(() => finish({ kind: 'unknown', code: 'CHAT_SMTP_DEADLINE' }), CHAT_SMTP_DEADLINE_MS);
        const options: NotificationTransportOptions = {
          ...transportOptions,
          socketTimeout: CHAT_SMTP_SOCKET_IDLE_MS,
          getSocket(_options, callback) {
            let called = false;
            const done: SocketCallback = (error, result) => {
              if (called) return;
              called = true;
              cancelSocketWait = undefined;
              callback(error, result);
            };
            cancelSocketWait = () => done(new Error('chat_smtp_aborted'));
            if (!settled && monotonic() - startedAt >= CHAT_SMTP_DEADLINE_MS) finish({ kind: 'unknown', code: 'CHAT_SMTP_DEADLINE' });
            if (settled) { done(new Error('chat_smtp_aborted')); return; }
            try {
              socket = connect({ host: cfg.smtp.host, port: cfg.smtp.port, signal: controller.signal });
              socket.on('error', (error: Error) => {
                if (!handedOff) done(error);
              });
              connectionTimer = setTimer(() => {
                if (!handedOff) finish({ kind: 'retry', code: 'CHAT_SMTP_UNAVAILABLE' });
              }, 10_000);
              socket.once('connect', () => {
                if (connectionTimer) clearTimer(connectionTimer);
                if (!settled && monotonic() - startedAt >= CHAT_SMTP_DEADLINE_MS) finish({ kind: 'unknown', code: 'CHAT_SMTP_DEADLINE' });
                if (settled || controller.signal.aborted) { socket?.destroy(); done(new Error('chat_smtp_aborted')); return; }
                handedOff = true;
                done(null, { connection: socket! });
              });
            } catch (error) { done(error instanceof Error ? error : new Error('chat_smtp_connect_failed')); }
          },
        };
        try {
          transport = (deps.createTransport ?? ((opts) => nodemailer.createTransport(opts)))(options);
          const text = `A customer message was received at ${mail.receivedAt.toISOString()}.\nOpen the protected inbox: ${link.href}`;
          // No conversation body, visitor email, auth token or SMTP response enters this message.
          const promise = transport.sendMail({
            from: cfg.smtp.from, to: cfg.to, replyTo: cfg.smtp.from.address,
            subject, text, messageId: mail.stableMessageId,
            disableFileAccess: true, disableUrlAccess: true,
          });
          Promise.resolve(promise).then(
            () => finish({ kind: 'sent' }),
            (error: unknown) => finish(classifyNotificationFailure(error, !handedOff)),
          );
        } catch (error) { finish(classifyNotificationFailure(error, !handedOff)); }
      });
    },
  };
}

export function notificationMail(row: NotificationRow, content: NotificationContent): NotificationMail {
  return { stableMessageId: row.stableMessageId, ...content };
}
