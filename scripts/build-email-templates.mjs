// 从 design/emails/ 生成 src/lib/server/email/templates.generated.ts。改了设计稿后运行：pnpm email:build
// 处理：首行 <!-- Subject: ... --> 取主题；<!--RISK...--> 后一行包成 {{#risk}}…{{/risk}}；
// txt 里带 “<- 仅低于 40 分时输出” 的行同样包成 risk 块；含 {{contactEmail}}/{{whatsapp}} 的段落包成 {{#contact}} 块（未配置时整段不输出）；
// 通知邮件的后台链接改用 {{adminId}}（内部 id，不是对外编号，不带 token）。
// 样品申请确认（sample-ack）由询盘确认按语言表里的 SAMPLE_RULES 改写得到。任一条没命中，脚本报错退出。
// 回复时间句子包在 {{#reply}}…{{/reply}}{{^reply}}中性说法{{/reply}} 里：CONTACT_REPLY_TIME 未设置/无效时整句换成不带时长的说法。
// 客户确认（inquiry-ack / sample-ack）按语言表去掉公司行，称呼用 {{#named}}…{{/named}}{{^named}}通用问候{{/named}}。
// 加一种客户语言：在 CUSTOMER_LOCALES 加一行，并放入 design/emails/inquiry-ack.<code>.{html,txt}。处理逻辑不按语言写分支。
// ar 把 dir 设为 rtl（生成的 <html> 会带 dir="rtl"）。ja / hi / ar 本期不发布，也不放模板。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lf = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

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

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function customerSafe(t, spec, label) {
  const company = escapeRegExp(spec.companyLabel);
  const row = new RegExp(`<tr><td[^>]*>${company}</td><td[^>]*>\\{\\{company\\}\\}</td></tr>`, 'g');
  const line = new RegExp(`^${company}[^\\S\\n]*:[^\\S\\n]*\\{\\{company\\}\\}\\n`, 'gm');
  const named = `{{#named}}${spec.greeting.named}{{/named}}{{^named}}${spec.greeting.generic}{{/named}}`;
  const fix = (x) => x.replace(row, '').replace(line, '').replaceAll(spec.greeting.named, named);
  const r = { subject: t.subject, html: applyDir(fix(t.html), spec.dir), text: fix(t.text) };
  if (r.html.includes('{{company}}') || r.text.includes('{{company}}') || !r.html.includes('{{#named}}') || !r.text.includes('{{#named}}')) {
    throw new Error(`customer template transform failed: ${label}`);
  }
  return r;
}

function applyDir(html, dir) {
  if (dir !== 'rtl' || html.includes(' dir="rtl"')) return html;
  return html.replace('<html ', '<html dir="rtl" ');
}

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

