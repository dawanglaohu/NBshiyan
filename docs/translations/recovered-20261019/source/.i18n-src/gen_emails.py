#!/usr/bin/env python3
"""design/emails/inquiry-ack.{es,de,fr}.{txt,html} from the EN templates by segment replacement; verifies {{mustache}} tags."""
import re, sys, collections
T = {
 'es': {
  'We received your inquiry #{{inquiryId}}': 'Hemos recibido su solicitud n.º {{inquiryId}}',
  'Hi {{name}},': 'Hola, {{name}}:',
  'Thank you for contacting PackJoyU. ': 'Gracias por contactar con PackJoyU. ',
  'We have received your inquiry and a packaging specialist will reply within <b>{{replyTime}}</b>.': 'Hemos recibido su solicitud y un especialista en embalaje le responderá en un plazo de <b>{{replyTime}}</b>.',
  'We have received your inquiry and a packaging specialist will reply within {{replyTime}}.': 'Hemos recibido su solicitud y un especialista en embalaje le responderá en un plazo de {{replyTime}}.',
  'We have received your inquiry and a packaging specialist will reply by email.': 'Hemos recibido su solicitud y un especialista en embalaje le responderá por correo electrónico.',
  'Thanks — our team will reply within {{replyTime}}.': 'Gracias: nuestro equipo le responderá en un plazo de {{replyTime}}.',
  'Thanks — our team will reply by email.': 'Gracias: nuestro equipo le responderá por correo electrónico.',
  'Your inquiry': 'Su solicitud', 'Reference': 'Referencia', 'Company': 'Empresa', 'Product': 'Producto', 'Quantity': 'Cantidad',
  'Please keep the reference number in the subject line if you reply to this email.': 'Si responde a este correo, mantenga el número de referencia en el asunto.',
  'View our products': 'Ver nuestros productos',
  'Need to reach us sooner? Email {{contactEmail}} or WhatsApp {{whatsapp}}.': '¿Necesita contactarnos antes? Escriba a {{contactEmail}} o por WhatsApp al {{whatsapp}}.',
  'You are receiving this email because you sent an inquiry on {{siteUrl}}. PackJoyU · Custom paper packaging and printing.': 'Recibe este correo porque envió una solicitud en {{siteUrl}}. PackJoyU · Embalaje de papel e impresión a medida.'},
 'de': {
  'We received your inquiry #{{inquiryId}}': 'Wir haben Ihre Anfrage #{{inquiryId}} erhalten',
  'Hi {{name}},': 'Guten Tag {{name}},',
  'Thank you for contacting PackJoyU. ': 'vielen Dank für Ihre Nachricht an PackJoyU. ',
  'We have received your inquiry and a packaging specialist will reply within <b>{{replyTime}}</b>.': 'Wir haben Ihre Anfrage erhalten; ein Verpackungsspezialist antwortet Ihnen innerhalb von <b>{{replyTime}}</b>.',
  'We have received your inquiry and a packaging specialist will reply within {{replyTime}}.': 'Wir haben Ihre Anfrage erhalten; ein Verpackungsspezialist antwortet Ihnen innerhalb von {{replyTime}}.',
  'We have received your inquiry and a packaging specialist will reply by email.': 'Wir haben Ihre Anfrage erhalten; ein Verpackungsspezialist antwortet Ihnen per E-Mail.',
  'Thanks — our team will reply within {{replyTime}}.': 'Vielen Dank – unser Team antwortet innerhalb von {{replyTime}}.',
  'Thanks — our team will reply by email.': 'Vielen Dank – unser Team antwortet Ihnen per E-Mail.',
  'Your inquiry': 'Ihre Anfrage', 'Reference': 'Referenz', 'Company': 'Unternehmen', 'Product': 'Produkt', 'Quantity': 'Menge',
  'Please keep the reference number in the subject line if you reply to this email.': 'Bitte behalten Sie die Referenznummer im Betreff, wenn Sie auf diese E-Mail antworten.',
  'View our products': 'Unsere Produkte ansehen',
  'Need to reach us sooner? Email {{contactEmail}} or WhatsApp {{whatsapp}}.': 'Sie möchten uns schneller erreichen? Schreiben Sie an {{contactEmail}} oder per WhatsApp an {{whatsapp}}.',
  'You are receiving this email because you sent an inquiry on {{siteUrl}}. PackJoyU · Custom paper packaging and printing.': 'Sie erhalten diese E-Mail, weil Sie auf {{siteUrl}} eine Anfrage gesendet haben. PackJoyU · Individuelle Papierverpackungen und Druck.'},
 'fr': {
  'We received your inquiry #{{inquiryId}}': 'Nous avons bien reçu votre demande n° {{inquiryId}}',
  'Hi {{name}},': 'Bonjour {{name}},',
  'Thank you for contacting PackJoyU. ': 'Merci d’avoir contacté PackJoyU. ',
  'We have received your inquiry and a packaging specialist will reply within <b>{{replyTime}}</b>.': 'Nous avons bien reçu votre demande ; un spécialiste de l’emballage vous répondra sous <b>{{replyTime}}</b>.',
  'We have received your inquiry and a packaging specialist will reply within {{replyTime}}.': 'Nous avons bien reçu votre demande ; un spécialiste de l’emballage vous répondra sous {{replyTime}}.',
  'We have received your inquiry and a packaging specialist will reply by email.': 'Nous avons bien reçu votre demande ; un spécialiste de l’emballage vous répondra par e-mail.',
  'Thanks — our team will reply within {{replyTime}}.': 'Merci, notre équipe vous répondra sous {{replyTime}}.',
  'Thanks — our team will reply by email.': 'Merci, notre équipe vous répondra par e-mail.',
  'Your inquiry': 'Votre demande', 'Reference': 'Référence', 'Company': 'Entreprise', 'Product': 'Produit', 'Quantity': 'Quantité',
  'Please keep the reference number in the subject line if you reply to this email.': 'Si vous répondez à cet e-mail, merci de conserver le numéro de référence dans l’objet.',
  'View our products': 'Voir nos produits',
  'Need to reach us sooner? Email {{contactEmail}} or WhatsApp {{whatsapp}}.': 'Besoin de nous joindre plus vite ? Écrivez à {{contactEmail}} ou sur WhatsApp au {{whatsapp}}.',
  'You are receiving this email because you sent an inquiry on {{siteUrl}}. PackJoyU · Custom paper packaging and printing.': 'Vous recevez cet e-mail car vous avez envoyé une demande sur {{siteUrl}}. PackJoyU · Emballages papier et impression sur mesure.'},
}
MUS = re.compile(r'\{\{[^}]+\}\}')
errs = []
for ext in ('txt', 'html'):
    src = open(f'design/emails/inquiry-ack.en.{ext}', encoding='utf-8').read()
    for l, m in T.items():
        out = src
        if ext == 'html': out = out.replace('<html lang="en"', f'<html lang="{l}"')
        for a in sorted(m, key=len, reverse=True):
            if ext == 'txt' and a in ('Reference', 'Company', 'Product', 'Quantity'):
                out = re.sub(rf'^{a}:', m[a] + (' :' if l == 'fr' else ':'), out, flags=re.M); continue
            if ext == 'html' and a in ('Reference', 'Company', 'Product', 'Quantity', 'Your inquiry', 'View our products'):
                out = out.replace(f'>{a}<', f'>{m[a]}<'); continue
            out = out.replace(a + ':' if (ext == 'txt' and a == 'View our products') else a, (m[a] + (' :' if l == 'fr' else ':')) if (ext == 'txt' and a == 'View our products') else m[a])
        open(f'design/emails/inquiry-ack.{l}.{ext}', 'w', encoding='utf-8').write(out)
        if collections.Counter(MUS.findall(src)) != collections.Counter(MUS.findall(out)): errs.append(f'{l}.{ext}: mustache tags differ')
        left = [s for s in ('Thank you', 'inquiry', 'Your ', 'Hi ', 'Please', 'Need to', 'receiving', 'Company<', 'Quantity') if s in re.sub(r'<[^>]+>|\{\{[^}]+\}\}|/admin/inquiries', '', out)]
        if left: errs.append(f'{l}.{ext}: untranslated {left}')
print('6 files written')
if errs: print('FAIL'); print('\n'.join(errs)); sys.exit(1)
print('PASS: {{mustache}} tags identical to inquiry-ack.en.*, no EN leftovers')
