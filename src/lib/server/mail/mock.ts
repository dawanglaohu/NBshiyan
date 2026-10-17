import { headerInjection, type MailSendAdapter, type OutboundMail, type SendOutcome } from './adapter';

/**
 * 发信 mock：测试和本地预览用，不连网络、不发信。
 * script 依次决定每次 send 的结果（用完后都算成功）；sent 记录交给它的信，供测试断言。
 * 只能在非生产环境通过 MAIL_SEND_ADAPTER=mock 选中（见 config.mockAdapterAllowed）。
 */
export function createMockAdapter(script: (SendOutcome | ((m: OutboundMail) => SendOutcome | Promise<SendOutcome>))[] = []) {
  const sent: OutboundMail[] = [];
  const adapter: MailSendAdapter & { sent: OutboundMail[] } = {
    kind: 'mock',
    sent,
    async send(mail) {
      if (headerInjection(mail)) return { ok: false, reason: 'message_rejected', retryable: false, code: 'header_injection', alert: false };
      sent.push(mail);
      const next = script.shift();
      if (!next) return { ok: true, messageId: mail.messageId };
      return typeof next === 'function' ? next(mail) : next;
    },
  };
  return adapter;
}
