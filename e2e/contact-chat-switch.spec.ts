import { test, expect, type Locator, type Page } from './fixtures';
import { isThirdPartyChatUrl, thirdPartyChatDomSelector } from './third-party-chat';

const OFF = 'rgb(255, 255, 255)';
const ON = 'rgb(0, 0, 0)';

function opaque(color: string): string {
  const match = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return match ? `rgb(${match[1]}, ${match[2]}, ${match[3]})` : color;
}

async function armStorageProbe(page: Page) {
  await page.addInitScript(() => {
    const writes: string[] = [];
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      const kind = this === window.localStorage ? 'localStorage' : this === window.sessionStorage ? 'sessionStorage' : 'storage';
      writes.push(`${kind}:${String(key)}`);
      return orig.call(this, key, value);
    };
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (desc?.set && desc.get) {
      const set = desc.set;
      const get = desc.get;
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get() { return get.call(document); },
        set(value: string) {
          writes.push(`cookie:${String(value).split('=')[0]?.trim()}`);
          set.call(document, value);
        },
      });
    }
    (window as unknown as { __pjWrites: string[] }).__pjWrites = writes;
  });
}

async function storageWrites(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __pjWrites?: string[] }).__pjWrites ?? []);
}

async function readSwitch(sw: Locator) {
  return sw.evaluate((el) => {
    const paint = getComputedStyle(el);
    return {
      hovered: el.matches(':hover'),
      checked: el.getAttribute('aria-checked'),
      backgroundColor: paint.backgroundColor,
      indicator: el.querySelector('[aria-hidden="true"]')?.textContent ?? '',
    };
  });
}

function expectPaint(
  snapshot: Awaited<ReturnType<typeof readSwitch>>,
  checked: boolean,
  labels: { on: string; off: string },
) {
  expect(snapshot.checked).toBe(checked ? 'true' : 'false');
  expect(opaque(snapshot.backgroundColor)).toBe(checked ? ON : OFF);
  expect(snapshot.indicator).toBe(checked ? labels.on : labels.off);
}

async function statusLines(page: Page): Promise<number> {
  return page.locator('.contact-chat-status').evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = new Set<number>();
    for (const rect of range.getClientRects()) {
      if (rect.width > 0 && rect.height > 0) tops.add(Math.round(rect.top));
    }
    return tops.size;
  });
}

async function expectOwnLine(page: Page) {
  const box = await page.evaluate(() => {
    const button = document.querySelector('#contact-chat-switch');
    const status = document.querySelector('.contact-chat-status');
    if (!button || !status) return null;
    const b = button.getBoundingClientRect();
    const s = status.getBoundingClientRect();
    return { buttonBottom: b.bottom, statusTop: s.top, buttonLeft: b.left, statusLeft: s.left };
  });
  expect(box).not.toBeNull();
  expect(box!.statusTop).toBeGreaterThanOrEqual(box!.buttonBottom - 1);
  expect(box!.statusLeft).toBeLessThanOrEqual(box!.buttonLeft + 1);
}

async function prepare(page: Page, path: string) {
  const seen: string[] = [];
  page.on('request', (request) => seen.push(request.url()));
  await armStorageProbe(page);
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  const sw = page.locator('#contact-chat-switch');
  await expect(sw).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pj-quote-v1'))).not.toBeNull();
  return { sw, seen };
}

test.describe('联系页聊天开关', () => {
  test('1280 指针留在开关上时，底色和 On/Off 跟 aria-checked', async ({ page, external }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const [path, name, labels] of [
      ['/en/contact', 'Live chat', { on: 'On', off: 'Off' }],
      ['/ru/contact', 'Онлайн-чат', { on: 'Вкл', off: 'Выкл' }],
    ] as const) {
      const { sw, seen } = await prepare(page, path);
      await expect(sw).toHaveAccessibleName(name);
      const before = await page.evaluate(() => ({ local: JSON.stringify(localStorage), cookie: document.cookie }));
      await sw.click();
      const on = await readSwitch(sw);
      expect(on.hovered).toBe(true);
      expectPaint(on, true, labels);
      await sw.click();
      const off = await readSwitch(sw);
      expect(off.hovered).toBe(true);
      expectPaint(off, false, labels);
      const after = await page.evaluate(() => ({ local: JSON.stringify(localStorage), cookie: document.cookie }));
      expect(after).toEqual(before);
      const writes = await storageWrites(page);
      expect(writes.filter((item) => item !== 'localStorage:pj-quote-v1')).toEqual([]);
      expect(writes.some((item) => item.includes('pj-consent'))).toBe(false);
      expect(external.urls.filter((url) => isThirdPartyChatUrl(url))).toEqual([]);
      expect(seen.filter((url) => isThirdPartyChatUrl(url) || /\/api\/analytics|\/api\/rum/i.test(url))).toEqual([]);
      expect(external.urls).toEqual([]);
      await expect(page.locator(thirdPartyChatDomSelector())).toHaveCount(0);
    }
  });

  test.describe('390 触屏', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('点按后底色跟 aria-checked，英俄状态句不超过两行', async ({ page, external }) => {
      const hoverCapable = await page.evaluate(() => matchMedia('(hover: hover)').matches);
      expect(hoverCapable).toBe(false);
      const counts: string[] = [];
      for (const [path, name, labels] of [
        ['/en/contact', 'Live chat', { on: 'On', off: 'Off' }],
        ['/ru/contact', 'Онлайн-чат', { on: 'Вкл', off: 'Выкл' }],
      ] as const) {
        const { sw, seen } = await prepare(page, path);
        await expect(sw).toHaveAccessibleName(name);
        const locale = path.slice(1, 3);
        const offLines = await statusLines(page);
        counts.push(`${locale} chatOff ${offLines}`);
        expect(offLines).toBeLessThanOrEqual(2);
        await expectOwnLine(page);
        const before = await page.evaluate(() => ({ local: JSON.stringify(localStorage), cookie: document.cookie }));
        await sw.tap();
        expectPaint(await readSwitch(sw), true, labels);
        const onLines = await statusLines(page);
        counts.push(`${locale} chatOn ${onLines}`);
        expect(onLines).toBeLessThanOrEqual(2);
        await expectOwnLine(page);
        await sw.tap();
        expectPaint(await readSwitch(sw), false, labels);
        const after = await page.evaluate(() => ({ local: JSON.stringify(localStorage), cookie: document.cookie }));
        expect(after).toEqual(before);
        const writes = await storageWrites(page);
        expect(writes.filter((item) => item !== 'localStorage:pj-quote-v1')).toEqual([]);
        expect(writes.some((item) => item.includes('pj-consent'))).toBe(false);
        expect(external.urls).toEqual([]);
        expect(seen.filter((url) => isThirdPartyChatUrl(url) || /\/api\/analytics|\/api\/rum/i.test(url))).toEqual([]);
        await expect(page.locator(thirdPartyChatDomSelector())).toHaveCount(0);
      }
      console.log(`CHAT_STATUS_LINES ${counts.join(' | ')}`);
    });
  });
});
