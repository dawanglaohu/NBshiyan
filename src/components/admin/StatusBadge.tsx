import { STATUS_LABEL, type InquiryStatus } from '@/lib/admin/types';
/** 11 节：黑白为基础 + 文字，不新增状态色板；保留原 `badge ${status}` 类供既有消费方与测试使用。 */
export default function StatusBadge({ status }: { status: InquiryStatus }) {
  return <span className={`badge ${status} inq-status-badge`} data-state="current" data-testid="status-badge">{STATUS_LABEL[status]}</span>;
}
