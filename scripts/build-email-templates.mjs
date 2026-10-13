// 从 design/emails/ 生成 src/lib/server/email/templates.generated.ts。改了设计稿后运行：pnpm email:build
// 处理：首行 <!-- Subject: ... --> 取主题；<!--RISK...--> 后一行包成 {{#risk}}…{{/risk}}；
// txt 里带 “<- 仅低于 40 分时输出” 的行同样包成 risk 块；含 {{contactEmail}}/{{whatsapp}} 的段落包成 {{#contact}} 块（未配置时整段不输出）；
// 通知邮件的后台链接改用 {{adminId}}（内部 id，不是对外编号，不带 token）。
// 样品申请确认（sample-ack）由询盘确认改写几句文案得到。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const DIR = 'design/emails';
const out = {};
function parse(html, txt) {
  const sub = /^<!-- Subject: (.*?) -->\n/.exec(html);
  const tsub = /^Subject: (.*)\n\n?/.exec(txt);
  if (!sub || !tsub) throw new Error('missing subject');
  html = html.slice(sub[0].length);
  txt = txt.slice(tsub[0].length);
  html = html.replace(/<!--RISK[^>]*-->\n(.*)\n/, '{{#risk}}$1{{/risk}}\n');
  txt = txt.replace(/^(.*?)\s*<-\s*仅低于 40 分时输出\n/m, '{{#risk}}$1\n{{/risk}}');
  html = html.replace(/<!-- 所有 \{\{变量\}\}[^>]*-->\n/, '');
  html = html.replace(/(<p[^>]*>[^<]*\{\{contactEmail\}\}[^<]*<\/p>)/, '{{#contact}}$1{{/contact}}');
  txt = txt.replace(/^(.*\{\{contactEmail\}\}.*)\n/m, '{{#contact}}$1\n{{/contact}}');
  html = html.replaceAll('/admin/inquiries/{{inquiryId}}', '/admin/inquiries/{{adminId}}');
  txt = txt.replaceAll('/admin/inquiries/{{inquiryId}}', '/admin/inquiries/{{adminId}}');
  return { subject: sub[1], html, text: txt };
}
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.html'))) {
  const key = f.replace(/\.html$/, '');
  out[key] = parse(readFileSync(`${DIR}/${f}`, 'utf8'), readFileSync(`${DIR}/${key}.txt`, 'utf8'));
}
const SAMPLE = {
  en: [['We received your inquiry', 'We received your sample request'], ['We have received your inquiry and a packaging specialist will reply within', 'We have received your sample request. A packaging specialist will review it and confirm shipping details within'], ['Your inquiry', 'Your sample request']],
  ru: [['Мы получили ваш запрос', 'Мы получили вашу заявку на образцы'], ['Мы получили ваш запрос — специалист по упаковке ответит в течение', 'Мы получили вашу заявку на образцы — специалист проверит её и подтвердит доставку в течение'], ['Ваш запрос', 'Ваша заявка на образцы']],
};
for (const [loc, reps] of Object.entries(SAMPLE)) {
  const base = out[`inquiry-ack.${loc}`];
  const r = (s) => reps.reduce((t, [a, b]) => t.replaceAll(a, b), s);
  out[`sample-ack.${loc}`] = { subject: r(base.subject), html: r(base.html), text: r(base.text) };
}
writeFileSync('src/lib/server/email/templates.generated.ts',
  `// 自动生成，勿手改。来源 design/emails/，生成脚本 scripts/build-email-templates.mjs\nexport const TEMPLATES = ${JSON.stringify(out, null, 1)} as const;\nexport type TemplateKey = keyof typeof TEMPLATES;\n`);
console.log('templates:', Object.keys(out).join(', '));
