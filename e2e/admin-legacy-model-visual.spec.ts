import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import sharp from 'sharp';
import { authenticator } from 'otplib';
import { test, expect } from './fixtures';
const BASE = `http://localhost:${Number(process.env.E2E_PORT ?? 3100)}`;

const PASSWORD = 'M3T23-Test-Only-Strong.2026!';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PROBE = readFileSync('docs/PackJoyU-开发文档/_run/density_probe.js', 'utf8');
const VIEWPORTS = [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 390, height: 844 }];
const COMPRESSED_POSITION = Buffer.from('oAEMAAAAZgEMAAAAaAEMAAAAaAE8AAAA/3sAAAABDAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADNzMy+zczMvgAAAAA=', 'base64');

/** A real meshopt-encoded triangle; the extension bytes and accessor agree, no fake compression flag. */
function modelFile(compressed: boolean) {
  const positions = Buffer.from(new Float32Array([-0.4, -0.4, 0, 0.4, -0.4, 0, 0, 0.4, 0]).buffer);
  const bytes = compressed ? COMPRESSED_POSITION : positions;
  const bin = Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4)]);
  const view = compressed
    ? { buffer: 1, byteLength: 36, byteStride: 12, target: 34962, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: bytes.length, byteStride: 12, count: 3, mode: 'ATTRIBUTES', filter: 'NONE' } } }
    : { buffer: 0, byteLength: 36, byteStride: 12, target: 34962 };
  const document = {
    asset: { version: '2.0', generator: 'M3-T23 isolated triangle' },
    ...(compressed ? { extensionsUsed: ['EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'] } : {}),
    buffers: compressed ? [{ byteLength: bin.length }, { byteLength: 36 }] : [{ byteLength: bin.length }],
    bufferViews: [view], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.4, -0.4, 0], max: [0.4, 0.4, 0] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0.42, 0.04, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
  const json = Buffer.from(JSON.stringify(document));
  const body = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + body.length + bin.length, 8);
  jsonHeader.writeUInt32LE(body.length); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  binHeader.writeUInt32LE(bin.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, body, binHeader, bin]);
}

async function shot(page: Page, testInfo: TestInfo, role: string, width: number, state: string) {
  await page.screenshot({ path: testInfo.outputPath(`model-workflow-${role}-${width}-${state}.png`), animations: 'disabled' });
}

