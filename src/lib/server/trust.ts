const FREE_MAIL = ['gmail.com','yahoo.com','hotmail.com','outlook.com','mail.ru','yandex.ru','qq.com','163.com','icloud.com','aol.com'];
const SPAM_HINTS = [/seo service/i, /backlink/i, /crypto/i, /bitcoin/i, /loan/i, /casino/i];
// 任何链接：http(s)://、www.、或裸域名（example.com/x）
const LINK = /(https?:\/\/|\bwww\.|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|info|biz|ru|cn|xyz|top|io|co|me|site|online|link|ly|de|uk|us|shop|app|cc|tk|ml|ga|gq|cf|pw|ws|tv|club|store|live|click|icu|vip|fun|space|website|tech|su|pro|biz|eu|in|to|gg|xxx|zip|mov)\b)/i;
export const REVIEW_THRESHOLD = 40;

/** 询盘可信度评分 0-100，低于 40 归入“待核实” */
export function scoreInquiry(i: { email: string; company?: string; region: string; ipCountry?: string | null; message?: string; name?: string; phone?: string }) {
  let score = 50;
  const reasons: string[] = [];
  const domain = i.email.split('@')[1]?.toLowerCase() ?? '';
  if (FREE_MAIL.includes(domain)) { score -= 10; reasons.push('free_mail'); } else { score += 20; reasons.push('company_mail'); }
  if (i.company && i.company.length > 1) { score += 10; reasons.push('has_company'); }
  if (i.ipCountry && i.ipCountry !== i.region) { score -= 15; reasons.push('ip_region_mismatch'); }
  const hits = SPAM_HINTS.filter((r) => r.test(i.message ?? '')).length;
  if (hits) { score -= 20 * hits; reasons.push('spam_hints'); }
  if ((i.message ?? '').length > 40) { score += 5; reasons.push('detailed_message'); }
  score = Math.max(0, Math.min(100, score));
  // PRD 第 9 节：含链接的询盘一律进“待核实”，且不发自动回复
  const text = [i.message, i.name, i.company, i.phone].filter(Boolean).join(' ').replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, ' '); // 留言、客户名、公司名、电话都会进通知邮件，一起检查；邮箱地址不算链接
  if (LINK.test(text)) { reasons.push('has_link'); score = Math.min(score, REVIEW_THRESHOLD - 1); }
  return { score, reasons };
}
