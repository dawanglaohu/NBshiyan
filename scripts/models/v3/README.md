# v3 盒型模型（Blender 4.2.3 LTS 建模）

瓦楞纸箱 / 礼盒（天地盖 + 内托）/ 酒盒（磁吸翻盖 + 酒瓶内托）在 Blender 中用 bpy 脚本建模：
倒角（Bevel）+ 加权法线、布尔开槽（内托凹槽、酒瓶托）、多材质 PBR（底色 / 法线 / 粗糙度金属度），
贴图全部自制（numpy 程序纹理 + 自绘 SVG 印刷/烫金，CC0 自有），未使用任何参考照片或网络图案。

```bash
# 1) 印刷 / 烫金贴图（sharp）
node decals.mjs tex/
# 2) Blender 建模 + 动画 + 导出（blender.org 官方 4.2.3 LTS 包）
for m in corrugated gift wine; do TEX_DIR=tex/ blender -b --python build_boxes.py -- $m out; done
# 3) 合并为单个 Open 动画片段；印刷/烫金材质改 MASK
for f in corrugated-box gift-box wine-box; do node merge-anim.mjs out/$f.glb out/$f.m.glb; done
# 4) Draco + KTX2 + 预览 LOD（预览贴图 32px，瓦楞芯在预览中压平；完整版保留真实楞纹）
for f in corrugated-box gift-box wine-box; do PREVIEW_TEX=32 PREVIEW_FLATTEN=Fluting node ../progressive.mjs out/$f.m.glb ../../../public/models $f.anim; done
```

## v3 review batch (Blender 4.2.3 LTS)
- `build_boxes.py` – `blender -b --python build_boxes.py -- <corrugated|gift|wine> <outdir>` (TEX_DIR defaults to ./tex, self-made textures)
- `render_studio.py` – Cycles studio renders/posters (HDRI Poly Haven studio_small_09, CC0)
- `merge-anim.mjs` → single `Open` clip; `progressive.mjs` → Draco+KTX2 lod0 + ≤30KB preview (`PREVIEW_TEX=16 PREVIEW_FLATTEN=Fluting`)
- `public/env/studio_small_09_256.hdr` – CC0 (Poly Haven), downsized for optional site use.

## #77 batch 1：礼品卡 / 胶印画册 / 三折页（Blender 4.2.3 LTS）
```bash
node decals-b1.mjs tex-b1/
for m in giftcard offset colorprint; do TEX_DIR=tex-b1/ blender -b --python build_print_b1.py -- $m out-b1; done
for f in gift-card offset-catalog color-printing; do PREVIEW_TEX=32 node ../progressive.mjs out-b1/$f.glb ../../../public/models $f; done
```
真实尺寸：CR80 卡 85.6×53.98×0.76mm R3.18 + 110×75 信封；精装 207×280 书芯、3mm 飘口、2.5mm 书板、圆脊；99×210 三折页 + A5 传单。品牌仅 PackJoyU。

## #77 batch 2：反插彩盒 / 圣诞纸罐 / 30 枚纸浆蛋托
```bash
node decals-b2.mjs tex-b2/
for m in color xmas pulp; do TEX_DIR=tex-b2/ blender -b --python build_b2.py -- $m out-b2; done
for f in color-box christmas-tube pulp-egg-tray; do PREVIEW_TEX=32 node ../progressive.mjs out-b2/$f.glb ../../../public/models $f; done
```
彩盒 80×40×160、0.45mm 白卡，顶盖开 115° 见插舌与防尘翼（仅 PackJoyU + CUSTOM PRINTED BOXES，无 NEW/成分表/条码）；纸罐 Ø100×160 + Ø102 盖（不印 MER… 文字）+ Ø70 挂球；蛋托 300×300、6×5 窝、1.6mm 壁厚。

## #77 batch 3：纸杯 / 牛皮纸杯 / 派对用品（+ 彩盒字标加粗）
```bash
node decals-b3.mjs tex-b3/ && cp tex-b3/colorbox_front.png tex-b3/colorbox_lid.png tex-b2/
for m in cup ecocup party; do TEX_DIR=tex-b3/ blender -b --python build_b3.py -- $m out-b3; done
TEX_DIR=tex-b2/ blender -b --python build_b2.py -- color out-b3
for f in paper-cup eco-paper-cup party-supplies color-box; do PREVIEW_TEX=32 node ../progressive.mjs out-b3/$f.glb ../../../public/models $f; done
```
字标统一 Inter Black + 同色描边。纸杯仅 navy PackJoyU（朝相机、≤60% 可见宽）；牛皮杯 #8e5f36，杯套上方一圈 PackJoyU，无环保声明。

## #252 颜色偏浅修复
- 印刷材质（`mat_print`）改为哑光：去掉 coat（KHR_materials_clearcoat）、粗糙度 +0.25、Specular IOR Level 0.25（可用 `PRINT_COAT_SCALE / PRINT_ROUGH_ADD / PRINT_SPEC` 覆盖复现旧版）。
- `render_studio.py` 灯光与 HDRI 统一乘 `LIGHT`（默认 0.6）；视图变换可用 `VIEW`/`LOOK` 覆盖。海报和对比图都用这一套。
- #252b：PackJoyU 藏青印刷输入色改为 `#020924`（目标渲染色 #1f2a44；在 LIGHT 0.6 + AgX 下按线性空间逐通道迭代求解，实测彩盒 ΔE76 7.0、纸杯 4.7）。可用 `NAVY_PRINT=#xxxxxx node decals-b3.mjs` 覆盖。牛皮纸未改（ΔE 8.5）。
## 预览 LOD 贴图 32px → 最高 128px
`sh pack-previews.sh <源 glb 目录>`：每个预览 GLB ≤ 30KB 前提下取最大尺寸——礼品卡 112、胶印画册 128、三折页 48、彩盒 80（倒角段数 2→1）、圣诞纸罐 112、蛋托 64、纸杯/牛皮纸杯/派对用品 128。
