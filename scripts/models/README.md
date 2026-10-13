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
