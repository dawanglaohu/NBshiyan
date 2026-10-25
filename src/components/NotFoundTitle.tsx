'use client';

import { useLayoutEffect } from 'react';
import { useLocale } from 'next-intl';
import enMessages from '../../messages/en.json';
import ruMessages from '../../messages/ru.json';

// 新增语言时要同步这里。目前只有 ru 用俄文标题，其余 locale（取不到时也一样）回落英文。
export function notFoundDocumentTitle(locale: string): string {
  return locale === 'ru' ? ruMessages.NotFound.meta.title : enMessages.NotFound.meta.title;
}

/**
 * 水合会把 document.title 写成布局上的首页标题。绘制前写回 404 标题。
 * 只观察 document.head。观察 document.body 会被首页画布的持续变更打满。
 * 卸载时断开观察并停掉轮询，客户端导航离开本页后不再写标题。
 * 组件本身不输出 title 元素。原始 HTML 里的标题来自 not-found 页的 generateMetadata。
 */
export function NotFoundTitle({ locale }: { locale?: string }) {
  const routeLocale = useLocale();
  const title = notFoundDocumentTitle(locale ?? routeLocale);

  useLayoutEffect(() => {
    let stopped = false;
    const apply = () => {
      if (stopped) return;
      const nodes = document.querySelectorAll('title');
      for (const node of nodes) {
        if (node.textContent !== title) node.textContent = title;
      }
      if (document.title !== title) document.title = title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    let remaining = 25;
    const timer = window.setInterval(() => {
      apply();
      if (--remaining <= 0) window.clearInterval(timer);
    }, 200);
    return () => {
      stopped = true;
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [title]);

  return null;
}
