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
