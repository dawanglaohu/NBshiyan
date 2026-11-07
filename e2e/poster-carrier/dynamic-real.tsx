import { createElement, useEffect, useState, type ComponentType } from 'react';

type Module = { default?: ComponentType<never> } | ComponentType<never>;

/**
 * next/dynamic 的浏览器端等价实现（M2-T6 组件测试载体）：
 * 真实调用 loader，等模块就绪后渲染真实组件；不返回空节点。
 * 只覆盖 default(() => import('./X'), { ssr: false }) 这一种调用形态。
 */
export default function dynamic(loader: () => Promise<Module>) {
  let cached: ComponentType<never> | null = null;
  let pending: Promise<void> | null = null;

  function Dynamic(props: Record<string, unknown>) {
    const [Comp, setComp] = useState<ComponentType<never> | null>(() => cached);
    useEffect(() => {
      let alive = true;
      if (!pending) {
        pending = loader().then((mod) => {
          const m = mod as { default?: ComponentType<never> };
          cached = m.default ?? (mod as ComponentType<never>);
        });
      }
      pending.then(() => {
        if (alive && cached) setComp(() => cached);
      });
      return () => { alive = false; };
    }, []);
    if (!Comp) return null;
    return createElement(Comp, props);
  }

  return Dynamic;
}
