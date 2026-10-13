# 3D 原型模型生成

`generate.mjs` 用 gltf-transform 程序化生成瓦楞纸箱 / 礼盒 / 酒盒（含开箱动画 `Open`）。

```bash
npm i @gltf-transform/core@4 @gltf-transform/cli@4 pngjs   # 另需 KTX-Software (toktx) 4.x
node generate.mjs                     # -> out/*.glb, tex/*.png
for f in corrugated-box gift-box wine-box; do
  npx gltf-transform etc1s out/$f.glb tmp.glb --quality 160
  npx gltf-transform draco tmp.glb ../../public/models/$f.glb
done
```

解码器本地托管：Draco `public/draco/`，KTX2/Basis `public/basis/`（three r186 `examples/jsm/libs/basis`）。

## 渐进加载（gltf-progressive）

`progressive.mjs <src.glb> <outDir> <name>` 生成两份文件（都是 Draco + KTX2）：
`<name>.<hash>.glb` 轻量预览（64px 贴图、简化网格，首屏先加载）和 `<name>.<hash>.lod0.glb` 完整精度
（通过 `NEEDLE_progressive` 扩展由 gltf-progressive 后台替换）。文件名带内容哈希，可长缓存。
