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