async function waitForEmptyModel(page: Page) {
  await page.waitForFunction(() => {
    const root = document.querySelector<HTMLElement>('.mdl[data-model-stage="0"]');
    const layout = root?.querySelector<HTMLElement>('.mdl-layout');
    const file = root?.querySelector<HTMLInputElement>('.mdl-file-input');
    const upload = root?.querySelector<HTMLButtonElement>('.mdl-file-options button');
    const empty = root?.querySelector<HTMLElement>('.mdl-preview .pj-status[data-tone="empty"]');
    return Boolean(root && layout && file && upload && empty && getComputedStyle(layout).display === 'grid' && layout.getBoundingClientRect().width > 0 && root.querySelectorAll('.mdl-section').length === 2 && !file.disabled && upload.disabled && empty.getBoundingClientRect().height > 0);
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function checkCheckbox(page: Page) {
  const label = page.locator('.mdl-checkbox-label');
  const checkbox = page.getByRole('checkbox', { name: '带开盒 / 刀模动画（体积上限 1.5MB）', exact: true });
  await expect(label).toBeVisible(); await expect(checkbox).not.toBeChecked();
  await label.click(); await expect(checkbox).toBeChecked();
  await page.getByLabel('产品', { exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(checkbox).toBeFocused();
  const observed = await label.evaluate((el) => {
    const input = el.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!input) throw new Error('checkbox input missing');
    const r = el.getBoundingClientRect(), style = getComputedStyle(el), control = getComputedStyle(input), mark = getComputedStyle(input, '::before');
    return { label: { width: r.width, height: r.height, color: style.color }, checked: input.checked, mark: { content: mark.content, color: mark.color, background: control.backgroundColor }, focus: { visible: input.matches(':focus-visible'), width: control.outlineWidth, style: control.outlineStyle, color: control.outlineColor } };
  });
  expect(observed.label.width).toBeGreaterThanOrEqual(44); expect(observed.label.height).toBeGreaterThanOrEqual(44);
  expect(observed.label.color).toBe('rgb(0, 0, 0)'); expect(observed.checked).toBe(true);
  expect(observed.mark.content.replace(/^"|"$/g, '')).toBe('✓'); expect(observed.mark.color).toBe('rgb(255, 255, 255)'); expect(observed.mark.background).toBe('rgb(0, 0, 0)');
  expect(observed.focus).toEqual({ visible: true, width: '2px', style: 'solid', color: 'rgb(180, 87, 0)' });
  await label.click(); await expect(checkbox).not.toBeChecked();
  return observed;
}

async function geometry(page: Page, surface?: string) {
  return page.evaluate(({ source, label }) => {
    const selectors = ['.mdl-section', '.mdl-drop', '.mdl-preview', '.mdl-steps li i', '.mdl-alert', '.mdl-remedy', '.mdl .pj-button', '.mdl .pj-input', '.mdl-checkbox'];
    const elements = selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => el.getBoundingClientRect().width > 0).map((el) => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return { selector, disabled: el.matches(':disabled'), width: r.width, height: r.height, borders: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth], borderColors: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor], borderStyles: [s.borderTopStyle, s.borderRightStyle, s.borderBottomStyle, s.borderLeftStyle], radii: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius], shadow: s.boxShadow, image: s.backgroundImage, background: s.backgroundColor, color: s.color, fontSize: s.fontSize, opacity: s.opacity, padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft] };
    }));
    const statuses = [...document.querySelectorAll<HTMLElement>('.mdl .pj-status')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => {
      const s = getComputedStyle(el);
      const region = el.closest<HTMLElement>('.mdl-section');
      const regionStyle = region ? getComputedStyle(region) : null;
      return { tone: el.dataset.tone, preview: Boolean(el.closest('.mdl-preview')), color: s.color, background: s.backgroundColor, padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft], regionPadding: regionStyle ? [regionStyle.paddingTop, regionStyle.paddingRight, regionStyle.paddingBottom, regionStyle.paddingLeft] : null, align: s.textAlign, minHeight: s.minHeight };
    });
    const focused = document.querySelector<HTMLElement>('.mdl :focus-visible');
    const focus = focused ? getComputedStyle(focused) : null;
    const layout = document.querySelector<HTMLElement>('.mdl-layout'), main = document.querySelector<HTMLElement>('main.adm-main');
    const layoutRect = layout?.getBoundingClientRect(), mainRect = main?.getBoundingClientRect();
    const file = document.querySelector<HTMLInputElement>('.mdl-file-input');
    if (!layout || !mainRect || !layoutRect || layoutRect.width <= 0 || !file || !elements.length || !document.querySelector('.mdl-preview') || document.querySelectorAll('.mdl-section').length < 2 || !elements.some((item) => item.selector === '.mdl .pj-button')) throw new Error('model capture requires current nonempty layout and controls');
    let measuredDensity: Record<string, unknown> | null = null;
    if (label) {
      const root = document.querySelector<HTMLElement>('.mdl');
      if (label === 'empty' && (root?.dataset.modelStage !== '0' || file.disabled || !document.querySelector('.mdl-file-options button:disabled') || !statuses.some((status) => status.tone === 'empty'))) throw new Error('empty capture no longer matches the initial model state');
      (0, eval)(source);
      const probe = (globalThis as { densityProbe?: (o: unknown) => Record<string, unknown> }).densityProbe;
      if (!probe) throw new Error('densityProbe missing');
      const raw = probe({ type: 'form', density: 7, gutter: 16, gap: 16, pad: 16, main: 'main.adm-main', rail: 'nav#adm-nav' });
      const safe = { ...raw };
      delete safe.url; delete safe.sparseBlocks;
      measuredDensity = { surface: label, ...safe, sparseBlocks: Array.isArray(raw.sparseBlocks) ? raw.sparseBlocks.map((r) => ({ path: r.path, pad: r.pad })) : [] };
    }
    return { measuredDensity, elements, statuses, facts: { stage: document.querySelector<HTMLElement>('.mdl')?.dataset.modelStage, busy: document.querySelector('.mdl')?.getAttribute('aria-busy') === 'true', fileDisabled: file?.disabled, disabledButtons: document.querySelectorAll('.mdl button:disabled').length, errorVisible: Boolean(document.querySelector('.mdl-alert')), preview: document.querySelector<HTMLElement>('.mdl-preview-scene')?.dataset.previewState || 'empty' }, layout: layoutRect && mainRect && layout ? { width: layoutRect.width, leftGap: layoutRect.left - mainRect.left, tracks: getComputedStyle(layout).gridTemplateColumns, gap: getComputedStyle(layout).columnGap } : null, accent: getComputedStyle(document.documentElement).getPropertyValue('--pj-accent').trim(), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, focus: focus ? { style: focus.outlineStyle, width: focus.outlineWidth, color: focus.outlineColor } : null };
  }, { source: PROBE, label: surface ?? null });
}

