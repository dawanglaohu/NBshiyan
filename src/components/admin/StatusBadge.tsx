import { STATUS_LABEL, type InquiryStatus } from '@/lib/admin/types';
export default function StatusBadge({ status }: { status: InquiryStatus }) {
  return <span className={`badge ${status}`}>{STATUS_LABEL[status]}</span>;
}
