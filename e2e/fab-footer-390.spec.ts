import { test, expect, type Locator, type Page } from './fixtures';

const PHONE = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
] as const;

const LOCALES = [
  { path: '/en', cookie: 'Cookie settings', close: 'Close', menu: 'Quick actions' },
  { path: '/ru', cookie: 'Настройки cookie', close: 'Закрыть', menu: 'Быстрые действия' },
] as const;

type Locale = (typeof LOCALES)[number];

type Hit = { id: string; label: string; inView: boolean; ok: boolean };

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function seedConsent(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('pj-consent', JSON.stringify({ v: 2, analytics: false, chat: false, ts: Date.now() }));
  });
}

async function openHome(page: Page, path: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await seedConsent(page);
  await page.goto(path);
  await expect(page.locator('footer.site-footer')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function waitForFabHeight(page: Page) {
  await page.waitForFunction(() => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--fab-h').trim();
    return /^\d+px$/.test(raw) && parseFloat(raw) > 0;
  });
}

async function scrollToBottom(page: Page) {
  await page.evaluate(async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let i = 0; i < 4; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await wait(100);
    }
  });
  await page.waitForFunction(() => {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return Math.abs(window.scrollY - max) <= 2;
  });
}

async function hitReport(page: Page): Promise<Hit[]> {
  return page.evaluate(() => {
    const footer = document.querySelector('footer.site-footer');
    if (!footer) return [];
    return [...footer.querySelectorAll('a, button')].map((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const inView = r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
      const hit = inView ? document.elementFromPoint(x, y) : null;
      return {
        id: el.id,
        label: (el.getAttribute('aria-label') || el.textContent || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 80),
        inView,
        ok: !!hit && el.contains(hit),
      };
    });
  });
}

async function assertCollapsedMenu(page: Page) {
  const items = page.locator('.fab .item');
  await expect(items).toHaveCount(3);
  for (const item of await items.all()) {
    expect(await item.evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
    await expect(item).toHaveAttribute('aria-hidden', 'true');
    expect(await item.evaluate((el) => el.hasAttribute('inert'))).toBe(true);
    expect(await item.evaluate((el) => {
      (el as HTMLElement).focus();
      return document.activeElement === el;
    })).toBe(false);
  }
}

async function assertFooterHits(page: Page, controls: Locator) {
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  const report = await hitReport(page);
  expect(report).toHaveLength(count);
  expect(report.filter((row) => row.inView && !row.ok)).toEqual([]);
  const cookie = report.find((row) => row.id === 'cookie-settings-link');
  expect(cookie?.inView, 'Cookie settings should be in view at the bottom of the page').toBe(true);
  expect(cookie?.ok).toBe(true);
  for (let i = 0; i < count; i++) {
    if (report[i].inView) continue;
    await controls.nth(i).scrollIntoViewIfNeeded();
    const ok = await controls.nth(i).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    });
    expect(ok, report[i].label).toBe(true);
  }
  return report;
}

async function exerciseFooter(page: Page, locale: Locale, expanded: boolean) {
  const controls = page.locator('footer.site-footer').locator('a, button');
  await scrollToBottom(page);
  const report = await assertFooterHits(page, controls);
  if (expanded) {
    const cookieBox = await page.locator('#cookie-settings-link').boundingBox();
    expect(cookieBox).not.toBeNull();
    const fabs = page.locator('.fab button, .fab a');
    const n = await fabs.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const box = await fabs.nth(i).boundingBox();
      expect(box, `FAB control ${i}`).not.toBeNull();
      expect(overlaps(box!, cookieBox!)).toBe(false);
    }
  }
  await scrollToBottom(page);
  for (let i = 0; i < report.length; i++) {
    if (report[i].id === 'cookie-settings-link') continue;
    await controls.nth(i).click({ trial: true });
  }
  await scrollToBottom(page);
  await page.locator('#cookie-settings-link').click();
  const dialog = page.getByRole('dialog', { name: locale.cookie });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: locale.close }).click();
  await expect(dialog).toHaveCount(0);
}

