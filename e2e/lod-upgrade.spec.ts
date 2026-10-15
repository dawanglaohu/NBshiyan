import { test, expect } from './fixtures';

// 回归（3D LOD）：画布 frameloop="demand"，gltf-progressive 只在渲染过的帧之后检查 LOD，
// 完整贴图加载完如果没人 invalidate()，静置页面会一直停在 32px 预览贴图。
// 不做任何交互：3D 在首次交互或 4 秒 + 空闲后才启动（ProductGallery），这里只等待。
// 断言：请求了 *.lod0.glb，并且之后真的把 ≥512px 的贴图（预览贴图最多 32px，阴影/环境贴图 ≤256px）上传到了 GPU（说明 LOD 升级被渲染出来，而不只是下载了）。
// 无头 Chromium 用软件 WebGL。
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

test('静置的 /en/products 不交互也会升级到完整 LOD 贴图', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const w = window as unknown as { __lodTex: [number, number][] };
    w.__lodTex = [];
    for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
      const proto = C.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
      for (const f of ['texStorage2D', 'compressedTexImage2D'] as const) {
        const orig = proto[f];
        if (!orig) continue;
        proto[f] = function (this: unknown, ...a: unknown[]) {
          w.__lodTex.push([Number(f === 'texStorage2D' ? a[3] : a[3]), performance.now()]);
          return orig.apply(this, a);
        };
      }
    }
  });
  const lod0: string[] = [];
  page.on('requestfinished', (r) => { if (/\.lod0\.glb(\?|$)/.test(r.url())) lod0.push(r.url()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en/products');
  await expect.poll(() => lod0.some((u) => u.includes('/models/color-box.')), { timeout: 60_000, intervals: [1000] }).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const firstLod0 = Math.min(...performance.getEntriesByType('resource').filter((e) => e.name.includes('.lod0.glb')).map((e) => e.responseEnd));
    return (window as unknown as { __lodTex: [number, number][] }).__lodTex.filter(([w, t]) => w >= 512 && t > firstLod0).length;
  }), { timeout: 20_000, intervals: [1000] }).toBeGreaterThan(0);
});
