import { adminTime, fmtDate } from './format';

/** 后台统一时间（#291）：显示按 adminTime 规则，悬停 title 显示完整 YYYY/MM/DD HH:mm，dateTime 是 ISO 原值 */
export default function AdminTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  if (!iso) return null;
  return <time dateTime={iso} title={fmtDate(iso)} className={className}>{adminTime(iso)}</time>;
}
