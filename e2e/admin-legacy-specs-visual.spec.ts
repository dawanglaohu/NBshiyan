import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { authenticator } from 'otplib';
import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { categoryMeta } from '../src/lib/seo/categoryMeta';

// Incoterms 2020 固定清单，与产品 src/lib/admin/spec-form.ts 的 INCOTERMS 一致；
// 只用于逐项取消勾选 / 核对未勾，不在 e2e 里引入 @/ 别名依赖。
const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;

/**
 * M3-T24：规格列表 / 品类编辑器视觉迁移验收。
 * 真实 standalone 服务 + 真实 ADMIN/EDITOR/SALES 三种身份 + 真实 GET/PUT；
 * 不 route.fulfill、不改 DOM/CSS/React state、不写业务表造状态、不注入认证存储。
 * 本文件只读消费 SpecEditorView 渲染出的 DOM（View 不是写入范围）。
 *
 * 本文件自造 context 并显式设置 baseURL / locale / 外链拦截，不依赖 e2e/fixtures.ts
 * 的 auto fixture；纯负控用例不取 page/browser，可在无服务环境单独跑。
 */
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
const E2E_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CATEGORY = 'corrugated-boxes';
const EMPTY_CATEGORY = 'gift-boxes'; // 空数据 / 六态用例专用，避免改写 CATEGORY 的业务数据
const PROBE = `/api/admin/specs/${CATEGORY}`;
const PASSWORD = 'e2e-specs-Passw0rd!';
const PROBE_JS = readFileSync('docs/PackJoyU-开发文档/_run/density_probe.js', 'utf8');

const VIEWPORTS = [
  { width: 1920, height: 1080, label: '1920x1080' },
  { width: 1440, height: 900, label: '1440x900' },
  { width: 390, height: 844, label: '390x844' },
] as const;

type Role = 'ADMIN' | 'EDITOR' | 'SALES';
type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;
let STATES: Record<Role, StorageState> | null = null;

/** 真实隔离身份：create-admin.mjs 建指定角色 + 凭据登录一次，得到 storageState。
 *  每组只登录一次（beforeAll），用例从 storageState 复用，避免把 30 次/10min 登录桶打爆。 */
async function seedAndLogin(playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } }, role: Role, prefix: string): Promise<StorageState> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  execFileSync('node', ['scripts/create-admin.mjs'], {
    stdio: 'pipe',
    env: { ...process.env, ADMIN_SEED_EMAIL: email, ADMIN_SEED_PASSWORD: PASSWORD, ADMIN_SEED_NAME: `E2E ${role}`, ADMIN_SEED_ROLE: role, ADMIN_SEED_TOTP_SECRET: E2E_TOTP },
  });
  const req = await playwright.request.newContext({ baseURL: BASE });
  try {
    const csrf = (await (await req.get('/api/auth/csrf')).json()).csrfToken as string;
    const ok = await req.post('/api/auth/callback/credentials', {
      headers: { Origin: BASE }, form: { csrfToken: csrf, email, password: PASSWORD, totp: authenticator.generate(E2E_TOTP) }, maxRedirects: 0,
    });
    expect(ok.headers()['location'] ?? '').not.toContain('error');
    return await req.storageState();
  } finally { await req.dispose(); }
}

/** 每个用例独立 context/page：显式给 baseURL（相对 API 地址才能解析）、locale、
 *  外部请求拦截（规格页不加载 Turnstile，只需阻断外网）、可选 hasTouch/isMobile/recordVideo；
 *  不修改公共 fixture，失败也由调用方 finally 关闭。 */
async function openAs(browser: Browser, role: Role, opts?: { viewport?: { width: number; height: number }; hasTouch?: boolean; isMobile?: boolean; recordVideoDir?: string }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    storageState: STATES![role],
    baseURL: BASE,
    locale: 'en-US',
    viewport: opts?.viewport ?? { width: 1440, height: 900 },
    ...(opts?.hasTouch ? { hasTouch: true } : {}),
    ...(opts?.isMobile ? { isMobile: true } : {}),
    ...(opts?.recordVideoDir ? { recordVideo: { dir: opts.recordVideoDir, size: { width: 1280, height: 720 } } } : {}),
  });
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  const page = await context.newPage();
  return { context, page };
}

/** density_probe.js 的真实 verdict 判定：桌面 D1–D6 必须全 pass；
 *  手机按 probe 自己标明的适用项判（n/a 不计、pass 通过、fail 即失败），
 *  任何非 pass/fail/n/a 的字符串都不算通过；overflow 与 verdict.pass 同时核。 */
type DensityVerdict = Record<string, string | boolean>;
type DensityRaw = { verdict?: DensityVerdict; contentFound?: boolean; fill?: number; leftGap?: number; [k: string]: unknown };
function judgeDensity(d: DensityRaw | null, desktop: boolean): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!d || !d.verdict) return { ok: false, reasons: ['缺 verdict'] };
  const v = d.verdict;
  if (d.contentFound === false) reasons.push('contentFound=false');
  for (const k of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']) {
    const val = v[k];
    if (desktop) {
      if (val !== 'pass') reasons.push(`${k}=${String(val)}（桌面须 pass）`);
    } else if (val === 'fail') reasons.push(`${k}=fail`);
    else if (val === 'pass' || val === 'n/a') { /* probe 判定的适用 / 不适用 */ }
    else reasons.push(`${k}=${String(val)}（非 pass/fail/n/a）`);
  }
  if (v.overflow === 'fail') reasons.push('overflow=fail');
  else if (v.overflow !== 'pass') reasons.push(`overflow=${String(v.overflow)}`);
  if (v.pass !== true) reasons.push('verdict.pass!=true');
  return { ok: reasons.length === 0, reasons };
}

/** 密度验收函数本身：不通过即抛错。三尺寸用例调用它；纯负控用 toThrow 证明 fail 会明确失败。 */
function assertDensityPass(d: DensityRaw | null, desktop: boolean, label: string) {
  const j = judgeDensity(d, desktop);
  if (!j.ok) throw new Error(`${label} 密度未通过：${j.reasons.join('；')}`);
}

/** 报告只留几何/计数等安全字段，去掉 url 与 sparseBlocks 的页面文案，
 *  不含账号/邮箱/请求正文/异常堆栈/认证材料。 */