async function density(page: Page, surface: string) {
  return page.evaluate(({ source, label }) => {
    (0, eval)(source);
    const probe = (globalThis as { densityProbe?: (o: unknown) => Record<string, unknown> }).densityProbe;
    if (!probe) throw new Error('densityProbe missing');
    const raw = probe({ type: 'form', density: 7, gutter: 16, gap: 16, pad: 16, main: 'main.adm-main', rail: 'nav#adm-nav' });
    // The full geometry is safe except optional sparse-block snippets and URL; store numerical findings only.
    const safe = { ...raw };
    delete safe.url;
    delete safe.sparseBlocks;
    return { surface: label, ...safe, sparseBlocks: Array.isArray(raw.sparseBlocks) ? raw.sparseBlocks.map((r) => ({ path: r.path, pad: r.pad })) : [] };
  }, { source: PROBE, label: surface });
}

test.use({ video: 'on' });

for (const role of ['ADMIN', 'EDITOR'] as const) test.describe(`M3-T23 ${role} real model workflow`, () => {
  let state: Awaited<ReturnType<APIRequestContext['storageState']>>;
  test.beforeAll(async ({ playwright }) => {
    const email = `model-visual-${role.toLowerCase()}-${Date.now()}@example.test`;
    execFileSync('node', ['scripts/create-admin.mjs'], { stdio: 'ignore', env: { ...process.env, ADMIN_SEED_EMAIL: email, ADMIN_SEED_PASSWORD: PASSWORD, ADMIN_SEED_NAME: `Model visual ${role}`, ADMIN_SEED_ROLE: role, ADMIN_SEED_TOTP_SECRET: TOTP } });
    const request = await playwright.request.newContext({ baseURL: BASE });
    try {
      const csrf = (await (await request.get('/api/auth/csrf')).json()).csrfToken as string;
      const login = await request.post('/api/auth/callback/credentials', { maxRedirects: 0, headers: { Origin: BASE }, form: { csrfToken: csrf, email, password: PASSWORD, totp: authenticator.generate(TOTP) } });
      expect(login.headers().location ?? '').not.toContain('error');
      const account = await request.get('/api/admin/account'); expect(account.status()).toBe(200); expect((await account.json()).role).toBe(role);
      state = await request.storageState();
    } finally { await request.dispose(); }
  });
  test.beforeEach(async ({ page }) => { await page.context().addCookies(state.cookies); });

  test('1920 coarse pointer: actual named model controls and checkbox label are 44px targets', async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: VIEWPORTS[0], hasTouch: true, baseURL: BASE });
    const page = await context.newPage();
    const path = testInfo.outputPath('admin-legacy-model.json');
    const cleanupErrors: string[] = [];
    const report: Record<string, unknown> = { task: 'M3-T23', role, viewport: VIEWPORTS[0], context: 'hasTouch/coarse', source: { commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null }, pass: false, cleanupErrors };
    let done = false, error: string | null = null;
    try {
      await context.addCookies(state.cookies);
      await page.goto('/admin/specs');
      await page.getByRole('navigation', { name: '后台导航' }).getByRole('link', { name: '3D 模型', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/models\/new$/);
      await waitForEmptyModel(page);
      const targets = await page.evaluate(() => ({
        coarse: matchMedia('(pointer: coarse)').matches,
        controls: [...document.querySelectorAll<HTMLElement>('.mdl .pj-button, .mdl .pj-input, .mdl-checkbox-label')].map((el) => { const r = el.getBoundingClientRect(); return { selector: el.className, width: r.width, height: r.height }; }),
      }));
      expect(targets.coarse).toBe(true); expect(targets.controls.length).toBeGreaterThanOrEqual(7);
      for (const control of targets.controls) { expect(control.width).toBeGreaterThanOrEqual(44); expect(control.height).toBeGreaterThanOrEqual(44); }
      report.targets = targets;
      report.checkbox = await checkCheckbox(page);
      await shot(page, testInfo, role, 1920, '07-coarse-targets');
      done = true;
    } catch (e) { error = e instanceof Error ? e.name : 'unknown'; throw e; }
    finally {
      try { await context.close(); } catch { cleanupErrors.push('context-close'); }
      report.error = error; report.pass = done && error === null && cleanupErrors.length === 0;
      writeFileSync(path, JSON.stringify(report, null, 2));
      await testInfo.attach('admin-legacy-model-coarse', { path, contentType: 'application/json' });
      expect(cleanupErrors).toEqual([]);
    }
  });

  for (const viewport of VIEWPORTS) test(`${viewport.width}: visible entry, failed checks, real GLB preview and confirmed publish`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const requests: Array<{ method: string; path: string; status: number }> = [];
    const modelRequest = async (method: 'GET' | 'POST', path: string, data?: { published: boolean }) => {
      const response = await page.request.fetch(path, { method, ...(method === 'POST' ? { headers: { Origin: BASE }, data } : {}) });
      requests.push({ method, path: path.split('?')[0], status: response.status() });
      return response;
    };
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (/^\/api\/admin\/models(?:\/|$)/.test(path)) requests.push({ method: response.request().method(), path, status: response.status() });
    });
    const samples: Array<Record<string, unknown>> = [];
    const checks: Array<Record<string, unknown>> = [];
    let checkboxEvidence: Awaited<ReturnType<typeof checkCheckbox>> | null = null;
    let publishedId: string | null = null, replacedIds: string[] = [];
    let errorStage = 'entry', errorName: string | null = null;
    const cdp = await page.context().newCDPSession(page);
    const poster = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 128, b: 16 } } }).png().toBuffer();
    try {
      // Both roles can read the existing specs page; its visible sidebar proves the model entry.
      await page.goto('/admin/specs');
      if (viewport.width < 768) await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
      await page.getByRole('navigation', { name: '后台导航' }).getByRole('link', { name: '3D 模型', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/models\/new$/);
      await expect(page.getByRole('heading', { name: '上传新模型', exact: true })).toBeVisible();
      await page.locator('.mdl-crumb').getByRole('link', { name: '3D 模型', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/models\/new$/);
      await expect(page.getByLabel('选择模型与封面文件')).toBeAttached();
      const upload = page.getByRole('button', { name: '上传并检查', exact: true });
      await expect(upload).toBeDisabled();
      await expect(page.getByText('选好文件后显示 3D 预览', { exact: false })).toBeVisible();
      await waitForEmptyModel(page);
      const { measuredDensity: emptyDensity, ...emptyGeometry } = await geometry(page, 'empty');
      if (!emptyDensity) throw new Error('initial density capture missing');
      samples.push(emptyDensity);
      checks.push({ state: 'empty/disabled', ...emptyGeometry });
      if (viewport.width >= 1024) {
        for (const button of await page.locator('.mdl-themes button').all()) {
          const rectangle = await button.boundingBox();
          expect(rectangle?.height, 'ordinary desktop theme controls remain 36px').toBe(36);
        }
      }
      await shot(page, testInfo, role, viewport.width, '00-empty');
      checkboxEvidence = await checkCheckbox(page);

      errorStage = 'client-limit';
      await page.getByLabel('选择模型与封面文件').setInputFiles({ name: 'oversized.glb', mimeType: 'model/gltf-binary', buffer: Buffer.alloc(1.5 * 1024 * 1024 + 1) });
      await expect(page.locator('.mdl-alert')).toContainText('超过 1.5MB');
      await expect(upload).toBeDisabled();
      checks.push({ state: 'client-error', ...(await geometry(page)) });
      samples.push(await density(page, 'client-error'));
      await shot(page, testInfo, role, viewport.width, '01-error');

      errorStage = 'failed-checks';
      await page.getByLabel('选择模型与封面文件').setInputFiles([{ name: 'uncompressed.glb', mimeType: 'model/gltf-binary', buffer: modelFile(false) }, { name: 'poster.png', mimeType: 'image/png', buffer: poster }]);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
      const failedUpload = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/admin/models').then((response) => ({ response, error: null }), (error: unknown) => ({ response: null, error }));
      await upload.click();
      await page.locator('.mdl-section[data-processing="true"]').waitFor({ state: 'visible' });
      const loadingSample = await geometry(page);
      expect(loadingSample.facts.busy, 'capture must observe the live upload state').toBe(true);
      expect(loadingSample.statuses.some((status) => status.tone === 'loading')).toBe(true);
      checks.push({ state: 'loading', ...loadingSample });
      samples.push(await density(page, 'loading'));
      await shot(page, testInfo, role, viewport.width, '02-loading');
      await expect(page.locator('.mdl[aria-busy="true"]')).toBeVisible();
      const uploaded = await failedUpload;
      if (uploaded.error) throw uploaded.error;
      if (!uploaded.response) throw new Error('model upload response missing');
      const failedResponse = uploaded.response;
      expect(failedResponse.status()).toBe(201); const failed = await failedResponse.json(); expect(failed.status).toBe('FAILED');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      const next = page.getByRole('button', { name: '下一步：预览确认', exact: true });
      await expect(next).toBeDisabled(); await expect(page.locator('#mdl-next-why')).toContainText('检查未通过');
      const blockedPublish = await modelRequest('POST', `/api/admin/models/${failed.id}/publish`, { published: true });
      expect(blockedPublish.status()).toBe(409); expect((await blockedPublish.json()).error).toBe('not_ready');
      const process = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/admin/models/${failed.id}/process`);
      await page.getByRole('button', { name: '重新检查', exact: true }).click(); expect((await process).status()).toBe(200);
      checks.push({ state: 'error/blocked', ...(await geometry(page)) });
      samples.push(await density(page, 'failed-checks'));
      await shot(page, testInfo, role, viewport.width, '03-blocked');

      errorStage = 'ready-preview';
      await page.getByRole('button', { name: '重新上传', exact: true }).click();
      await page.getByLabel('选择模型与封面文件').setInputFiles([{ name: 'meshopt-triangle.glb', mimeType: 'model/gltf-binary', buffer: modelFile(true) }, { name: 'poster.png', mimeType: 'image/png', buffer: poster }]);
      const readyUpload = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/admin/models');
      await upload.click(); const readyResponse = await readyUpload; expect(readyResponse.status()).toBe(201); const ready = await readyResponse.json(); expect(ready.status).toBe('READY');
      expect((await modelRequest('GET', `/api/admin/models/${ready.id}`)).status()).toBe(200);
      expect((await modelRequest('GET', `/api/admin/models/${ready.id}/file?variant=poster`)).status()).toBe(200);
      const storedGlb = await modelRequest('GET', `/api/admin/models/${ready.id}/file?variant=glb`);
      expect(storedGlb.status()).toBe(200); expect((await storedGlb.body()).subarray(0, 4).toString()).toBe('glTF');
      await expect(page.locator('.mdl-preview-scene[data-preview-state="ready"]')).toBeVisible();
      await expect(page.locator('.mdl-preview canvas')).toBeVisible();
      // Read the rendered Canvas pixels, not just a downloaded URL or test-injected ready flag.
      let colored = 0;
      await expect.poll(async () => {
        const pixels = await sharp(await page.locator('.mdl-preview canvas').screenshot()).removeAlpha().raw().toBuffer();
        colored = 0;
        for (let i = 0; i < pixels.length; i += 3) if (pixels[i] > pixels[i + 1] * 1.25 && pixels[i + 1] > pixels[i + 2] * 1.25 && pixels[i] > 60) colored++;
        return colored;
      }, { message: 'the orange synthetic GLB must actually render' }).toBeGreaterThan(20);
      await page.getByRole('button', { name: '礼盒深色', exact: true }).click();
      await expect(page.locator('.mdl-preview.dark')).toBeVisible();
      await expect(page.locator('.mdl-preview-scene > div[aria-label="模型 3D 预览"]')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
      await page.getByRole('button', { name: '手机', exact: true }).click();
      await expect(page.locator('.mdl-preview.mobile')).toHaveCSS('height', '340px');
      await page.getByRole('button', { name: '前台', exact: true }).click();
      await expect(page.locator('.mdl-preview.light')).toBeVisible();
      await expect(page.locator('.mdl-preview-scene > div[aria-label="模型 3D 预览"]')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/admin/models/${ready.id}`);
      await page.getByLabel('排序', { exact: true }).fill('7'); await page.getByLabel('排序', { exact: true }).press('Tab'); expect((await patch).status()).toBe(200);
      await next.click();
      await page.getByRole('button', { name: '下一步：确认上架', exact: true }).click();
      await page.getByRole('button', { name: '上架', exact: true }).click();
      await expect(page.getByRole('button', { name: '确认上架', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await expect(page.getByRole('button', { name: '确认上架', exact: true })).toHaveCount(0);
      const savedModelResponse = await modelRequest('GET', `/api/admin/models/${ready.id}`);
      expect(savedModelResponse.status()).toBe(200);
      const savedModel = await savedModelResponse.json();
      expect(savedModel.published).toBe(false); expect(savedModel.sortOrder).toBe(7);
      await page.getByRole('button', { name: '上架', exact: true }).click();
      checks.push({ state: 'confirm', ...(await geometry(page)) });
      samples.push(await density(page, 'confirm'));
      await shot(page, testInfo, role, viewport.width, '04-confirm');
      const previous = await modelRequest('GET', `/api/admin/models?product=${encodeURIComponent(ready.productSlug)}&published=true`);
      expect(previous.status()).toBe(200);
      replacedIds = ((await previous.json()).items as Array<{ id: string }>).map((item) => item.id).filter((id) => id !== ready.id);
      const publish = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/admin/models/${ready.id}/publish` && r.request().method() === 'POST');
      publishedId = ready.id;
      await page.getByRole('button', { name: '确认上架', exact: true }).click(); const published = await publish; expect(published.status()).toBe(200);
      const publication = await published.json();
      const priorIds = [...replacedIds].sort();
      replacedIds = [...new Set([...replacedIds, ...(publication.replaced || [])])];
      expect([...(publication.replaced || [])].sort()).toEqual(priorIds);
      expect(publication.id).toBe(ready.id); expect(publication.published).toBe(true);
      await expect(page.getByText('模型已发布。', { exact: false })).toBeVisible();
      checks.push({ state: 'success', ...(await geometry(page)), renderedColoredPixels: colored });
      samples.push(await density(page, 'published'));
      await shot(page, testInfo, role, viewport.width, '05-published');
      await page.locator('.mdl-crumb a').focus(); await page.keyboard.press('Tab');
      const focusSample = await geometry(page); expect(focusSample.focus?.style).toBe('solid'); expect(focusSample.focus?.width).toBe('2px');
      expect(focusSample.focus?.color).toBe('rgb(180, 87, 0)');
      checks.push({ state: 'focus', ...focusSample });
      await shot(page, testInfo, role, viewport.width, '06-focus');
      expect(checks.map((sample) => sample.state)).toEqual(['empty/disabled', 'client-error', 'loading', 'error/blocked', 'confirm', 'success', 'focus']);
      for (const measured of checks) {
        expect(measured.accent).toBe('#b45700'); expect(measured.overflow).toBeLessThanOrEqual(1);
        const layout = measured.layout as { width: number; leftGap: number; gap: string };
        expect(layout.leftGap).toBeGreaterThanOrEqual(0); expect(layout.leftGap).toBeLessThanOrEqual(40);
        expect(layout.width).toBeLessThanOrEqual(1136); expect(layout.gap).toBe('16px');
        for (const item of measured.elements as Array<Record<string, unknown>>) {
          expect(item.borders).toEqual(['2px', '2px', '2px', '2px']);
          expect(item.borderColors).toEqual(['rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)']);
          expect(item.radii).toEqual(['0px', '0px', '0px', '0px']); expect(item.shadow).toBe('none'); expect(item.image).toBe('none'); expect(item.opacity).toBe('1');
          expect(['rgb(0, 0, 0)', 'rgb(255, 255, 255)', 'rgb(180, 87, 0)']).toContain(item.background);
          if (item.selector !== '.mdl-checkbox') expect(['rgb(0, 0, 0)', 'rgb(255, 255, 255)', 'rgb(180, 87, 0)']).toContain(item.color);
          if (item.disabled) {
            expect(item.borderStyles).toEqual(['dashed', 'dashed', 'dashed', 'dashed']);
            expect(item.background).toBe('rgb(255, 255, 255)'); expect(item.color).toBe('rgb(0, 0, 0)');
          }
          if (String(item.selector).includes('pj-button') || String(item.selector).includes('pj-input')) expect(item.height).toBeGreaterThanOrEqual(viewport.width < 1024 ? 44 : 36);
          if (String(item.selector).includes('pj-input')) expect(item.fontSize).toBe('16px');
          if (['.mdl-section', '.mdl-drop', '.mdl-alert', '.mdl-remedy'].includes(String(item.selector))) expect(item.padding).toEqual(['16px', '16px', '16px', '16px']);
        }
        for (const status of measured.statuses as Array<Record<string, unknown>>) {
          if (String(status.tone) === 'empty' || String(status.tone) === 'loading') {
            expect(status.align).toBe('left');
            expect(status.preview ? status.padding : status.regionPadding).toEqual(['16px', '16px', '16px', '16px']);
          }
        }
      }
      for (const sample of samples) expect((sample.verdict as { pass: boolean }).pass, `actual density ${sample.surface}`).toBe(true);
      await page.getByRole('link', { name: '取消', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/inquiries(?:\?|$)/);
      const cancelTarget = await page.request.get('/admin/inquiries');
      expect(cancelTarget.status()).toBe(role === 'EDITOR' ? 404 : 200);
      requests.push({ method: 'GET', path: '/admin/inquiries', status: cancelTarget.status() });
      errorStage = 'done';
    } catch (e) { errorName = e instanceof Error ? e.name : 'unknown'; throw e; }
    finally {
      const cleanupErrors: string[] = [];
      const path = testInfo.outputPath('admin-legacy-model.json');
      const report = { task: 'M3-T23', role, viewport, source: { commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null }, transport: 'standalone/real Auth.js/real model HTTP', requests, checks, checkbox: checkboxEvidence, density: samples, capture: 'synthetic GLB and poster, original Canvas decoding, no response/DOM/auth-storage injection', errorStage, error: errorName, cleanupErrors, cleanupPending: true, pass: false };
      writeFileSync(path, JSON.stringify(report, null, 2));
      // Restore the prior synthetic CI storefront through the real API. A cleanup failure is not a pass.
      if (publishedId) {
        try { expect((await modelRequest('POST', `/api/admin/models/${publishedId}/publish`, { published: false })).status()).toBe(200); }
        catch { cleanupErrors.push('unpublish'); }
        for (const id of replacedIds) {
          try { expect((await modelRequest('POST', `/api/admin/models/${id}/publish`, { published: true })).status()).toBe(200); }
          catch { cleanupErrors.push('restore-publication'); }
        }
      }
      try { await cdp.detach(); } catch { cleanupErrors.push('network-detach'); }
      report.cleanupPending = false;
      report.pass = errorStage === 'done' && errorName === null && cleanupErrors.length === 0;
      writeFileSync(path, JSON.stringify(report, null, 2));
      await testInfo.attach('admin-legacy-model', { path, contentType: 'application/json' });
      expect(cleanupErrors, 'synthetic publication cleanup must complete').toEqual([]);
    }
  });
});