async function setExpanded(page: Page, locale: Locale, expanded: boolean) {
  const fab = page.locator('.fab');
  const open = await fab.evaluate((el) => el.classList.contains('open'));
  if (open !== expanded) await page.getByRole('button', { name: locale.menu }).click();
  if (expanded) await expect(fab).toHaveClass(/\bopen\b/);
  else await expect(fab).not.toHaveClass(/\bopen\b/);
}

async function metrics(page: Page) {
  return page.evaluate(() => {
    const footer = document.querySelector('footer.site-footer');
    if (!footer) throw new Error('footer missing');
    return {
      y: window.scrollY,
      pad: getComputedStyle(footer).paddingBottom,
      fab: getComputedStyle(document.documentElement).getPropertyValue('--fab-h').trim(),
    };
  });
}

for (const vp of PHONE) {
  for (const loc of LOCALES) {
    test(`${vp.width}px ${loc.path}: footer links stay clickable with the FAB collapsed and expanded`, async ({ page }) => {
      test.setTimeout(120_000);
      await openHome(page, loc.path, vp.width, vp.height);
      await waitForFabHeight(page);
      await assertCollapsedMenu(page);
      await exerciseFooter(page, loc, false);
      await setExpanded(page, loc, true);
      await exerciseFooter(page, loc, true);
    });
  }
}

for (const loc of LOCALES) {
  test(`1440px ${loc.path}: footer padding-bottom stays 24px and links are clickable`, async ({ page }) => {
    test.setTimeout(90_000);
    await openHome(page, loc.path, 1440, 900);
    await waitForFabHeight(page);
    const pad = await page.locator('footer.site-footer').evaluate((el) => getComputedStyle(el).paddingBottom);
    expect(pad).toBe('24px');
    await expect(page.locator('footer.site-footer')).toBeVisible();
    await expect(page.locator('.fab .toggle')).toBeHidden();
    for (const item of await page.locator('.fab .item').all()) await expect(item).toBeVisible();
    await scrollToBottom(page);
    await page.locator('#privacy-link').click({ trial: true });
    await page.locator('#cookie-settings-link').click();
    const dialog = page.getByRole('dialog', { name: loc.cookie });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: loc.close }).click();
    await expect(dialog).toHaveCount(0);
  });

  test(`390px ${loc.path}: toggling the FAB does not move the page or the footer padding`, async ({ page }) => {
    test.setTimeout(90_000);
    await openHome(page, loc.path, 390, 844);
    await waitForFabHeight(page);
    const toggle = page.getByRole('button', { name: loc.menu });
    for (const where of ['middle', 'bottom'] as const) {
      if (where === 'middle') {
        await page.evaluate(() => {
          const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          window.scrollTo(0, Math.round(max / 2));
        });
      } else {
        await scrollToBottom(page);
      }
      const before = await metrics(page);
      expect(parseFloat(before.fab)).toBeGreaterThan(0);
      expect(before.fab.endsWith('px')).toBe(true);
      expect(parseFloat(before.pad)).toBeGreaterThan(96);
      await toggle.click();
      const expanded = await metrics(page);
      await toggle.click();
      const collapsed = await metrics(page);
      await toggle.click();
      const again = await metrics(page);
      for (const snap of [expanded, collapsed, again]) {
        expect(snap.y).toBe(before.y);
        expect(snap.pad).toBe(before.pad);
        expect(snap.fab).toBe(before.fab);
      }
      await toggle.click();
      const back = await metrics(page);
      expect(back.y).toBe(before.y);
      expect(back.pad).toBe(before.pad);
      expect(back.fab).toBe(before.fab);
    }
  });

  test(`390px ${loc.path}: first load sets --fab-h before the menu is ever opened`, async ({ page }) => {
    test.setTimeout(90_000);
    await openHome(page, loc.path, 390, 844);
    await waitForFabHeight(page);
    await expect(page.locator('.fab')).not.toHaveClass(/\bopen\b/);
    await assertCollapsedMenu(page);
    await scrollToBottom(page);
    const fab = await metrics(page);
    expect(parseFloat(fab.fab)).toBeGreaterThan(0);
    const cookie = page.locator('#cookie-settings-link');
    const hit = await cookie.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!target && el.contains(target);
    });
    expect(hit).toBe(true);
    await cookie.click();
    const dialog = page.getByRole('dialog', { name: loc.cookie });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: loc.close }).click();
    await expect(dialog).toHaveCount(0);
  });
}
