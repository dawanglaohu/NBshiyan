// 从 design/emails/ 生成 src/lib/server/email/templates.generated.ts。改了设计稿后运行：pnpm email:build
// 处理：首行 <!-- Subject: ... --> 取主题；<!--RISK...--> 后一行包成 {{#risk}}…{{/risk}}；
// txt 里带 “<- 仅低于 40 分时输出” 的行同样包成 risk 块；含 {{contactEmail}}/{{whatsapp}} 的段落包成 {{#contact}} 块（未配置时整段不输出）；
// 通知邮件的后台链接改用 {{adminId}}（内部 id，不是对外编号，不带 token）。
// 样品申请确认（sample-ack）由询盘确认改写几句文案得到。
// 回复时间句子包在 {{#reply}}…{{/reply}}{{^reply}}中性说法{{/reply}} 里：CONTACT_REPLY_TIME 未设置/无效时整句换成不带时长的说法。
// 客户确认（inquiry-ack / sample-ack）去掉公司行，称呼用 {{#named}}…{{/named}}{{^named}}通用问候{{/named}}。
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
// 客户确认邮件：去掉公司那一行；称呼改成条件块，名字不合适时用通用问候（渲染端判断 named）
function customerSafe(t) {
  const fix = (x) => x
    .replace(/<tr><td[^>]*>(Company|Компания)<\/td><td[^>]*>\{\{company\}\}<\/td><\/tr>/g, '')
    .replace(/^(Company|Компания): \{\{company\}\}\n/gm, '')
    .replace('Hi {{name}},', '{{#named}}Hi {{name}},{{/named}}{{^named}}Hello,{{/named}}')
    .replace('Здравствуйте, {{name}}!', '{{#named}}Здравствуйте, {{name}}!{{/named}}{{^named}}Здравствуйте!{{/named}}');
  const r = { subject: t.subject, html: fix(t.html), text: fix(t.text) };
  if (r.html.includes('{{company}}') || r.text.includes('{{company}}') || !r.html.includes('{{#named}}') || !r.text.includes('{{#named}}')) throw new Error('customer template transform failed');
  return r;
}
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.html'))) {
  const key = f.replace(/\.html$/, '');
  out[key] = parse(readFileSync(`${DIR}/${f}`, 'utf8'), readFileSync(`${DIR}/${key}.txt`, 'utf8'));
}
for (const k of Object.keys(out)) if (k.startsWith('inquiry-ack.')) out[k] = customerSafe(out[k]);
// 样品确认改写规则。每条：[原文, 替换, 必须命中的部分]。按原文长度从长到短替换，任一条在要求的部分里没命中就让 build 失败。
const SAMPLE_RULES = {
  en: [
    ['We received your inquiry', 'We received your sample request', 'subject,html'],
    ['Thanks — our team will reply within {{replyTime}}.', 'Thanks — we\'ll confirm your sample shipping within {{replyTime}}.', 'html'],
    ['We have received your inquiry and a packaging specialist will reply within', 'We have received your sample request. A packaging specialist will review it and confirm shipping within', 'html,text'],
    ['Your inquiry', 'Your sample request', 'html,text'],
    ['Quantity', 'Sample qty', 'html,text'],
    ['because you sent an inquiry on', 'because you requested samples on', 'html,text'],
    ['Thanks — our team will reply by email.', 'Thanks — we\'ll confirm your sample shipping by email.', 'html'],
    ['We have received your inquiry and a packaging specialist will reply by email.', 'We have received your sample request. A packaging specialist will review it and confirm shipping by email.', 'html,text'],
    // 不写“样品免费”（未确认）；费用只说会先邮件确认
    ['{{/reply}}</p>', '{{/reply}}</p><p style="margin:0 0 20px 0;">Any costs will be confirmed by email before dispatch.</p>', 'html'],
    ['{{/reply}}\n\n', '{{/reply}}\n\nAny costs will be confirmed by email before dispatch.\n\n', 'text'],
  ],
  ru: [
    ['Мы получили ваш запрос — специалист по упаковке ответит в течение', 'Мы получили вашу заявку на образцы — специалист проверит её и подтвердит доставку в течение', 'html,text'],
    ['Мы получили ваш запрос', 'Мы получили вашу заявку на образцы', 'subject,html'],
    ['Спасибо! Мы ответим в течение {{replyTime}}.', 'Спасибо! Подтвердим доставку образцов в течение {{replyTime}}.', 'html'],
    ['Ваш запрос', 'Ваша заявка на образцы', 'html,text'],
    ['Номер запроса', 'Номер заявки', 'html,text'],
    ['сохраните номер запроса', 'сохраните номер заявки', 'html,text'],
    ['Тираж', 'Количество образцов', 'html,text'],
    ['потому что отправили запрос на сайте', 'потому что оставили заявку на образцы на сайте', 'html,text'],
    ['Мы получили ваш запрос — специалист по упаковке ответит вам по email.', 'Мы получили вашу заявку на образцы — специалист проверит её и подтвердит доставку по email.', 'html,text'],
    ['Спасибо! Мы ответим вам по email.', 'Спасибо! Подтвердим доставку образцов по email.', 'html'],
    ['{{/reply}}</p>', '{{/reply}}</p><p style="margin:0 0 20px 0;">Все расходы мы подтвердим по email до отправки.</p>', 'html'],
    ['{{/reply}}\n\n', '{{/reply}}\n\nВсе расходы мы подтвердим по email до отправки.\n\n', 'text'],
  ],
};
function applyRules(t, rules, label) {
  const r = { ...t };
  for (const part of ['subject', 'html', 'text']) {
    for (const [from, to, parts] of [...rules].sort((x, y) => y[0].length - x[0].length)) {
      if (!parts.split(',').includes(part)) continue;
      if (!r[part].includes(from)) throw new Error(`${label}: rule not matched in ${part}: ${JSON.stringify(from)}`);
      r[part] = r[part].split(from).join(to);
    }
  }
  return r;
}
for (const [loc, rules] of Object.entries(SAMPLE_RULES)) out[`sample-ack.${loc}`] = applyRules(out[`inquiry-ack.${loc}`], rules, `sample-ack.${loc}`);

