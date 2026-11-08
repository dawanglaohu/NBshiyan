/**
 * WebGL 能力探测（M2-T6）：在挂载真实画布之前判断浏览器能否创建 WebGL 上下文。
 * 探测用一次性 canvas，拿到上下文后主动释放，避免占着浏览器有限的上下文名额。
 * 探测失败时页面直接走产品海报回退，不再挂载 R3F 画布；重试会重新探测。
 */
export function detectWebGLSupport(): boolean {
  if (typeof document === 'undefined') return true;
  const canvas = document.createElement('canvas');
  const attrs: WebGLContextAttributes = { failIfMajorPerformanceCaveat: false, antialias: false };
  try {
    const get = canvas.getContext.bind(canvas) as unknown as (type: string, a?: WebGLContextAttributes) => WebGLRenderingContext | null;
    const gl = get('webgl2', attrs) ?? get('webgl', attrs) ?? get('experimental-webgl', attrs);
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
