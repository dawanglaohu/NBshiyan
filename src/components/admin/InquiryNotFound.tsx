import Link from 'next/link';

/** 询盘不存在或无权查看：两种情况同一文案，不透露询盘是否存在；不显示错误码和 ID */
export default function InquiryNotFound() {
  return (
    <div className="adm-empty">
      <h1>询盘不存在</h1>
      <p className="muted">这条询盘可能已删除，或者你没有查看权限。</p>
      <Link href="/admin/inquiries" className="adm-btn">返回询盘列表</Link>
    </div>
  );
}
