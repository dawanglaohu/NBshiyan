import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearTawkData, consentNotice, migrateLegacyChat, setConsent } from '../src/lib/consent';

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

test('提示只在分析从开到关时是已撤回', () => {
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
  assert.match(src, /migrateLegacyChat\(\)/);
  assert.doesNotMatch(src, /location\.reload/);
  assert.doesNotMatch(src, /legacyChatCleared/);
  assert.doesNotMatch(src, /pj-consent-toast/);
});

test('migrateLegacyChat 只把 chat 改成 false，保留 ts 和 analytics，清残留且不派发事件', () => {
  const ts = Date.now() - 86_400_000;
  const local = new Store();
  const session = new Store();
  const events: string[] = [];
  const removed: string[] = [];
  local.setItem('pj-consent', JSON.stringify({ v: 2, analytics: true, chat: true, ts, note: 'keep' }));
  local.setItem('twk_uuid_test', '1');
  session.setItem('TawkConnectionTime', '1');
  const node = { id: 'tawk-js', remove() { removed.push(this.id); } };
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevLocation = (globalThis as { location?: { hostname: string } }).location;
  globalThis.window = {
    localStorage: local,
    sessionStorage: session,
    dispatchEvent(e: Event) { events.push(e.type); return true; },
  } as unknown as Window & typeof globalThis;
  globalThis.document = {
    getElementById(id: string) { return id === 'tawk-js' ? node : null; },
    querySelectorAll() { return []; },
    get cookie() { return ''; },
    set cookie(_: string) { /* unused */ },
  } as unknown as Document;
  (globalThis as { location?: { hostname: string } }).location = { hostname: 'localhost' };
  try {
    migrateLegacyChat();
    const saved = JSON.parse(local.getItem('pj-consent') ?? '');
    assert.equal(saved.chat, false);
    assert.equal(saved.ts, ts);
    assert.equal(saved.analytics, true);
    assert.equal(saved.note, 'keep');
    assert.equal(saved.v, 2);
    assert.equal(local.getItem('twk_uuid_test'), null);
    assert.equal(session.getItem('TawkConnectionTime'), null);
    assert.deepEqual(removed, ['tawk-js']);
    assert.deepEqual(events, []);
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    (globalThis as { location?: { hostname: string } }).location = prevLocation;
  }
});

test('migrateLegacyChat 在 chat 不是 true 或没有有效记录时不写存储', () => {
  const ts = Date.now() - 86_400_000;
  const samples = [
    null,
    JSON.stringify({ v: 2, analytics: false, chat: false, ts }),
    'not-json',
    JSON.stringify({ v: 1, analytics: true, chat: true, ts }),
  ];
  for (const raw of samples) {
    const local = new Store();
    let writes = 0;
    if (raw !== null) local.setItem('pj-consent', raw);
    local.setItem('twk_uuid_test', '1');
    const orig = local.setItem.bind(local);
    local.setItem = (k: string, v: string) => { writes += 1; orig(k, v); };
    const prevWindow = globalThis.window;
    globalThis.window = { localStorage: local, dispatchEvent() { return true; } } as unknown as Window & typeof globalThis;
    try {
      migrateLegacyChat();
      assert.equal(writes, 0, raw ?? 'empty');
      assert.equal(local.getItem('pj-consent'), raw);
      assert.equal(local.getItem('twk_uuid_test'), '1');
    } finally {
      globalThis.window = prevWindow;
    }
  }
});
});
