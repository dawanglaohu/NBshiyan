/**
 * 每个 View 的灯光配置（纯数据，便于测试）。
 * 基础：暖色主光 + 冷色补光 + 弱环境光，深色礼盒/酒盒不再发黑（#31）。
 * 深色卡片（.theme-premium，背景 #1D1D22）额外加一盏轮廓光（#172 跟进）：
 * 从盒子后上方打向相机方向（相机在 +x +y +z），只照亮背向相机的面和边缘，
 * 盖子边沿和外轮廓从深色背景里分出来；正对相机的面基本照不到，不会被冲灰。
 * 浅色卡片灯光不变。
 */
export type DirLight = { position: [number, number, number]; intensity: number; color: string };
export type LightRig = { ambient: number; directional: DirLight[] };

const BASE: DirLight[] = [
  { position: [-2, 4, 3], intensity: 1.5, color: '#fff1e0' },
  { position: [3, 2, -2], intensity: 0.4, color: '#dce8ff' },
];
/** 轮廓光：与默认相机方向 [2.4, 1.6, 2.6] 大致相反，并抬高 */
export const RIM_LIGHT: DirLight = { position: [-2.2, 3.2, -3.4], intensity: 2.4, color: '#fff4e6' };

export function lightRig(dark: boolean): LightRig {
  return { ambient: 0.25, directional: dark ? [...BASE, RIM_LIGHT] : BASE };
}
