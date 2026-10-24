import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LocaleSchema, SitePathSchema } from '../src/lib/contracts/common';
import { PUBLISHED_LOCALES } from '../src/i18n/published-locales';
import { contentLocales, schemaTypes } from '../sanity/schemas/index';
import { TEMPLATES } from '../src/lib/server/email/templates.generated';
import { buildEmailTemplates, CUSTOMER_LOCALES } from '../scripts/build-email-templates.mjs';

const RESERVED = ['es', 'de', 'fr', 'ja', 'hi', 'ar'] as const;

test('published list stays en/ru while reserved locales stay unpublished', () => {
  assert.deepEqual([...PUBLISHED_LOCALES], ['en', 'ru']);
  for (const locale of RESERVED) assert.equal(LocaleSchema.safeParse(locale).success, false, locale);
  for (const locale of ['en', 'ru']) assert.equal(LocaleSchema.safeParse(locale).success, true, locale);
  assert.equal(SitePathSchema.safeParse('/ru/products').success, true);
  for (const path of ['/es', '/de/products', '/fr/about', '/ja']) assert.equal(SitePathSchema.safeParse(path).success, false, path);
  const src = readFileSync('src/lib/contracts/common.ts', 'utf8');
  assert.match(src, /z\.enum\(PUBLISHED_LOCALES\)/);
  assert.doesNotMatch(src, /z\.enum\(\['en', 'ru'\]\)/);
});

test('sanity content fields come from one locale list; only English is required', () => {
  assert.deepEqual(contentLocales.map((l) => l.code), ['en', 'ru', 'es', 'de', 'fr']);
  const product = schemaTypes.find((doc) => doc.name === 'product');
  assert.ok(product);
  const fields = product.fields as { name: string; fields?: { name: string; validation?: unknown }[] }[];
  for (const name of ['title', 'slug', 'excerpt', 'body']) {
    const field = fields.find((item) => item.name === name);
    assert.deepEqual(field?.fields?.map((item) => item.name), contentLocales.map((l) => l.code), name);
  }
  const title = fields.find((item) => item.name === 'title');
  const slug = fields.find((item) => item.name === 'slug');
  const excerpt = fields.find((item) => item.name === 'excerpt');
  assert.deepEqual(title?.fields?.filter((item) => item.validation).map((item) => item.name), ['en']);
  assert.deepEqual(slug?.fields?.filter((item) => item.validation).map((item) => item.name), ['en']);
  assert.equal(excerpt?.fields?.some((item) => item.validation), false);
  const article = schemaTypes.find((doc) => doc.name === 'article');
  const solution = schemaTypes.find((doc) => doc.name === 'solution');
  assert.equal(article?.fields.length, product.fields.length - 1);
  assert.equal(solution?.fields.length, product.fields.length - 2);
});

test('email templates match the language table and drop every company line', () => {
  const files: Record<string, string> = {};
  for (const name of readdirSync('design/emails')) {
    if (name.endsWith('.html') || name.endsWith('.txt')) files[name] = readFileSync(`design/emails/${name}`, 'utf8');
  }
  const built = buildEmailTemplates(files, CUSTOMER_LOCALES);
  for (const locale of Object.keys(CUSTOMER_LOCALES)) {
    for (const kind of ['inquiry-ack', 'sample-ack']) {
      const key = `${kind}.${locale}`;
      const template = built[key];
      assert.ok(template, key);
      assert.equal(template.html.includes('{{company}}'), false, key);
      assert.equal(template.text.includes('{{company}}'), false, key);
      assert.equal(template.html.includes(`>${CUSTOMER_LOCALES[locale].companyLabel}<`), false, key);
      assert.equal(template.text.includes(CUSTOMER_LOCALES[locale].companyLabel), false, key);
      assert.match(template.html, /\{\{#named\}\}/);
      assert.match(template.text, /\{\{#named\}\}/);
    }
    assert.match(built[`inquiry-ack.${locale}`].html, new RegExp(`lang="${locale}"`));
    assert.equal(built[`inquiry-ack.${locale}`].html.includes(' dir="rtl"'), CUSTOMER_LOCALES[locale].dir === 'rtl');
  }
  for (const locale of ['es', 'de', 'fr']) assert.match(built[`sample-ack.${locale}`].html, /antes del envío|vor dem Versand|avant l’envoi/);
  assert.deepEqual(built, TEMPLATES);
});

test('a new customer locale is a table row plus template files', () => {
  const html = readFileSync('design/emails/inquiry-ack.en.html', 'utf8').replaceAll('Hi {{name}},', 'Salaam {{name}}').replaceAll('>Company<', '>Shirka<');
  const text = readFileSync('design/emails/inquiry-ack.en.txt', 'utf8').replaceAll('Hi {{name}},', 'Salaam {{name}}').replaceAll('Company: {{company}}', 'Shirka: {{company}}');
  const locales = {
    xx: { ...CUSTOMER_LOCALES.en, dir: 'rtl' as const, companyLabel: 'Shirka', greeting: { named: 'Salaam {{name}}', generic: 'Salaam,' } },
  };
  const built = buildEmailTemplates({ 'inquiry-ack.xx.html': html, 'inquiry-ack.xx.txt': text }, locales);
  assert.match(built['inquiry-ack.xx'].html, /<html dir="rtl" /);
  assert.match(built['inquiry-ack.xx'].html, /\{\{#named\}\}Salaam \{\{name\}\}\{\{\/named\}\}\{\{\^named\}\}Salaam,\{\{\/named\}\}/);
  assert.equal(built['inquiry-ack.xx'].html.includes('{{company}}'), false);
  assert.equal(built['inquiry-ack.xx'].text.includes('Shirka:'), false);
  assert.match(built['sample-ack.xx'].subject, /sample request/);
  assert.match(built['sample-ack.xx'].text, /Any costs will be confirmed by email before dispatch/);
  const logic = buildEmailTemplates.toString();
  assert.doesNotMatch(logic, /Empresa|Unternehmen|Entreprise|Компания|Salaam/);
  assert.throws(() => buildEmailTemplates(
    { 'inquiry-ack.xx.html': html, 'inquiry-ack.xx.txt': text },
    { xx: { ...locales.xx, sampleRules: [['this phrase is not in the template', 'x', 'html']] } },
  ), /rule not matched/);
});
