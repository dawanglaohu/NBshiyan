const FREE_MAIL = ['gmail.com','yahoo.com','hotmail.com','outlook.com','mail.ru','yandex.ru','qq.com','163.com','icloud.com','aol.com'];
const SPAM_HINTS = [/seo service/i, /backlink/i, /crypto/i, /bitcoin/i, /loan/i, /casino/i, /https?:\/\//i];

/** 询盘可信度评分 0-100，低于 40 归入“待核实” */
export function scoreInquiry(i: { email: string; company?: string; region: string; ipCountry?: string | null; message?: string }) {
  let score = 50;
  const reasons: string[] = [];
  const domain = i.email.split('@')[1]?.toLowerCase() ?? '';
  if (FREE_MAIL.includes(domain)) { score -= 10; reasons.push('free_mail'); } else { score += 20; reasons.push('company_mail'); }
  if (i.company && i.company.length > 1) { score += 10; reasons.push('has_company'); }
  if (i.ipCountry && i.ipCountry !== i.region) { score -= 15; reasons.push('ip_region_mismatch'); }
  const hits = SPAM_HINTS.filter((r) => r.test(i.message ?? '')).length;
  if (hits) { score -= 20 * hits; reasons.push('spam_hints'); }
  if ((i.message ?? '').length > 40) { score += 5; reasons.push('detailed_message'); }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}
