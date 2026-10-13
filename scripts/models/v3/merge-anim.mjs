// Blender 导出后处理：多个对象动画合并为单个 'Open' 片段；带 alpha 贴图的印刷/烫金材质改为 MASK
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const [src, dst] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src); const anims = doc.getRoot().listAnimations();
if (anims.length) { const open = anims[0]; open.setName('Open');
  for (const a of anims.slice(1)) { for (const s of a.listSamplers()) open.addSampler(s); for (const c of a.listChannels()) open.addChannel(c); a.dispose(); } }
for (const m of doc.getRoot().listMaterials()) if (m.getAlphaMode() === 'BLEND') m.setAlphaMode('MASK').setAlphaCutoff(0.5);
await io.write(dst, doc); console.log(src, '->', doc.getRoot().listAnimations().map(a => a.getName() + ':' + a.listChannels().length));
