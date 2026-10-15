/**
 * #291：mock 数据层按需加载。返回一个代理对象，第一次调用方法时才 import() 真正的实现。
 * 调用方必须写在 `process.env.NEXT_PUBLIC_* === 'http' ? http : lazyApi(() => import('./mock'))` 这种三元里：
 * 构建时 NEXT_PUBLIC_* 被内联成常量，生产构建里 mock 分支是死代码，webpack 不会处理里面的 import()，
 * 所以生产包里既没有 mock 数据，也不会生成 mock chunk。接口的方法都返回 Promise，代理不改变调用方式。
 */
export function lazyApi<T extends object>(load: () => Promise<T>): T {
  let api: Promise<T> | undefined;
  return new Proxy({} as T, {
    get(_target, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined; // 不让代理被当成 thenable
      return (...args: unknown[]) =>
        (api ??= load()).then((impl) => (impl[key as keyof T] as (...a: unknown[]) => unknown).apply(impl, args));
    }
  });
}
