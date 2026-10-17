import nodemailer, { type SendMailOptions } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { SmtpBaseConfig } from './config';
import { classifySmtpError, headerInjection, type MailSendAdapter, type OutboundMail, type SendOutcome } from './adapter';

/**
 * §16：nodemailer 传输参数。只在这里拼一次，便于测试核对：
 * - TLS 强制：465 → secure:true；587 → requireTLS:true（STARTTLS 不成功就中止，不降级明文）
 * - 证书校验始终开启：tls 里不出现 rejectUnauthorized（Node 默认 true），最低 TLS 1.2，SNI = SMTP_HOST
 * - logger / debug 关闭：nodemailer 自己的日志会打出 SMTP 会话（含 AUTH 行），一律不开
 * - 禁止从文件 / URL 读取内容（防止正文里的路径或链接被当成附件源）
 */
export function smtpTransportOptions(cfg: SmtpBaseConfig): SMTPTransport.Options {
  if (!((cfg.port === 465 && cfg.secure && !cfg.requireTLS) || (cfg.port === 587 && !cfg.secure && cfg.requireTLS))) {
    throw Object.assign(new Error('insecure_tls'), { code: 'insecure_tls' });
  }
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    ignoreTLS: false,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { minVersion: 'TLSv1.2', servername: cfg.host },
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  };
}

export type CreateTransport = (opts: SMTPTransport.Options) => { sendMail(m: SendMailOptions): Promise<SMTPTransport.SentMessageInfo> };

/** Gmail SMTP 适配器。createTransport 可注入（测试用 mock SMTP，不连网络） */
export function createSmtpAdapter(cfg: SmtpBaseConfig, deps: { createTransport?: CreateTransport } = {}): MailSendAdapter {
  const create = deps.createTransport ?? ((o: SMTPTransport.Options) => nodemailer.createTransport(o));
  return {
    kind: 'smtp',
    async send(mail: OutboundMail): Promise<SendOutcome> {
      if (headerInjection(mail)) return { ok: false, reason: 'message_rejected', retryable: false, code: 'header_injection', alert: false };
      let transport;
      try { transport = create(smtpTransportOptions(cfg)); } catch {
        return { ok: false, reason: 'smtp_tls', retryable: false, code: 'insecure_tls', alert: true };
      }
      try {
        await transport.sendMail({
          from: { name: cfg.from.name, address: cfg.from.address },
          to: mail.to, // 只有一个收件人，不用 cc / bcc
          replyTo: mail.replyTo,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          messageId: mail.messageId,
          ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
          ...(mail.references ? { references: mail.references } : {}),
          headers: { 'X-Geiom-Send-Id': mail.sendKey },
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        return { ok: true, messageId: mail.messageId };
      } catch (e) {
        return classifySmtpError(e);
      } finally {
        (transport as { close?: () => void }).close?.();
      }
    },
  };
}
