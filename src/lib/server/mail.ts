import { escapeHtml, oneLine } from './security';

type Mail = { to: string; subject: string; html: string; replyTo?: string };
export async function sendMail(m: Mail) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.info('[mail:dev]', m.to, m.subject); return; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM ?? 'PackJoyU <onboarding@resend.dev>', ...m, subject: oneLine(m.subject), reply_to: m.replyTo }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}`);
}

const AUTO_REPLY = {
  en: { subject: 'We received your inquiry', body: 'Thank you for contacting PackJoyU. Our team will reply within 24 hours. Your reference number is' },
  ru: { subject: 'Мы получили ваш запрос', body: 'Спасибо за обращение в PackJoyU. Мы ответим в течение 24 часов. Номер вашего запроса' },
} as const;
export function autoReply(locale: 'en' | 'ru', name: string, ref: string) {
  const t = AUTO_REPLY[locale];
  return { subject: `${t.subject} · ${ref}`, html: `<p>${escapeHtml(name)},</p><p>${t.body} <b>${ref}</b>.</p>` };
}
