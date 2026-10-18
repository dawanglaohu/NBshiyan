import EnrollWizard from '@/components/admin/enroll/EnrollWizard';

// 每次请求都不缓存（Cache-Control: no-store 另由 next.config 的后台头统一下发）
export const dynamic = 'force-dynamic';

export default function AdminEnrollPage() {
  return <EnrollWizard />;
}
