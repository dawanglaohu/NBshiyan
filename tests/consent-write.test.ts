import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearTawkData, consentNotice, legacyChatCleared, setConsent } from '../src/lib/consent';

class Store {
  getItem(k: string) {
    return Object.prototype.hasOwnProperty.call(this, k) ? String((this as Record<string, unknown>)[k]) : null;
  }
  setItem(k: string, v: string) {
    Object.defineProperty(this, k, { value: String(v), enumerable: true, configurable: true, writable: true });
  }
  removeItem(k: string) {
    delete (this as Record<string, unknown>)[k];
  }
}

describe('同意写入', { concurrency: false }, () => {
test('setConsent 忽略调用方的 chat 位，三种写入都是 chat:false', () => {
  const local = new Store();
  const prev = globalThis.window;
  globalThis.window = { localStorage: local, dispatchEvent() { return true; } } as unknown as Window & typeof globalThis;
  try {
    assert.equal(setConsent({ analytics: true, chat: true }).chat, false);
    assert.equal(setConsent({ analytics: false, chat: true }).chat, false);
    assert.equal(setConsent({ analytics: true }).chat, false);
    assert.equal(JSON.parse(local.getItem('pj-consent') ?? '').analytics, true);
    assert.equal(JSON.parse(local.getItem('pj-consent') ?? '').chat, false);
  } finally {
    globalThis.window = prev;
  }
});

test('旧 chat:true 才算清掉；提示只在分析从开到关时是已撤回', () => {
  assert.equal(legacyChatCleared(null, { chat: false }), false);
  assert.equal(legacyChatCleared({ chat: false }, { chat: false }), false);
  assert.equal(legacyChatCleared({ chat: true }, { chat: false }), true);
  assert.equal(consentNotice(null, false), 'saved');
  assert.equal(consentNotice({ analytics: true }, true), 'saved');
  assert.equal(consentNotice({ analytics: true }, false), 'withdrawn');
  assert.equal(consentNotice({ analytics: false }, false), 'saved');
});

test('clearTawkData 清掉残留键、脚本和匹配的 cookie', () => {
  const local = new Store();
  const session = new Store();
  local.setItem('twk_uuid_test', '1');
  local.setItem('pj-consent', '{}');
  session.setItem('TawkConnectionTime', '1');
  const removed: string[] = [];
  const node = { id: 'tawk-js', src: 'https://embed.tawk.to/x.js', remove() { removed.push(this.id); } };
  const jar: string[] = [];
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const win = {
    localStorage: local,
    sessionStorage: session,
    Tawk_API: { hide() {} },
    dispatchEvent() { return true; },
  };
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = {
    getElementById(id: string) { return id === 'tawk-js' ? node : null; },
    querySelectorAll() { return [node]; },
    get cookie() { return 'twk_id=1; theme=light'; },
    set cookie(v: string) { jar.push(v); },
  } as unknown as Document;
  (globalThis as { location?: { hostname: string } }).location = { hostname: 'localhost' };
  try {
    clearTawkData();
    assert.equal(local.getItem('twk_uuid_test'), null);
    assert.equal(local.getItem('pj-consent'), '{}');
    assert.equal(session.getItem('TawkConnectionTime'), null);
    assert.equal('Tawk_API' in win, false);
    assert.deepEqual(removed, ['tawk-js', 'tawk-js']);
    assert.ok(jar.some((c) => c.startsWith('twk_id=; Max-Age=0')));
    assert.equal(jar.some((c) => c.startsWith('theme=')), false);
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
});

test('横幅和设置面板的接受、拒绝、保存都传入 chat:false', () => {
  const src = readFileSync(new URL('../src/components/consent/CookieConsent.tsx', import.meta.url), 'utf8');
  assert.match(src, /onClick=\{\(\) => save\(\{ analytics: false, chat: false \}, false\)\}/);
  assert.match(src, /onClick=\{\(\) => save\(\{ analytics: true, chat: false \}, false\)\}/);
  assert.match(src, /onClick=\{\(\) => onSave\(\{ analytics: false, chat: false \}\)\}/);
  assert.match(src, /onClick=\{\(\) => onSave\(\{ analytics: true, chat: false \}\)\}/);
  assert.match(src, /onClick=\{\(\) => onSave\(\{ analytics: draft\.analytics, chat: false \}\)\}/);
  assert.doesNotMatch(src, /chat: true/);
});
});
