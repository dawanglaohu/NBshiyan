import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, maskAddress, ShippingAddress } from '../src/lib/server/sample';
import { designIdFromShareUrl } from '../src/lib/server/designs';
import { SITE_URL } from '../src/lib/site';

test('normalizeEmail', () => {
  assert.equal(normalizeEmail(' John.Doe+promo@GMail.com '), 'johndoe@gmail.com');
  assert.equal(normalizeEmail('j.o.h.n@googlemail.com'), 'john@gmail.com');
  assert.equal(normalizeEmail('Ann.Lee+x@Acme.de'), 'ann.lee@acme.de');
});

test('shipping address validation + masking', () => {
  const a = { line1: 'Hauptstr. 1', city: 'Berlin', postalCode: '10115', country: 'de' };
  const p = ShippingAddress.parse(a);
  assert.equal(p.country, 'DE');
  assert.equal(ShippingAddress.safeParse({ ...a, line1: 'x\r\ny' }).success, false);
  assert.equal(ShippingAddress.safeParse({ ...a, extra: 1 }).success, false);
  const m = maskAddress(p);
  assert.deepEqual(m, { masked: true, country: 'DE', city: 'B***', postalCode: '10***', line1: '***' });
  assert.ok(!JSON.stringify(m).includes('Hauptstr'));
});

test('share url: same-site /s/<id> only', () => {
  assert.equal(designIdFromShareUrl('/s/AbCdEfGh23456789'), 'AbCdEfGh23456789');
  assert.equal(designIdFromShareUrl(`${SITE_URL}/s/AbCdEfGh23456789`), 'AbCdEfGh23456789');
  for (const bad of ['https://evil.com/s/AbCdEfGh23456789', '//evil.com/s/AbCdEfGh23456789', '/s/abc', '/s/AbCdEfGh23456789?x=1', 'javascript:alert(1)', `${SITE_URL}.evil.com/s/AbCdEfGh23456789`])
    assert.equal(designIdFromShareUrl(bad), null, bad);
});
