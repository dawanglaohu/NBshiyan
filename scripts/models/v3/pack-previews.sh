#!/bin/sh
# #77 预览 LOD 贴图尺寸（PM：目标 128px；超过 30KB 的取能放下的最大尺寸，留 ~0.5KB 余量）
# 用法：sh pack-previews.sh <源 glb 目录>
SRC=$1
for p in gift-card:112 offset-catalog:128 color-printing:48 color-box:80 christmas-tube:112 pulp-egg-tray:64 paper-cup:128 eco-paper-cup:128 party-supplies:128; do
  f=${p%%:*}; t=${p##*:}
  PREVIEW_TEX=$t node ../progressive.mjs $SRC/$f.glb ../../../public/models $f
done
