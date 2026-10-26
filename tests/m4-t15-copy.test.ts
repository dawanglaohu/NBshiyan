import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const en = JSON.parse(readFileSync('messages/en.json', 'utf8'));
const ru = JSON.parse(readFileSync('messages/ru.json', 'utf8'));

function paths(v: unknown, prefix = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((item, i) => paths(item, `${prefix}[${i}]`));
  if (v && typeof v === 'object') {
    return Object.keys(v).flatMap((k) => paths((v as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

function bracesBalanced(v: unknown): boolean {
  if (typeof v === 'string') {
    let n = 0;
    for (const ch of v) {
      if (ch === '{') n += 1;
      else if (ch === '}') n -= 1;
      if (n < 0) return false;
    }
    return n === 0;
  }
  if (Array.isArray(v)) return v.every(bracesBalanced);
  if (v && typeof v === 'object') return Object.values(v).every(bracesBalanced);
  return true;
}

test('en 与 ru 的 key 一致，花括号成对，JSON 可解析', () => {
  assert.deepEqual(paths(en).sort(), paths(ru).sort());
  assert.equal(bracesBalanced(en), true);
  assert.equal(bracesBalanced(ru), true);
  for (const raw of [readFileSync('messages/en.json', 'utf8'), readFileSync('messages/ru.json', 'utf8')]) {
    assert.equal(raw.includes('\r'), false);
  }
});

test('面向客户的文案不再出现 Tawk、容量和快照', () => {
  const enRaw = JSON.stringify(en);
  const ruRaw = JSON.stringify(ru);
  assert.equal(/tawk/i.test(enRaw), false);
  assert.equal(/tawk/i.test(ruRaw), false);
  assert.equal(enRaw.includes('2.7 GB'), false);
  assert.equal(/server snapshot/i.test(enRaw), false);
  assert.equal(ruRaw.includes('2,7'), false);
  assert.equal(ruRaw.includes('снимок'), false);
  assert.equal(en.Inquiry.countries.GB, 'United Kingdom');
  assert.equal(ru.Inquiry.countries.GB, 'Великобритания');
});

test('语言专家定稿：同意、隐私、联系和贺卡', () => {
  assert.equal(en.Consent.necessary, 'Necessary');
  assert.equal(ru.Consent.necessary, 'Необходимые');
  assert.equal(en.Consent.necessaryDesc, 'Language, security check, quote list, inquiry form and this choice. Always on.');
  assert.equal(ru.Consent.necessaryDesc, 'Язык, проверка безопасности, список для запроса цены, форма запроса и этот выбор. Всегда включены.');
  assert.equal(en.Consent.chat, undefined);
  assert.equal(en.Consent.chatDesc, undefined);
  assert.equal(ru.Consent.chat, undefined);
  assert.equal(en.Consent.text, 'We use essential cookies and local storage to run this site. With your permission, we also use optional anonymous analytics.');
  assert.equal(ru.Consent.text, 'Мы используем необходимые cookie и локальное хранилище для работы сайта. С вашего согласия — также необязательную анонимную аналитику.');
  assert.equal(en.Consent.analyticsDesc.endsWith('Declining it does not affect the inquiry form or email.'), true);
  assert.equal(ru.Consent.analyticsDesc.endsWith('Отказ не влияет на форму запроса и e-mail.'), true);
  assert.equal(en.Consent.withdrawn, 'Consent withdrawn. Analytics is off. The inquiry form and email remain available.');
  assert.equal(ru.Consent.withdrawn, 'Согласие отозвано. Аналитика отключена. Форма запроса и e-mail по-прежнему доступны.');
  assert.equal(en.Privacy.metaDescription, 'How PackJoyU collects, uses and protects personal data from quote requests, sample orders and cookies, and how to exercise your privacy rights.');
  assert.equal(ru.Privacy.metaDescription, 'Как PackJoyU собирает, использует и защищает персональные данные из запросов цены, заявок на образцы и cookie, и как воспользоваться своими правами.');
  assert.equal(/chat/i.test(en.Privacy.metaDescription), false);
  assert.equal(ru.Privacy.metaDescription.includes('чат'), false);
  assert.equal(en.Privacy.sections.chat.title, 'Contacting us');
  assert.equal(ru.Privacy.sections.chat.title, 'Как с нами связаться');
  assert.deepEqual(en.Privacy.sections.chat.items, ['The inquiry form and email always work, whatever you choose in cookie settings.']);
  assert.deepEqual(ru.Privacy.sections.chat.items, ['Форма запроса и e-mail работают всегда, независимо от настроек cookie.']);
  assert.equal(en.Privacy.sections.cookies.items.length, 4);
  assert.equal(ru.Privacy.sections.cookies.items.length, 4);
  assert.equal(en.Privacy.sections.cookies.items[0].endsWith('It records whether you allowed optional analytics, and when.'), true);
  assert.equal(ru.Privacy.sections.cookies.items[0].endsWith('В нём записано, разрешили ли вы необязательную аналитику, и когда.'), true);
  assert.equal(en.Privacy.sections.cookies.items[1].endsWith('If you decline, no analytics identifier is created.'), true);
  assert.equal(ru.Privacy.sections.cookies.items[1].endsWith('Если вы отказались, идентификатор аналитики не создаётся.'), true);
  assert.equal(en.Privacy.sections.purpose.items[2], 'With your consent only: to measure site performance with anonymous analytics. Sending an inquiry does not require this consent.');
  assert.equal(ru.Privacy.sections.purpose.items[2], 'Только с вашего согласия: для анонимного измерения скорости сайта. Для отправки запроса это согласие не требуется.');
  assert.equal(en.Privacy.sections.processors.items.some((s: string) => /live-chat|third-party/i.test(s)), false);
  assert.equal(en.Contact.humanTitle, undefined);
  assert.equal(ru.Contact.humanTitle, undefined);
  assert.equal(en.Contact.humanBody, en.Privacy.sections.chat.items[0]);
  assert.equal(ru.Contact.humanBody, ru.Privacy.sections.chat.items[0]);
  assert.equal(en.Contact.emailEntry, 'Go to the email field');
  assert.equal(ru.Contact.emailEntry, 'Перейти к полю e-mail');
  assert.equal(en.Contact.capacityLimit, undefined);
  assert.equal(en.Contact.chatSwitch, 'Live chat');
  assert.equal(ru.Contact.chatSwitch, 'Чат');
  assert.equal(en.Contact.chatOff, 'Chat is off. The inquiry form and email still work.');
  assert.equal(ru.Contact.chatOff, 'Чат выключен. Форма запроса и e-mail по-прежнему работают.');
  assert.equal(en.Contact.chatOn, 'Chat is switched on. This page does not open a chat window. The inquiry form and email still work.');
  assert.equal(ru.Contact.chatOn, 'Чат включён. На этой странице окно чата не открывается. Форма запроса и e-mail по-прежнему работают.');
  assert.equal(en.Products.names['gift-cards'], 'Greeting Cards');
  assert.equal(ru.Products.names['gift-cards'], 'Открытки');
  assert.equal(en.Products.desc['gift-cards'], 'Custom printed greeting cards and card packaging for retail and promotions.');
  assert.equal(ru.Products.desc['gift-cards'], 'Открытки с печатью на заказ и упаковка для них — для розничных продаж и промоакций.');
  assert.equal(en.Products.metaDescription, 'Explore our wide range of custom packaging in 3D: corrugated boxes, gift and wine boxes, molded pulp, paper cups and printing. Request a quote from PackJoyU.');
  assert.equal(ru.Products.metaDescription, 'Широкий выбор упаковки на заказ в 3D: гофрокороба, подарочные и винные коробки, формованная целлюлоза, бумажные стаканы и печать. Запросите расчёт у PackJoyU.');
  assert.equal(en.Fab.chat, 'Contact us');
  assert.equal(ru.Fab.chat, 'Связаться с нами');
});

test('联系页聊天开关默认关闭，独立于分析开关，不加载 Tawk', () => {
  const notice = readFileSync('src/app/[locale]/contact/HumanContactNotice.tsx', 'utf8');
  assert.match(notice, /useState\(false\)/);
  assert.match(notice, /id="contact-chat-switch"/);
  assert.match(notice, /role="switch"/);
  assert.match(notice, /aria-checked=\{chatEnabled\}/);
  assert.match(notice, /id="inquiry-email-entry"/);
  assert.equal(notice.includes('setConsent'), false);
  assert.equal(notice.includes('analytics'), false);
  assert.equal(notice.includes('chat: true'), false);
  assert.equal(/tawk/i.test(notice), false);
  assert.equal(notice.includes('2.7'), false);
  assert.equal(notice.includes('chat-availability'), false);
});