// 所有模板：logo 图片换成文字商标 PackJoyU（站点没有 logo.png，避免破图）；暗色模式卡片正文、商标、外层背景和 body 都改深色；邮箱和 WhatsApp 不换行
const WORDMARK = '<span class="logo" style="display:block;text-align:left;font-family:Manrope,Arial,Helvetica,sans-serif;font-size:20px;line-height:32px;font-weight:700;color:#1C1C1C;">PackJoyU</span>';
for (const k of Object.keys(out)) {
  let h = out[k].html;
  const n0 = h;
  h = h.replace('.card{background:#1B1B1F!important}', 'body,.bg{background:#121214!important}.card{background:#1B1B1F!important;color:#F2E9D8!important}.logo{color:#FFFFFF!important}');
  h = h.replace('class="card px"', 'class="card px ink"');
  h = h.replace(/<img src="\{\{siteUrl\}\}\/images\/logo\.png"[^>]*>/, WORDMARK);
  h = h.replace(/<body style="([^"]*)">/, '<body class="bg" style="$1">');
  h = h.replace('{{contactEmail}}', '<span style="white-space:nowrap">{{contactEmail}}</span>').replace('{{whatsapp}}', '<span style="white-space:nowrap">{{whatsapp}}</span>');
  if (h === n0 || h.includes('<img') || h.includes('logo.png') || !h.includes('>PackJoyU</span>') || !h.includes('<body class="bg"') || !h.includes('card px ink') || !h.includes('body,.bg{background:#121214!important}')) throw new Error(`${k}: wordmark/dark-mode transform failed`);
  out[k].html = h;
}
writeFileSync('src/lib/server/email/templates.generated.ts',
  `// 自动生成，勿手改。来源 design/emails/，生成脚本 scripts/build-email-templates.mjs\nexport const TEMPLATES = ${JSON.stringify(out, null, 1)} as const;\nexport type TemplateKey = keyof typeof TEMPLATES;\n`);
console.log('templates:', Object.keys(out).join(', '));
