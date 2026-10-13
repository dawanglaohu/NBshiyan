import { get, set } from 'idb-keyval';

// 把 GLB 缓存进 IndexedDB，回访用户不用重新下载。
// key 带上文件版本（文件名哈希），模型更新后自动失效。
export async function cachedModelUrl(url: string): Promise<string> {
  const key = `glb:${url}`;
  try {
    const hit = await get<Blob>(key);
    if (hit) return URL.createObjectURL(hit);
    const res = await fetch(url);
    if (!res.ok) return url;
    const blob = await res.blob();
    set(key, blob).catch(() => {});
    return URL.createObjectURL(blob);
  } catch {
    return url; // 隐私模式等 IndexedDB 不可用时直接走网络
  }
}
// TODO: gltf-progressive 的高精度分级文件按相对路径加载，blob 地址会断开相对路径，
// 接入真实模型时改为缓存基础文件、分级文件走 CDN 长缓存（已在 next.config.ts 配置）。