// 客户确认语言表。sampleRules 的第三条是必须命中的部分（subject / html / text）。
// 费用句只说发货前用邮件确认，不写样品免费。
export const CUSTOMER_LOCALES = {
  en: {
    dir: 'ltr',
    companyLabel: 'Company',
    greeting: { named: 'Hi {{name}},', generic: 'Hello,' },
    sampleRules: [
      ['We received your inquiry', 'We received your sample request', 'subject,html'],
      ['Thanks — our team will reply within {{replyTime}}.', 'Thanks — we\'ll confirm your sample shipping within {{replyTime}}.', 'html'],
      ['We have received your inquiry and a packaging specialist will reply within', 'We have received your sample request. A packaging specialist will review it and confirm shipping within', 'html,text'],
      ['Your inquiry', 'Your sample request', 'html,text'],
      ['Quantity', 'Sample qty', 'html,text'],
      ['because you sent an inquiry on', 'because you requested samples on', 'html,text'],
      ['Thanks — our team will reply by email.', 'Thanks — we\'ll confirm your sample shipping by email.', 'html'],
      ['We have received your inquiry and a packaging specialist will reply by email.', 'We have received your sample request. A packaging specialist will review it and confirm shipping by email.', 'html,text'],
      ['{{/reply}}</p>', '{{/reply}}</p><p style="margin:0 0 20px 0;">Any costs will be confirmed by email before dispatch.</p>', 'html'],
      ['{{/reply}}\n\n', '{{/reply}}\n\nAny costs will be confirmed by email before dispatch.\n\n', 'text'],
    ],
  },
  ru: {
    dir: 'ltr',
    companyLabel: 'Компания',
    greeting: { named: 'Здравствуйте, {{name}}!', generic: 'Здравствуйте!' },
    sampleRules: [
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
  },
  es: {
    dir: 'ltr',
    companyLabel: 'Empresa',
    greeting: { named: 'Hola, {{name}}:', generic: 'Hola:' },
    sampleRules: [
      ['Hemos recibido su solicitud y un especialista en embalaje le responderá en un plazo de', 'Hemos recibido su solicitud de muestras. Un especialista en embalaje la revisará y confirmará el envío en un plazo de', 'html,text'],
      ['Hemos recibido su solicitud y un especialista en embalaje le responderá por correo electrónico.', 'Hemos recibido su solicitud de muestras. Un especialista en embalaje la revisará y confirmará el envío por correo electrónico.', 'html,text'],
      ['Gracias: nuestro equipo le responderá en un plazo de {{replyTime}}.', 'Gracias: confirmaremos el envío de las muestras en un plazo de {{replyTime}}.', 'html'],
      ['Gracias: nuestro equipo le responderá por correo electrónico.', 'Gracias: confirmaremos el envío de las muestras por correo electrónico.', 'html'],
      ['Hemos recibido su solicitud n.º', 'Hemos recibido su solicitud de muestras n.º', 'subject,html'],
      ['porque envió una solicitud en', 'porque solicitó muestras en', 'html,text'],
      ['Su solicitud', 'Su solicitud de muestras', 'html,text'],
      ['Cantidad', 'Cantidad de muestras', 'html,text'],
      ['{{/reply}}</p>', '{{/reply}}</p><p style="margin:0 0 20px 0;">Le confirmaremos por correo electrónico cualquier posible coste antes del envío.</p>', 'html'],
      ['{{/reply}}\n\n', '{{/reply}}\n\nLe confirmaremos por correo electrónico cualquier posible coste antes del envío.\n\n', 'text'],
    ],
  },
  de: {
    dir: 'ltr',
    companyLabel: 'Unternehmen',
    greeting: { named: 'Guten Tag {{name}},', generic: 'Guten Tag,' },
    sampleRules: [
      ['Wir haben Ihre Anfrage erhalten; ein Verpackungsspezialist antwortet Ihnen innerhalb von', 'Wir haben Ihre Musteranfrage erhalten. Ein Verpackungsspezialist prüft sie und bestätigt den Versand innerhalb von', 'html,text'],
      ['Wir haben Ihre Anfrage erhalten; ein Verpackungsspezialist antwortet Ihnen per E-Mail.', 'Wir haben Ihre Musteranfrage erhalten. Ein Verpackungsspezialist prüft sie und bestätigt den Versand per E-Mail.', 'html,text'],
      ['Vielen Dank – unser Team antwortet innerhalb von {{replyTime}}.', 'Vielen Dank – wir bestätigen den Musterversand innerhalb von {{replyTime}}.', 'html'],
      ['Vielen Dank – unser Team antwortet Ihnen per E-Mail.', 'Vielen Dank – wir bestätigen den Musterversand per E-Mail.', 'html'],
      ['Wir haben Ihre Anfrage #', 'Wir haben Ihre Musteranfrage #', 'subject,html'],
      ['eine Anfrage gesendet haben', 'eine Musteranfrage gesendet haben', 'html,text'],
      ['Ihre Anfrage', 'Ihre Musteranfrage', 'html,text'],
      ['Menge', 'Mustermenge', 'html,text'],
      ['{{/reply}}</p>', '{{/reply}}</p><p style="margin:0 0 20px 0;">Etwaige Kosten bestätigen wir Ihnen vor dem Versand per E-Mail.</p>', 'html'],
      ['{{/reply}}\n\n', '{{/reply}}\n\nEtwaige Kosten bestätigen wir Ihnen vor dem Versand per E-Mail.\n\n', 'text'],
    ],
  },
  fr: {
    dir: 'ltr',
    companyLabel: 'Entreprise',
    greeting: { named: 'Bonjour {{name}},', generic: 'Bonjour,' },
    sampleRules: [
      ['Nous avons bien reçu votre demande ; un spécialiste de l’emballage vous répondra sous', 'Nous avons bien reçu votre demande d’échantillons. Un spécialiste de l’emballage l’examinera et confirmera l’envoi sous', 'html,text'],
      ['Nous avons bien reçu votre demande ; un spécialiste de l’emballage vous répondra par e-mail.', 'Nous avons bien reçu votre demande d’échantillons. Un spécialiste de l’emballage l’examinera et confirmera l’envoi par e-mail.', 'html,text'],
      ['Merci, notre équipe vous répondra sous {{replyTime}}.', 'Merci, nous confirmerons l’envoi des échantillons sous {{replyTime}}.', 'html'],
      ['Merci, notre équipe vous répondra par e-mail.', 'Merci, nous confirmerons l’envoi des échantillons par e-mail.', 'html'],
      ['Nous avons bien reçu votre demande n°', 'Nous avons bien reçu votre demande d’échantillons n°', 'subject,html'],
      ['envoyé une demande sur', 'demandé des échantillons sur', 'html,text'],
      ['Votre demande', 'Votre demande d’échantillons', 'html,text'],
      ['Quantité', 'Quantité d’échantillons', 'html,text'],
      ['{{/reply}}</p>', '{{/reply}}</p><p style="margin:0 0 20px 0;">Les éventuels frais vous seront confirmés par e-mail avant l’envoi.</p>', 'html'],
      ['{{/reply}}\n\n', '{{/reply}}\n\nLes éventuels frais vous seront confirmés par e-mail avant l’envoi.\n\n', 'text'],
    ],
  },
};

/** files: 文件名 → 正文。locales: 客户语言表。返回模板对象，不写盘。 */
export function buildEmailTemplates(files, locales) {
  const norm = Object.fromEntries(Object.entries(files).map(([name, body]) => [name, lf(body)]));
  for (const name of Object.keys(norm)) {
    if (!name.startsWith('inquiry-ack.') || !name.endsWith('.html')) continue;
    const loc = name.slice('inquiry-ack.'.length, -'.html'.length);
    if (!locales[loc]) throw new Error(`inquiry-ack.${loc}: no language-table row`);
  }
  for (const loc of Object.keys(locales)) {
    if (norm[`inquiry-ack.${loc}.html`] == null || norm[`inquiry-ack.${loc}.txt`] == null) {
      throw new Error(`language table ${loc}: missing inquiry-ack.${loc}.html/.txt`);
    }
  }
  const out = {};
  for (const name of Object.keys(norm)) {
    if (!name.endsWith('.html')) continue;
    const key = name.slice(0, -'.html'.length);
    if (norm[`${key}.txt`] == null) throw new Error(`missing ${key}.txt`);
    out[key] = parse(norm[name], norm[`${key}.txt`]);
  }
  for (const loc of Object.keys(locales)) out[`inquiry-ack.${loc}`] = customerSafe(out[`inquiry-ack.${loc}`], locales[loc], loc);
  for (const [loc, spec] of Object.entries(locales)) out[`sample-ack.${loc}`] = applyRules(out[`inquiry-ack.${loc}`], spec.sampleRules, `sample-ack.${loc}`);

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

  const ordered = {};
  const keys = [];
  for (const loc of Object.keys(locales)) keys.push(`inquiry-ack.${loc}`);
  for (const key of Object.keys(out).sort()) if (!key.startsWith('inquiry-ack.') && !key.startsWith('sample-ack.')) keys.push(key);
  for (const loc of Object.keys(locales)) keys.push(`sample-ack.${loc}`);
  for (const key of keys) ordered[key] = out[key];
  return ordered;
}

const SCRIPT_NAME = 'build-email-templates.mjs';

function entryFilePath(entry) {
  return entry.startsWith('file:') ? fileURLToPath(entry) : entry;
}

function sameFile(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 规范化路径后再比较，避免盘符大小写或 file URL 编码让直接运行被当成 import。 */
export function invokedDirectly(argv = process.argv, metaUrl = import.meta.url) {
  const entry = argv?.[1];
  if (!entry) return false;
  try {
    return sameFile(entryFilePath(entry), fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/**
 * write：路径比较认定本文件是入口，生成模板。
 * fail：email:build 或本文件名是入口，但 invokedDirectly() 为 false。必须非 0，不能空跑成功。
 * skip：被测试 import。不写盘、不退出。
 */
export function emailBuildPlan({ argv = process.argv, metaUrl = import.meta.url, lifecycle = process.env.npm_lifecycle_event } = {}) {
  if (invokedDirectly(argv, metaUrl)) return { action: 'write', code: 0 };
  const entry = argv?.[1] ?? '';
  const namedEntry = path.basename(String(entry).replace(/\\/g, '/')) === SCRIPT_NAME;
  if (lifecycle === 'email:build' || namedEntry) {
    return {
      action: 'fail',
      code: 1,
      error: 'email:build: invokedDirectly() failed, so templates were not written. Refusing to exit 0.',
    };
  }
  return { action: 'skip', code: 0 };
}

function writeTemplates() {
  const DIR = 'design/emails';
  const files = {};
  for (const name of readdirSync(DIR)) {
    if (!name.endsWith('.html') && !name.endsWith('.txt')) continue;
    files[name] = readFileSync(`${DIR}/${name}`, 'utf8');
  }
  const out = buildEmailTemplates(files, CUSTOMER_LOCALES);
  writeFileSync('src/lib/server/email/templates.generated.ts',
    `// 自动生成，勿手改。来源 design/emails/，生成脚本 scripts/build-email-templates.mjs\nexport const TEMPLATES = ${JSON.stringify(out, null, 1)} as const;\nexport type TemplateKey = keyof typeof TEMPLATES;\n`);
  console.log('templates:', Object.keys(out).join(', '));
}

const plan = emailBuildPlan();
if (plan.action === 'fail') {
  console.error(plan.error);
  process.exit(plan.code);
}
if (plan.action === 'write') writeTemplates();
