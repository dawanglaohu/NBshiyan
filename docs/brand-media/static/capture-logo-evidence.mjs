import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = path.join(root, 'docs/brand-media/static/evidence');
const pageUrl = process.argv[2] ?? 'http://localhost:3123/en';
if (!['localhost', '127.0.0.1'].includes(new URL(pageUrl).hostname)) {
  throw new Error('Use an isolated local Next service for source capture.');
}
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const response = await page.goto(pageUrl, { waitUntil: 'networkidle' });
  if (response.status() !== 200) throw new Error(`Page returned ${response.status()}`);
  await page.locator('header.site .logo').waitFor({ state: 'visible' });
  const evidence = await page.evaluate(async () => {
    await document.fonts.ready;
    const logo = document.querySelector('header.site .logo');
    const joy = logo.querySelector('i');
    const style = getComputedStyle(logo);
    const box = logo.getBoundingClientRect();
    const characterLefts = [];
    for (const node of [logo.childNodes[0], joy.firstChild, logo.childNodes[2]]) {
      for (let index = 0; index < node.textContent.length; index++) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        characterLefts.push(range.getBoundingClientRect().left - box.left);
      }
    }
    const faces = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
      .filter(rule => rule.type === CSSRule.FONT_FACE_RULE);
    const latin = faces.find(rule => rule.style.fontFamily === 'Manrope'
      && rule.style.unicodeRange.startsWith('U+0-FF'));
    if (!latin) throw new Error('Current Manrope Latin source was not found');
    return {
      pageUrl: location.href,
      fontStatus: document.fonts.status,
      logo: {
        text: logo.textContent, fontFamily: style.fontFamily,
        fontSize: style.fontSize, fontWeight: style.fontWeight,
        fontStyle: style.fontStyle, fontKerning: style.fontKerning,
        letterSpacing: style.letterSpacing, lineHeight: style.lineHeight,
        color: style.color, joyColor: getComputedStyle(joy).color,
        joyFontStyle: getComputedStyle(joy).fontStyle, width: box.width,
        characterLefts,
      },
      fontFace: latin.cssText,
      fontResource: { url: new URL(latin.style.src.match(/url\(["']?([^"')]+)/)[1], location.href).href },
    };
  });
  const fontResponse = await page.request.get(evidence.fontResource.url);
  if (!fontResponse.ok()) throw new Error('Loaded font could not be read');
  const font = await fontResponse.body();
  evidence.fontResource.path = 'docs/brand-media/static/evidence/current-manrope-latin.woff2';
  evidence.fontResource.sha256 = createHash('sha256').update(font).digest('hex');
  evidence.capture = { browser: browser.version(), service: 'Next.js development, task worktree', viewport: '1440x900', applicationApiMocking: false, scope: 'Header font and source only; no database or product acceptance claimed.' };
  await writeFile(path.join(root, evidence.fontResource.path), font);
  await copyFile(path.join(root, 'src/assets/og-fonts/OFL.txt'), path.join(output, 'font-OFL.txt'));
  await page.locator('header.site').screenshot({ path: path.join(output, 'current-header.png') });
  await writeFile(path.join(output, 'current-header.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await browser.close();
}