function safeDensity(r: DensityRaw) {
  const arr = (x: unknown, keys: string[]) => Array.isArray(x)
    ? x.map((o: Record<string, unknown>) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])))
    : [];
  return {
    verdict: r.verdict, contentFound: r.contentFound, fill: r.fill, leftGap: r.leftGap, rightGap: r.rightGap,
    avail: r.avail, interiorBand: r.interiorBand, overflowX: r.overflowX, mobile: r.mobile,
    contract: r.contract, viewport: r.viewport, main: r.main, rail: r.rail, counts: r.counts,
    offenders: {
      growth: arr(r.growth, ['path', 'cls', 'from', 'to']),
      emptyTracks: arr(r.emptyTracks, ['path', 'tracks', 'items', 'wasted']),
      gapOffenders: arr(r.gapOffenders, ['path', 'gap', 'limit']),
      padOffenders: arr(r.padOffenders, ['path', 'pad', 'limit']),
      sparseBlocks: arr(r.sparseBlocks, ['path', 'pad']),
    },
  };
}

/** 在真实页面里注入并执行项目既有 density_probe.js，返回其完整原始结果（含 verdict / metric / offenders）。 */
async function runDensity(page: Page, type: 'work' | 'form'): Promise<DensityRaw> {
  return page.evaluate(({ src, opts }) => {
    (0, eval)(src);
    const fn = (globalThis as { densityProbe?: (o: unknown) => DensityRaw }).densityProbe;
    if (!fn) throw new Error('densityProbe missing');
    return fn(opts);
  }, { src: PROBE_JS, opts: { type, density: 7, gutter: 16, gap: 16, pad: 16, main: 'main.adm-main' } });
}

type Border = { top: string; right: string; bottom: string; left: string; color: string };

/** 编辑表单页真实量测：四边 / 各角 / 背景 / 真实矩形 / 触控目标 / 表格字号 / 溢出 / DOM 计数。 */
async function measureForm(page: Page, touch: boolean) {
  return page.evaluate((touchCtx) => {
    const doc = document;
    const sec = doc.querySelector('.spec .spec-sec') as HTMLElement | null;
    const input = doc.querySelector('input[aria-label="material en"]') as HTMLElement | null;
    const textarea = doc.querySelector('textarea[aria-label="notes en"]') as HTMLElement | null;
    const btn = doc.querySelector('.spec .spec-actions .adm-btn.primary') as HTMLElement | null;
    const radioLabel = doc.querySelector('.spec .spec-radio label') as HTMLElement | null;
    const termLabel = doc.querySelector('.spec .spec-terms label') as HTMLElement | null;
    if (!sec || !input || !textarea || !btn) return null;
    const cs = (e: HTMLElement) => getComputedStyle(e);
    const rectOf = (e: HTMLElement) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 }; };
    const fourBorder = (e: HTMLElement) => { const s = cs(e); return { top: s.borderTopWidth, right: s.borderRightWidth, bottom: s.borderBottomWidth, left: s.borderLeftWidth, color: s.borderTopColor }; };
    const fourRadius = (e: HTMLElement) => { const s = cs(e); return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius]; };
    const fourPad = (e: HTMLElement) => { const s = cs(e); return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft]; };
    const si = cs(input), sb = cs(btn), ss = cs(sec), st = cs(textarea);
    const th = doc.querySelector('.spec .spec-sec th') as HTMLElement | null;
    return {
      sec: { border: fourBorder(sec), radius: fourRadius(sec), shadow: ss.boxShadow, image: ss.backgroundImage, pad: fourPad(sec) },
      input: { border: fourBorder(input), radius: fourRadius(input), shadow: si.boxShadow, image: si.backgroundImage, font: si.fontSize, rect: rectOf(input), pad: fourPad(input) },
      textarea: { border: fourBorder(textarea), radius: fourRadius(textarea), font: st.fontSize, rect: rectOf(textarea) },
      btn: { border: fourBorder(btn), radius: fourRadius(btn), shadow: sb.boxShadow, image: sb.backgroundImage, rect: rectOf(btn) },
      touchLabels: { radio: radioLabel ? rectOf(radioLabel) : null, term: termLabel ? rectOf(termLabel) : null },
      mediaMatches: {
        coarseOrPhone: matchMedia('(pointer:coarse),(max-width:767px)').matches,
        coarse: matchMedia('(pointer:coarse)').matches,
        phoneWidth: matchMedia('(max-width:767px)').matches,
      },
      touchCtx,
      tableLabelFont: th ? { size: cs(th).fontSize, line: cs(th).lineHeight } : null,
      overflowX: doc.documentElement.scrollWidth - doc.documentElement.clientWidth,
      domCounts: {
        inputs: doc.querySelectorAll('form.spec input').length,
        textareas: doc.querySelectorAll('form.spec textarea').length,
        selects: doc.querySelectorAll('form.spec select').length,
        buttons: doc.querySelectorAll('form.spec button').length,
      },
    };
  }, touch);
}

/** 列表页真实量测：ul 四边 / 各角 / 背景 + li 四边 padding / gap 实测对照。 */
async function measureList(page: Page) {
  return page.evaluate(() => {
    const ul = document.querySelector('ul.spec-list') as HTMLElement | null;
    if (!ul) return null;
    const s = getComputedStyle(ul);
    const li = ul.querySelector('li') as HTMLElement | null;
    const ls = li ? getComputedStyle(li) : null;
    return {
      border: { top: s.borderTopWidth, right: s.borderRightWidth, bottom: s.borderBottomWidth, left: s.borderLeftWidth, color: s.borderTopColor },
      radius: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius],
      shadow: s.boxShadow, image: s.backgroundImage,
      li: { pad: ls ? [ls.paddingTop, ls.paddingRight, ls.paddingBottom, ls.paddingLeft] : [], gap: ls ? ls.gap : '' },
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

type FormMeasure = NonNullable<Awaited<ReturnType<typeof measureForm>>>;
type ListMeasure = NonNullable<Awaited<ReturnType<typeof measureList>>>;

/** 真实 focus-visible：只用 Tab 键到达控件（不 .focus()），读 activeElement 的 computed outline。 */
async function tabTo(page: Page, ariaLabel: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label'));
    if (hit === ariaLabel) return page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return { tag: el.tagName, label: el.getAttribute('aria-label'), outlineWidth: s.outlineWidth, outlineOffset: s.outlineOffset, outlineColor: s.outlineColor };
    });
  }
  return null;
}

