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

type Box = { x: number; y: number; width: number; height: number };
type Pt = { x: number; y: number };

// html { scroll-behavior: smooth }：scrollTo 返回时 scrollY 可能还没动。基线必须等连续两次读数相同，且已经到达目标。
async function waitForScroll(page: Page, target: number) {
  let previous = Number.NaN;
  await expect.poll(async () => {
    const y = await page.evaluate(() => window.scrollY);
    const settled = y === previous && Math.abs(y - target) <= 2;
    previous = y;
    return settled;
  }).toBe(true);
}

async function scrollToBottom(page: Page) {
  let previous = Number.NaN;
  await expect.poll(async () => {
    const snapshot = await page.evaluate(() => {
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      if (Math.abs(window.scrollY - max) > 2) window.scrollTo({ top: max, behavior: 'instant' });
      return { y: window.scrollY, max };
    });
    const settled = snapshot.y === previous && Math.abs(snapshot.y - snapshot.max) <= 2;
    previous = snapshot.y;
    return settled;
  }).toBe(true);
}

function zoneAboveToggle(fab: Box, toggle: Box): Box {
  return { x: fab.x, y: fab.y, width: fab.width, height: toggle.y - fab.y };
}

function sampleZone(zone: Box): Pt[] {
  const inset = 4;
  const left = zone.x + inset;
  const right = zone.x + zone.width - inset;
  const top = zone.y + inset;
  const bottom = zone.y + zone.height - inset;
  const cols = 3;
  const rows = 5;
  const points: Pt[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      points.push({
        x: left + ((col + 0.5) * (right - left)) / cols,
        y: top + ((row + 0.5) * (bottom - top)) / rows,
      });
    }
  }
  return points;
}

function pointInOverlap(target: Box, zone: Box, withinRightPx: number): Pt | null {
  const left = Math.max(target.x, zone.x, target.x + target.width - withinRightPx);
  const right = Math.min(target.x + target.width, zone.x + zone.width);
  const top = Math.max(target.y, zone.y);
  const bottom = Math.min(target.y + target.height, zone.y + zone.height);
  if (right - left < 1 || bottom - top < 1) return null;
  const span = right - left;
  return { x: right - Math.min(2, span / 2), y: (top + bottom) / 2 };
}

async function hitAt(page: Page, point: Pt) {
  return page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    const fab = document.querySelector('.fab');
    const className = hit && 'className' in hit ? String((hit as HTMLElement).className) : '';
    return {
      inFab: !!hit && !!fab && (hit === fab || fab.contains(hit)),
      desc: hit ? `${hit.tagName}.${className}` : 'null',
    };
  }, point);
}

async function assertPassesThrough(page: Page, points: Pt[]) {
  const blocked: { x: number; y: number; desc: string }[] = [];
  for (const point of points) {
    const hit = await hitAt(page, point);
    if (hit.inFab) blocked.push({ ...point, desc: hit.desc });
  }
  expect(blocked).toEqual([]);
}

async function assertHitsOwner(page: Page, owner: Locator, point: Pt, label: string) {
  const hit = await hitAt(page, point);
  const owned = await owner.evaluate((el, p) => {
    const target = document.elementFromPoint(p.x, p.y);
    return !!target && el.contains(target);
  }, point);
  expect(owned, `${label} hit ${hit.desc}`).toBe(true);
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
    test(`${vp.width}px ${loc.path}: collapsed FAB dead zone lets clicks through`, async ({ page }) => {
      test.setTimeout(90_000);
      await openHome(page, loc.path, vp.width, vp.height);
      await waitForFabHeight(page);
      const fab = page.locator('.fab');
      await expect(fab).not.toHaveClass(/\bopen\b/);
      const fabBox = await fab.boundingBox();
      const toggle = page.getByRole('button', { name: loc.menu });
      const toggleBox = await toggle.boundingBox();
      expect(fabBox).not.toBeNull();
      expect(toggleBox).not.toBeNull();
      const zone = zoneAboveToggle(fabBox!, toggleBox!);
      expect(zone.height).toBeGreaterThan(150);
      expect(zone.width).toBeGreaterThan(40);
      await assertPassesThrough(page, sampleZone(zone));

      if (vp.width === 390 && loc.path === '/ru') {
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        const skip = page.getByRole('button', { name: 'Пропустить видео' });
        const play = page.getByRole('button', { name: 'Смотреть видео' });
        await expect(skip.or(play)).toBeVisible();
        if (await play.isVisible()) await play.click();
        await expect(skip).toBeVisible();
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        const skipBox = await skip.boundingBox();
        expect(skipBox).not.toBeNull();
        const point = pointInOverlap(skipBox!, zone, skipBox!.width);
        expect(point, `skip ${JSON.stringify(skipBox)} zone ${JSON.stringify(zone)}`).not.toBeNull();
        expect(point!.x).toBeGreaterThan(skipBox!.x + skipBox!.width / 2);
        const hit = await hitAt(page, point!);
        expect(hit.inFab, hit.desc).toBe(false);
        await assertHitsOwner(page, skip, point!, 'Пропустить видео');
      }

      if (vp.width === 390 && loc.path === '/en') {
        const link = page.locator('.entry').getByRole('link', { name: 'Color Boxes' });
        await expect(link).toBeVisible();
        let linkBox = await link.boundingBox();
        expect(linkBox).not.toBeNull();
        let point = pointInOverlap(linkBox!, zone, 48);
        if (!point) {
          const delta = (linkBox!.y + linkBox!.height / 2) - (zone.y + zone.height / 2);
          const target = await page.evaluate((dy) => {
            const top = Math.max(0, window.scrollY + dy);
            window.scrollTo({ top, behavior: 'instant' });
            return top;
          }, delta);
          await waitForScroll(page, target);
          linkBox = await link.boundingBox();
          expect(linkBox).not.toBeNull();
          point = pointInOverlap(linkBox!, zone, 48);
        }
        expect(point, `color boxes ${JSON.stringify(linkBox)} zone ${JSON.stringify(zone)}`).not.toBeNull();
        expect(linkBox!.x + linkBox!.width - point!.x).toBeLessThanOrEqual(48);
        expect(linkBox!.x + linkBox!.width - point!.x).toBeGreaterThan(0);
        const hit = await hitAt(page, point!);
        expect(hit.inFab, hit.desc).toBe(false);
        await assertHitsOwner(page, link, point!, 'Color Boxes');
      }

      await assertHitsOwner(page, toggle, {
        x: toggleBox!.x + toggleBox!.width / 2,
        y: toggleBox!.y + toggleBox!.height / 2,
      }, 'collapsed toggle');
      await toggle.click();
      await expect(fab).toHaveClass(/\bopen\b/);
      for (const item of await page.locator('.fab .item').all()) {
        const box = await item.boundingBox();
        expect(box).not.toBeNull();
        await assertHitsOwner(page, item, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }, 'open FAB item');
      }
    });

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
    for (const item of await page.locator('.fab .item').all()) {
      await expect(item).toBeVisible();
      const box = await item.boundingBox();
      expect(box).not.toBeNull();
      await assertHitsOwner(page, item, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }, 'desktop FAB item');
    }
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
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openHome(page, loc.path, 390, 844);
    await waitForFabHeight(page);
    const toggle = page.getByRole('button', { name: loc.menu });
    for (const where of ['middle', 'bottom'] as const) {
      if (where === 'middle') {
        const target = await page.evaluate(() => {
          const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
          const top = Math.round(max / 2);
          window.scrollTo({ top, behavior: 'instant' });
          return top;
        });
        await waitForScroll(page, target);
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
