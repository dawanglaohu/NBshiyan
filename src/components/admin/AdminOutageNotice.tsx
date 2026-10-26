import type { OutageCopy } from '@/lib/admin/outage-copy';

/** 数据库不可用或服务出错时替换后台内容区。侧栏和顶栏仍由 AdminShell 渲染。重试是整页刷新。 */
export default function AdminOutageNotice({ copy, href, lang }: { copy: OutageCopy; href: string; lang: 'zh-CN' | 'en' | 'ru' }) {
  return (
    <div className="adm-empty adm-outage" role="alert" lang={lang}>
      <h1>{copy.title}</h1>
      <p>{copy.body}</p>
      <a className="adm-btn primary" href={href}>{copy.retry}</a>
    </div>
  );
}