/** 8 字段 PUT 的合法载荷（任务卡指定数据），认证清空、贸易术语只 FOB。 */
const EXPECTED = {
  size: { min: { l: 10, w: 20, h: 30 }, max: { l: 40, w: 50, h: 60 }, unit: 'mm' },
  material: { en: 'Visual test EN', ru: 'Visual test RU' },
  moq: { value: 123, unit: 'pcs' },
  sampleFee: { free: true },
  leadTime: { min: 7, max: 14, unit: 'day' },
  certifications: null,
  tradeTerms: ['FOB'],
  notes: { en: 'note EN', ru: 'note RU' },
};
const EIGHT_KEYS = ['certifications', 'leadTime', 'material', 'moq', 'notes', 'sampleFee', 'size', 'tradeTerms'];

/** 纯负控（describe 外，不触发 beforeAll / 不取 browser/page）：证明 judgeDensity 不是「字段存在即通过」——
 *  D2 或 D5 = fail、且 verdict 所有值都是字符串、甚至 verdict.pass 被伪造成 true 时，验收函数必须判失败。
 *  本机可用仓库外最小 config 只跑这一条（不需 standalone 服务 / PostgreSQL）。 */
test('纯负控：D2/D5 为 fail 时实际验收函数必须抛错（不只判字段存在）', () => {
  const good: DensityRaw = { contentFound: true, verdict: { D1: 'pass', D2: 'pass', D3: 'pass', D4: 'pass', D5: 'pass', D6: 'pass', overflow: 'pass', pass: true } };
  // 正控：全 pass 的验收函数不抛错（确实调用过）
  expect(() => assertDensityPass(good, true, 'good')).not.toThrow();
  // D2 / D5 = fail：实际验收函数必须明确抛错
  expect(() => assertDensityPass({ contentFound: true, verdict: { ...good.verdict, D2: 'fail' } }, true, 'D2fail')).toThrow(/D2=fail/);
  expect(() => assertDensityPass({ contentFound: true, verdict: { ...good.verdict, D5: 'fail' } }, true, 'D5fail')).toThrow(/D5=fail/);
  // 旧实现只断言 typeof verdict[k] === 'string'：这里所有值仍是 string、pass 还被伪造成 true，仍必须抛错。
  const forged: DensityRaw = { contentFound: true, verdict: { ...good.verdict, D5: 'fail', pass: true } };
  for (const k of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']) expect(typeof forged.verdict![k]).toBe('string');
  expect(() => assertDensityPass(forged, true, 'forged')).toThrow(/D5=fail/);
  const mobileNa: DensityRaw = { contentFound: true, verdict: { D1: 'n/a', D2: 'n/a', D3: 'pass', D4: 'n/a', D5: 'n/a', D6: 'n/a', overflow: 'pass', pass: true } };
  expect(() => assertDensityPass(mobileNa, false, 'mobileNa')).not.toThrow();
  expect(() => assertDensityPass({ contentFound: true, verdict: { ...mobileNa.verdict, D3: 'fail', pass: false } }, false, 'mobileFail')).toThrow(/D3=fail/);
});

test.describe('规格列表与编辑器视觉迁移（真实会话）', () => {
  test.beforeAll(async ({ playwright }) => {
    STATES = {
      ADMIN: await seedAndLogin(playwright, 'ADMIN', 'e2e-specs-admin'),
      EDITOR: await seedAndLogin(playwright, 'EDITOR', 'e2e-specs-editor'),
      SALES: await seedAndLogin(playwright, 'SALES', 'e2e-specs-sales'),
    };
  });

  test('列表 SSR categoryMeta 每 key 恰一个链接；ADMIN/EDITOR 可达，SALES 两页 404 / GET/PUT 403', async ({ browser }) => {
    const admin = await openAs(browser, 'ADMIN');
    try {
      // 服务端 HTML 权威 key 集合：categoryMeta 全部 key 必须各有一个链接，且无多余 /admin/specs/ 链接
      const listResp = await admin.page.goto(`${BASE}/admin/specs`);
      expect(listResp, '列表页须有真实响应').not.toBeNull();
      const html = await listResp!.text();
      const keys = categoryMeta.map((c) => c.key);
      for (const key of keys) {
        const matches = html.match(new RegExp(`href="/admin/specs/${key}"`, 'g')) || [];
        expect(matches.length, `SSR 缺/多 category key ${key}`).toBe(1);
      }
      const allLinks = [...html.matchAll(/href="\/admin\/specs\/([^"/]+)"/g)].map((m) => m[1]);
      expect(allLinks.sort()).toEqual([...keys].sort());

      // EDITOR 真实身份可达列表与详情
      const editor = await openAs(browser, 'EDITOR');
      try {
        await editor.page.goto(`${BASE}/admin/specs`);
        await expect(editor.page.getByRole('heading', { level: 1, name: '产品规格' })).toBeVisible();
        await editor.page.goto(`${BASE}/admin/specs/${CATEGORY}`);
        await expect(editor.page.getByLabel('material en')).toBeVisible();
        const editorGet = await editor.page.request.get(PROBE);
        expect(editorGet.status()).toBe(200);
        expect((await editorGet.json()).category).toBe(CATEGORY);
        expect(editorGet.headers()['cache-control'] || '').toContain('no-store');
      } finally { await editor.context.close(); }

      // SALES 真实身份：两页 404、GET/PUT 规格接口 403
      const sales = await openAs(browser, 'SALES');
      try {
        const listResp = await sales.page.goto(`${BASE}/admin/specs`);
        const detailResp = await sales.page.goto(`${BASE}/admin/specs/${CATEGORY}`);
        // notFound()/enforceAdminPage 的拒绝以 404 呈现；不接受状态数组放水
        const listStatus = listResp ? listResp.status() : 0;
        const detailStatus = detailResp ? detailResp.status() : 0;
        expect([listStatus, detailStatus]).toEqual([404, 404]);
        expect((await sales.page.request.get(PROBE)).status()).toBe(403);
        expect((await sales.page.request.put(PROBE, { data: EXPECTED })).status()).toBe(403);
      } finally { await sales.context.close(); }

      // ADMIN 未知 category：页面 404 / GET 404 / PUT 404 error=not_found（不放宽状态数组）
      const unknownPage = await admin.page.goto(`${BASE}/admin/specs/not-a-category`);
      expect(unknownPage ? unknownPage.status() : 0).toBe(404);
      const unknownGet = await admin.page.request.get('/api/admin/specs/not-a-category');
      expect(unknownGet.status()).toBe(404);
      expect((await unknownGet.json()).error).toBe('not_found');
      const unknownPut = await admin.page.request.put('/api/admin/specs/not-a-category', { data: EXPECTED });
      expect(unknownPut.status()).toBe(404);
      expect((await unknownPut.json()).error).toBe('not_found');
    } finally { await admin.context.close(); }
  });

  test('一次 PUT 八键 → 捕获真实响应 → GET 持久一致 → 刷新全部字段 → moq=0 不发 PUT 且双界提示', async ({ browser }, testInfo) => {
    const admin = await openAs(browser, 'ADMIN');
    try {
      const page = admin.page;
      // 页面级 PUT 计数：只数页面自身发出的规格 PUT（page.request.put 的 APIRequestContext 调用不算）。
      let putCount = 0;
      page.on('request', (r) => {
        if (r.method() === 'PUT' && new URL(r.url()).pathname === PROBE) putCount += 1;
      });

      await page.goto(`${BASE}/admin/specs/${CATEGORY}`);
      await expect(page.getByLabel('material en')).toBeVisible();

      // 从实际控件显式设置全部指定数据；清空认证与其它贸易项（不假定 GET 后为空）
      await page.getByLabel('material en').fill(EXPECTED.material.en);
      await page.getByLabel('material ru').fill(EXPECTED.material.ru);
      await page.getByLabel('notes en').fill(EXPECTED.notes.en);
      await page.getByLabel('notes ru').fill(EXPECTED.notes.ru);
      for (const [k, vals] of [['min', [10, 20, 30]], ['max', [40, 50, 60]]] as const) {
        for (const [i, d] of ['l', 'w', 'h'].entries()) await page.getByLabel(`size ${k} ${d}`).fill(String(vals[i]));
      }
      await page.getByLabel('moq value').fill('123');
      await page.getByLabel('lead time min').fill('7');
      await page.getByLabel('lead time max').fill('14');
      await page.getByRole('radio', { name: '免费' }).check();
      await expect(page.getByLabel('size unit')).toHaveValue('mm');
      await expect(page.getByLabel('moq unit')).toHaveValue('pcs');
      await expect(page.getByLabel('lead time unit')).toHaveValue('day');
      for (const t of INCOTERMS) {
        const cb = page.getByRole('checkbox', { name: t, exact: true });
        if (await cb.isChecked()) await cb.uncheck();
      }
      await page.getByRole('checkbox', { name: 'FOB', exact: true }).check();
      let del = page.getByRole('button', { name: '删除' });
      while (await del.count() > 0) { await del.first().click(); del = page.getByRole('button', { name: '删除' }); }

      // 点击前建立唯一 waitForResponse：以本次 PUT 的真实 Request/Response 配对，
      // await 到 body 完成；不靠 async response 监听碰运气，也不把同路径任意 response 配上。
      const putPromise = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === PROBE,
        { timeout: 15_000 },
      );
      await page.getByRole('button', { name: '保存', exact: true }).click();
      const putResp = await putPromise;
      const putBody = putResp.request().postDataJSON() as Record<string, unknown>;
      const putJson = await putResp.json() as Record<string, unknown>;
      await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible({ timeout: 15_000 });
      expect(putCount, '点击唯一 submit 只发一次页面 PUT').toBe(1);
      expect(Object.keys(putBody).sort()).toEqual(EIGHT_KEYS);
      for (const k of EIGHT_KEYS) expect(putBody[k]).toEqual((EXPECTED as Record<string, unknown>)[k]);
      expect(putResp.status()).toBe(200);
      expect(putJson.category).toBe(CATEGORY);
      expect(typeof putJson.updatedAt).toBe('string');
      expect(Number.isNaN(Date.parse(putJson.updatedAt as string))).toBe(false);
      for (const k of EIGHT_KEYS) expect(putJson[k]).toEqual(putBody[k]);
      const got = await (await page.request.get(PROBE)).json();
      for (const k of EIGHT_KEYS) expect(got[k]).toEqual(putJson[k]);
      expect(got.updatedAt).toEqual(putJson.updatedAt);

      // 刷新：全部指定字段逐项保持，且单位、认证空、其它贸易项均未勾（不只看 FOB=true）
      await page.reload();
      await expect(page.getByLabel('material en')).toHaveValue(EXPECTED.material.en);
      await expect(page.getByLabel('material ru')).toHaveValue(EXPECTED.material.ru);
      await expect(page.getByLabel('notes en')).toHaveValue(EXPECTED.notes.en);
      await expect(page.getByLabel('notes ru')).toHaveValue(EXPECTED.notes.ru);
      for (const [k, vals] of [['min', [10, 20, 30]], ['max', [40, 50, 60]]] as const) {
        for (const [i, d] of ['l', 'w', 'h'].entries()) await expect(page.getByLabel(`size ${k} ${d}`)).toHaveValue(String(vals[i]));
      }
      await expect(page.getByLabel('size unit')).toHaveValue('mm');
      await expect(page.getByLabel('moq value')).toHaveValue('123');
      await expect(page.getByLabel('moq unit')).toHaveValue('pcs');
      await expect(page.getByLabel('lead time min')).toHaveValue('7');
      await expect(page.getByLabel('lead time max')).toHaveValue('14');
      await expect(page.getByLabel('lead time unit')).toHaveValue('day');
      await expect(page.getByRole('radio', { name: '免费' })).toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'FOB', exact: true })).toBeChecked();
      for (const t of INCOTERMS.filter((x) => x !== 'FOB')) {
        await expect(page.getByRole('checkbox', { name: t, exact: true }), `刷新后 ${t} 不应被勾选`).not.toBeChecked();
      }
      expect(await page.getByRole('button', { name: '删除' }).count(), '刷新后认证行为空').toBe(0);
      expect(await page.getByLabel('sample fee amount').count(), 'free 模式不渲染收费金额输入').toBe(0);

      // moq=0：任务卡明确「观察 1 秒 PUT 请求增加 0」；客户端校验拦截，不发 PUT（负向观察窗口）
      await page.getByLabel('moq value').fill('0');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForTimeout(1000);
      expect(putCount, 'moq=0 后 1 秒内不得新增页面 PUT').toBe(1);
      // moq=0 时产品同时渲染「请先修正标红的字段」顶部 alert 与 moq.value 字段 alert；
      // 定位真正含范围文案的那一条，不用 .first() 碰运气。
      const rangeAlert = page.getByRole('alert').filter({ hasText: '起订量范围' });
      await expect(rangeAlert, '须有 moq.value 字段级 role=alert 范围提示').toBeVisible();
      const alertText = await rangeAlert.first().innerText();
      // 独立数字边界：/1/ 会被 100000000 自带，改用既有明确范围文案 + 词边界独立下界 1
      expect(alertText, '错误语义不放宽：须是产品既有起订量范围文案').toMatch(/起订量范围\s*1–100000000/);
      expect(alertText, '下界 1 必须独立出现（不被 100000000 吞掉）').toMatch(/(?<![0-9])1(?![0-9])/);
      expect(alertText, '上界 100000000 必须出现').toMatch(/100000000/);
      await expect(page.getByLabel('material en')).toHaveValue(EXPECTED.material.en);
      await expect(page.getByLabel('moq value')).toHaveValue('0');
      // 服务端 400 invalid / issues 含 path=moq.value；GET 的 moq.value 仍 123（no-write）
      const badPut = await page.request.put(PROBE, { data: { ...putBody, moq: { value: 0, unit: 'pcs' } } });
      expect(badPut.status()).toBe(400);
      const badJson = await badPut.json();
      expect(badJson.error).toBe('invalid');
      expect(JSON.stringify(badJson.issues || [])).toContain('moq.value');
      expect((await (await page.request.get(PROBE)).json()).moq.value).toBe(123);

      const reportPath = testInfo.outputPath('admin-legacy-specs.json');
      writeFileSync(reportPath, JSON.stringify({
        suite: 'M3-T24 specs visual', putCountAfterSave: putCount, eightKeys: EIGHT_KEYS,
        putStatus: putResp.status(), getConsistent: true, moqZeroNoPut: putCount === 1,
        moqZeroBothBounds: true, serverNoWrite: true, refreshAllFields: true,
        certificationsEmpty: true, otherTermsUnchecked: true,
      }, null, 2));
      await testInfo.attach('admin-legacy-specs', { path: reportPath, contentType: 'application/json' });
    } finally { await admin.context.close(); }
  });

  test('三尺寸 computed style / 36或44真实矩形 / 实际 Tab 焦点 / density_probe 真判 D1–D6 与 overflow', async ({ browser }, testInfo) => {
    const results: Array<Record<string, unknown>> = [];
    let desktopVideo: { onDisk: boolean; bytes: number } | null = null;
    for (const view of VIEWPORTS) {
      // 手机档用真实触控配置（hasTouch + isMobile + 390 宽），桌面档明确非触控；
      // 两桌面档同数据对照由下面的 padding/gap 实测完成，不只靠 D1 类名扫描。
      const touch = view.width < 768;
      const videoDir = view.width === 1920 ? testInfo.outputPath('specs-video') : undefined;
      const admin = await openAs(browser, 'ADMIN', { viewport: { width: view.width, height: view.height }, hasTouch: touch, isMobile: touch, recordVideoDir: videoDir });
      const video = admin.page.video();
      try {
        const page = admin.page;
        // 列表 work：真实探针 + 列表页真实四边 / li padding/gap
        await page.goto(`${BASE}/admin/specs`);
        await expect(page.locator('ul.spec-list li a').first()).toBeVisible();
        const listDensity = await runDensity(page, 'work'), listM = await measureList(page);
        const pngList = testInfo.outputPath(`specs-${view.label}-list.png`);
        await page.screenshot({ path: pngList, fullPage: false });
        expect(existsSync(pngList), `列表帧 ${pngList} 须真实落盘，不能只有名字`).toBe(true);

        // 编辑 form：真实列表→点品类→保存→返回流程 + 真实探针 + 真实量测 + Tab 焦点
        await page.locator(`ul.spec-list li a[href="/admin/specs/${CATEGORY}"]`).click();
        await expect(page.getByLabel('material en')).toBeVisible();
        const formDensity = await runDensity(page, 'form'), formM = await measureForm(page, touch);
        const focus = await tabTo(page, 'material en');
        const pngForm = testInfo.outputPath(`specs-${view.label}-form.png`);
        await page.screenshot({ path: pngForm, fullPage: false });
        expect(existsSync(pngForm), `编辑帧 ${pngForm} 须真实落盘，不能只有名字`).toBe(true);
        // 真实保存：点击前配对 PUT，await 到响应完成，再点「全部品类」返回列表
        await page.getByLabel('moq value').fill('1');
        const savePromise = page.waitForResponse(
          (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === PROBE,
          { timeout: 15_000 },
        );
        await page.getByRole('button', { name: '保存', exact: true }).click();
        const saveResp = await savePromise;
        expect(saveResp.status(), '三尺寸流程里的真实保存须 200').toBe(200);
        await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible({ timeout: 15_000 });
        const pngSaved = testInfo.outputPath(`specs-${view.label}-saved.png`);
        await page.screenshot({ path: pngSaved, fullPage: false });
        expect(existsSync(pngSaved), `已保存帧 ${pngSaved} 须真实落盘`).toBe(true);
        await page.getByRole('link', { name: '← 全部品类' }).click();
        await expect(page.locator('ul.spec-list li a').first()).toBeVisible();
        const pngReturn = testInfo.outputPath(`specs-${view.label}-return.png`);
        await page.screenshot({ path: pngReturn, fullPage: false });
        expect(existsSync(pngReturn), `返回后列表帧 ${pngReturn} 须真实落盘`).toBe(true);

        results.push({
          viewport: view.label, touch,
          listDensity: safeDensity(listDensity), listMeasure: listM,
          formDensity: safeDensity(formDensity), formMeasure: formM, focus,
          png: {
            list: `specs-${view.label}-list.png`, form: `specs-${view.label}-form.png`,
            saved: `specs-${view.label}-saved.png`, return: `specs-${view.label}-return.png`, onDisk: true,
          },
          saveStatus: saveResp.status(),
        });
        await testInfo.attach(`specs-${view.label}-form`, { path: pngForm, contentType: 'image/png' });
        await testInfo.attach(`specs-${view.label}-list`, { path: pngList, contentType: 'image/png' });
        await testInfo.attach(`specs-${view.label}-saved`, { path: pngSaved, contentType: 'image/png' });
        await testInfo.attach(`specs-${view.label}-return`, { path: pngReturn, contentType: 'image/png' });

        // 四边黑边 / 各角 0 / 无阴影 / 无背景图 / 无横向溢出（ul / section / input / btn / textarea 全测）
        const expectFour = (b: Border, label: string) => {
          expect([b.top, b.right, b.bottom, b.left], `${label} 四边均须 2px`).toEqual(['2px', '2px', '2px', '2px']);
          expect(b.color, `${label} 边框须纯黑`).toBe('rgb(0, 0, 0)');
        };
        const expectZeroRadius = (r: string[], label: string) => { for (const x of r) expect(x, `${label} 各角须 0px`).toBe('0px'); };
        expect(listM, '列表页量测须取到 ul').not.toBeNull();
        expect(formM, '编辑页量测须取到表单控件').not.toBeNull();
        const lm = listM!, fm = formM!;
        expectFour(lm.border, '列表 ul'); expectZeroRadius(lm.radius, '列表 ul');
        expect(lm.shadow, '列表无阴影').toBe('none');
        expect(lm.image, '列表无背景图').toBe('none');
        expectFour(fm.sec.border, 'spec-sec'); expectZeroRadius(fm.sec.radius, 'spec-sec');
        expect(fm.sec.shadow, 'spec-sec 无阴影').toBe('none');
        expect(fm.sec.image, 'spec-sec 无背景图').toBe('none');
        expectFour(fm.input.border, 'material en 输入'); expectZeroRadius(fm.input.radius, 'material en 输入');
        expect(fm.input.font, '单行输入 16px').toBe('16px');
        expect(fm.input.shadow, '输入无阴影').toBe('none');
        expect(fm.input.image, '输入无背景图').toBe('none');
        expectFour(fm.btn.border, '保存按钮'); expectZeroRadius(fm.btn.radius, '保存按钮');
        expect(fm.btn.shadow, '按钮无阴影').toBe('none');
        expect(fm.btn.image, '按钮无背景图').toBe('none');
        expectFour(fm.textarea.border, 'notes textarea'); expectZeroRadius(fm.textarea.radius, 'notes textarea');
        expect(fm.overflowX, `${view.label} 无横向溢出`).toBeLessThanOrEqual(1);
        expect(lm.overflowX, `${view.label} 列表无横向溢出`).toBeLessThanOrEqual(1);
        expect(fm.tableLabelFont!.size, '表格标签 14px').toBe('14px');
        expect(fm.tableLabelFont!.line, '表格标签行高 20px').toBe('20px');

        // 真实矩形：桌面 36px、触控 ≥44×44；触控 context 真实配置；radio/checkbox label ≥44×44
        const targetH = touch ? 44 : 36;
        expect(fm.mediaMatches.coarseOrPhone, `${view.label} 触控 media 命中应与 context 一致`).toBe(touch);
        expect(fm.input.rect.h, `${view.label} 单行输入真实高`).toBeGreaterThanOrEqual(targetH);
        expect(fm.btn.rect.h, `${view.label} 保存按钮真实高`).toBeGreaterThanOrEqual(targetH);
        if (touch) {
          expect(fm.btn.rect.w, '触控保存按钮真实宽 ≥44').toBeGreaterThanOrEqual(44);
          expect(fm.touchLabels.radio!.h, 'radio label 高 ≥44').toBeGreaterThanOrEqual(44);
          expect(fm.touchLabels.radio!.w, 'radio label 宽 ≥44').toBeGreaterThanOrEqual(44);
          expect(fm.touchLabels.term!.h, 'checkbox label 高 ≥44').toBeGreaterThanOrEqual(44);
          expect(fm.touchLabels.term!.w, 'checkbox label 宽 ≥44').toBeGreaterThanOrEqual(44);
        }
        expect(fm.textarea.rect.h, 'textarea 至少 3 行高，不套单行 36px').toBeGreaterThanOrEqual(72);

        // 真实 Tab 焦点：activeElement 就是该 input，focus-visible outline 2px/2px/#b45700
        expect(focus, `${view.label} material en 须真实 Tab 可达`).not.toBeNull();
        expect(focus!.label).toBe('material en');
        expect(focus!.outlineWidth, 'focus-visible outline 2px').toBe('2px');
        expect(focus!.outlineOffset, 'focus-visible offset 2px').toBe('2px');
        expect(focus!.outlineColor, 'focus-visible 色 rgb(180,87,0)').toBe('rgb(180, 87, 0)');

        // density_probe 真判：桌面 work/form 的 D1–D6 全 pass + overflow pass + verdict.pass true；
        // 手机按 probe 适用项（n/a 不计、fail 即失败）。保留原始 metric 在报告里，不只一布尔。
        // 调用与纯负控同一个 assertDensityPass（失败即抛错），不是只判字段存在。
        const desktop = !touch;
        for (const [name, d, fmPad] of [['work', listDensity, null], ['form', formDensity, fm]] as const) {
          assertDensityPass(d, desktop, `${view.label} ${name}`);
          expect(d.contentFound, `${view.label} ${name} 主区域须有可见内容`).toBe(true);
          expect((d.verdict as DensityVerdict).pass, `${view.label} ${name} verdict.pass`).toBe(true);
          if (desktop) {
            if (name === 'work') expect(d.fill!, 'work fill≥0.85').toBeGreaterThanOrEqual(0.85);
            else expect(d.fill!, 'form fill≥0.55').toBeGreaterThanOrEqual(0.55);
            expect(d.leftGap!, '左边缘≤gutter+24').toBeLessThanOrEqual(16 + 24);
            if (fmPad) expect(fmPad.sec.pad.every((p) => parseFloat(p) <= 20), 'card pad≤20px').toBe(true);
            expect(lm.li.gap, '手写 li gap 实值（px）').toMatch(/^\d+(\.\d+)?px$/);
          }
        }
      } finally {
        await admin.context.close();
        if (video) {
          // video.path() 只在 context 关闭后才指向已落盘文件；真实断言它存在且非空，
          // 不只记名字。与 PNG 帧同样走 existsSync + 实际字节数。
          const vp = await video.path().catch(() => null);
          expect(vp, 'desktop 流程 video 须有真实路径').not.toBeNull();
          expect(existsSync(vp!), 'desktop 流程 video 须真实落盘，不能只有名字').toBe(true);
          const bytes = statSync(vp!).size;
          expect(bytes, 'desktop 流程 video 不得为空文件').toBeGreaterThan(0);
          desktopVideo = { onDisk: true, bytes };
          await testInfo.attach('specs-flow-video', { path: vp!, contentType: 'video/webm' });
        }
      }
    }
    // 两桌面档 1920/1440 同数据：四边 padding / gap 实测对照（不是类名 D1 扫描冒充全部手写 CSS）
    const a = results[0] as unknown as { listMeasure: ListMeasure; formMeasure: FormMeasure };
    const b = results[1] as unknown as { listMeasure: ListMeasure; formMeasure: FormMeasure };
    expect(a.formMeasure.sec.pad, '1920/1440 卡片四边 padding 相等').toEqual(b.formMeasure.sec.pad);
    expect(a.formMeasure.input.pad, '1920/1440 输入四边 padding 相等').toEqual(b.formMeasure.input.pad);
    expect(a.listMeasure.li.pad, '1920/1440 列表 li 四边 padding 相等').toEqual(b.listMeasure.li.pad);
    expect(a.listMeasure.li.gap, '1920/1440 列表 li gap 相等').toEqual(b.listMeasure.li.gap);

    const reportPath = testInfo.outputPath('admin-legacy-specs-visual.json');
    expect(desktopVideo, 'desktop 流程 video 落盘断言须在本用例内真实执行').not.toBeNull();
    writeFileSync(reportPath, JSON.stringify({
      suite: 'M3-T24 specs visual', viewports: VIEWPORTS.map((v) => v.label), results,
      desktopPaddingGapEqual: true, desktopVideo,
      implemented: '本用例已在文件内实现 36/44 真实矩形、四边/各角/背景图、Tab 焦点、D1–D6 真判、两桌面 padding/gap 实测对照、三尺寸「列表→点品类→保存→返回」四帧 PNG（list/form/saved/return，existsSync 断言）与 desktop 流程 video（existsSync + 非空字节断言）的采集与断言代码。这些产物只在正常 CI 同 run 真实服务里才落盘，采集代码已实现不等于产物已存在；真值由 CI 真跑，本机不冒充已验。',
      notHere: '六态与 DOM 前后同数据相等在相邻用例；完整 GIF 须由同 run 实际帧按 record-browser-gif 合成/标注来源，已写 PNG 采集代码不等于 GIF 产物存在，不额外人工视觉验收。',
    }, null, 2));
    await testInfo.attach('admin-legacy-specs-visual', { path: reportPath, contentType: 'application/json' });
  });

  test('六态 loading/empty/error/success/disabled/focus 真实断言 + DOM 前后同数据相等（同 fixture 非空分支）', async ({ browser }, testInfo) => {
    const admin = await openAs(browser, 'ADMIN');
    try {
      const page = admin.page;
      const states: Record<string, unknown> = {};

      // loading：SpecEditor 是客户端组件但参与 SSR，初始 useState(true) 渲染「加载中…」。
      // 直接读真实文档响应正文做确定性断言（不受 GET 返回快慢影响），再核 hydration 后表单渲染、loading 不残留。
      // 不造 DOM / 不改响应 / 不 .focus() 冒充。
      const loadingResp = await page.goto(`${BASE}/admin/specs/${EMPTY_CATEGORY}`);
      expect(loadingResp, '品类详情页须有真实文档响应').not.toBeNull();
      const ssrHtml = await loadingResp!.text();
      expect(ssrHtml, 'SSR 初始渲染须真实包含 loading 态「加载中…」').toContain('加载中…');
      await expect(page.getByLabel('material en'), 'GET 完成后表单渲染').toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('加载中…'), 'loading 态结束后不残留').toHaveCount(0);
      // 证据分类：SSR 响应正文命中是服务端文本证据，不是浏览器运行时「observed」态；
      // 运行时瞬时 loading 帧未单独采集，不写 observed / 不冒充浏览器实测态。
      states.loading = {
        evidence: 'ssrTextHit + browserHydrationGone',
        ssrTextHit: true,              // 服务端文档响应正文命中「加载中…」
        browserRuntimeObserved: null,  // 未做浏览器运行时瞬时帧采集
        hydrationGone: true,           // 浏览器里 hydration 后文案消失（真实断言）
      };

      // 以产品真实表单把该品类清到空（不直插 DB、不 route.fulfill、不改响应）：
      // 跨 CI 运行若库里残留数据，empty 态也必须确定性成立，且不碰 CATEGORY 的业务数据。
      await page.getByLabel('material en').fill('');
      await page.getByLabel('material ru').fill('');
      await page.getByLabel('notes en').fill('');
      await page.getByLabel('notes ru').fill('');
      for (const k of ['min', 'max']) for (const d of ['l', 'w', 'h']) await page.getByLabel(`size ${k} ${d}`).fill('');
      await page.getByLabel('moq value').fill('');
      await page.getByLabel('lead time min').fill('');
      await page.getByLabel('lead time max').fill('');
      await page.getByRole('radio', { name: '不填' }).check();
      for (const t of INCOTERMS) { const cb = page.getByRole('checkbox', { name: t, exact: true }); if (await cb.isChecked()) await cb.uncheck(); }
      let preDel = page.getByRole('button', { name: '删除' });
      while (await preDel.count() > 0) { await preDel.first().click(); preDel = page.getByRole('button', { name: '删除' }); }
      const clearPromise = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/admin/specs/${EMPTY_CATEGORY}`,
        { timeout: 15_000 },
      );
      await page.getByRole('button', { name: '保存', exact: true }).click();
      expect((await clearPromise).status(), '清空保存须真实 200').toBe(200);
      await page.reload();
      await expect(page.getByLabel('material en'), '刷新后 empty 态确定性成立').toBeVisible({ timeout: 15_000 });

      // empty：空数据品类的表单字段均为空、认证为空、贸易项全未勾、默认 feeMode=none
      await expect(page.getByLabel('material en')).toHaveValue('');
      await expect(page.getByLabel('notes en')).toHaveValue('');
      expect(await page.getByRole('button', { name: '删除' }).count(), 'empty 态认证行 0').toBe(0);
      for (const t of INCOTERMS) await expect(page.getByRole('checkbox', { name: t, exact: true })).not.toBeChecked();
      await expect(page.getByRole('radio', { name: '不填' })).toBeChecked();
      const emptyDom = await page.evaluate(() => ({
        inputs: document.querySelectorAll('form.spec input').length,
        textareas: document.querySelectorAll('form.spec textarea').length,
        selects: document.querySelectorAll('form.spec select').length,
        buttons: document.querySelectorAll('form.spec button').length,
        labels: [...document.querySelectorAll('form.spec [aria-label]')].map((e) => e.getAttribute('aria-label')).sort(),
      }));
      // 25 = 2 material + 6 六尺寸 + 1 MOQ + 2 交期 + 3 样品费 radio + 11 Incoterms checkbox；
      // 2 notes 是 textarea（不是 input）。paid 分支的 sample fee amount / currency 在 none 态不渲染。
      expect(emptyDom.inputs, 'empty fixture input 数 = 2+6+1+2+3+11').toBe(25);
      expect(emptyDom.textareas, 'empty fixture textarea 数 = 2 notes').toBe(2);
      expect(emptyDom.selects, 'empty fixture select 数 = 3 单位').toBe(3);
      expect(emptyDom.buttons, 'empty fixture button 数 = 添加认证 + 保存').toBe(2);

      // 迁移前后同 fixture 的 DOM 数量相等：迁移只改 CSS，不改 View。
      // 用 git 对象读迁移前 View 源码（不 checkout、不碰他人树），与工作树 View 逐字比对，
      // 证明结构零改动；再以相同 empty fixture 渲染后的 DOM 计数作为结构不删减的实值。
      const HEAD = process.env.M3T24_BASE_SHA ?? 'HEAD';
      let preSrc: string;
      try {
        preSrc = execFileSync('git', ['show', `${HEAD}:src/components/admin/specs/SpecEditorView.tsx`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { throw new Error(`读取迁移前 View 失败（${HEAD}）：${String(e)}`); }
      const curSrc = readFileSync('src/components/admin/specs/SpecEditorView.tsx', 'utf8');
      expect(curSrc, 'M3-T24 不改 View：迁移前后源码逐字相同 → 同 fixture 下 DOM 结构不删减').toBe(preSrc);
      states.dom = { preViewBytes: preSrc.length, viewUnchanged: true, currentEmptyDom: emptyDom };

      // paid 分支 + 认证非空：展开条件分支后 DOM 数量随分支增加（不删字段/动作）
      await page.getByRole('radio', { name: '收费' }).check();
      await expect(page.getByLabel('sample fee amount'), 'paid 分支渲染收费金额输入').toBeVisible();
      await expect(page.getByLabel('sample fee currency'), 'paid 分支渲染币种 select').toBeVisible();
      await page.getByRole('button', { name: '+ 添加认证' }).click();
      await expect(page.getByLabel('certification 1 name'), '认证非空分支渲染一行').toBeVisible();
      const expanded = await page.evaluate(() => ({
        inputs: document.querySelectorAll('form.spec input').length,
        selects: document.querySelectorAll('form.spec select').length,
        buttons: document.querySelectorAll('form.spec button').length,
      }));
      expect(expanded.inputs, 'paid(+1 金额 input) + 1 认证行(+3 input) = 29').toBe(29);
      expect(expanded.selects, 'paid 分支多一个币种 select = 4').toBe(4);
      expect(expanded.buttons, '认证行多一个删除按钮 = 3').toBe(3);
      states.expandedDom = expanded;

      // 复位到合法空表单，便于 error/disabled/success 的真实触发
      await page.getByRole('button', { name: '删除' }).first().click();
      await page.getByRole('radio', { name: '不填' }).check();
      await page.getByLabel('moq value').fill('');

      // error：moq=0 客户端校验，role=alert 范围文案 + 输入值仍保留（不放宽错误语义）
      await page.getByLabel('moq value').fill('0');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: '起订量范围' }), 'error 态字段级 alert').toBeVisible();
      await expect(page.getByLabel('moq value')).toHaveValue('0');
      states.error = { moqRangeAlert: true, typedValueKept: true };

      // disabled / success：真实保存（moq=5 其余空，body 合法）触发 saving 态与「已保存」
      const viewSrc = readFileSync('src/components/admin/specs/SpecEditorView.tsx', 'utf8');
      expect(viewSrc, 'saving 时 submit 按钮须 disabled 且文案切「保存中…」（源码绑定证据）').toMatch(/disabled=\{saving\}/);
      expect(viewSrc).toMatch(/saving \? '保存中…' : '保存'/);
      await page.getByLabel('moq value').fill('5');
      const savePromise = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/admin/specs/${EMPTY_CATEGORY}`,
        { timeout: 15_000 },
      );
      await page.getByRole('button', { name: '保存', exact: true }).click();
      // saving 态很短，best-effort 观察并如实记录；disabled 绑定由上面的源码断言确定性覆盖。
      const busyVisible = await page.getByRole('button', { name: '保存中…' }).isVisible().catch(() => false);
      const busyDisabled = busyVisible ? await page.getByRole('button', { name: '保存中…' }).isDisabled() : null;
      const saveResp = await savePromise;
      expect(saveResp.status(), '保存请求须真实返回 200').toBe(200);
      // 证据分类：disabled 绑定是源码静态证据；busy 是浏览器运行时 best-effort 观察。
      // busyObserved=false / busyDisabled=null 不得与「六态全部通过」混写，按真实值如实记录。
      states.disabled = {
        evidence: 'sourceBinding + bestEffortRuntimeObservation',
        disabledBindingInSource: true,   // 源码 disabled={saving} + 文案切换，确定性断言
        busyObserved: busyVisible,       // 浏览器运行时是否真看到「保存中…」，可能为 false
        busyDisabled: busyDisabled,     // 仅在 busyObserved=true 时有值，否则 null
        runtimeConfirmed: busyVisible ? busyDisabled === true : null, // 未观察到即 null，不写 true
      };
      await expect(page.getByRole('status').filter({ hasText: '已保存' }), 'success 态「已保存」可见').toBeVisible({ timeout: 15_000 });
      states.success = { evidence: 'browserVisibleStatus + realPut', statusVisible: true, putStatus: saveResp.status() };

      // focus：Tab 到 material en，activeElement 就是它，focus-visible outline 实值
      const focus = await tabTo(page, 'material en');
      expect(focus, 'focus 态须真实 Tab 可达').not.toBeNull();
      expect(focus!.label).toBe('material en');
      expect(focus!.outlineWidth).toBe('2px');
      expect(focus!.outlineOffset).toBe('2px');
      expect(focus!.outlineColor).toBe('rgb(180, 87, 0)');
      states.focus = focus;

      const reportPath = testInfo.outputPath('admin-legacy-specs-states.json');
      writeFileSync(reportPath, JSON.stringify({
        suite: 'M3-T24 specs states', states,
        note: '逐态按证据类型分开记录：ssrTextHit 是服务端文本命中，browserRuntimeObserved 为 null 表示未做运行时瞬时帧采集；disabled 的源码静态绑定与 best-effort busy 观察分开，busyObserved=false 不写成已观测/六态全通过。',
      }, null, 2));
      await testInfo.attach('admin-legacy-specs-states', { path: reportPath, contentType: 'application/json' });
    } finally { await admin.context.close(); }
  });
});
