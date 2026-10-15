import { Suspense } from 'react';
import InquiryList from '@/components/admin/InquiryList';
import { enforceAdminPage } from '@/lib/server/admin/page-access';
// 页面自己的服务端检查（客户端导航时 layout 不一定重新执行）：未登录→登录页，停用/角色不符→404
export const dynamic = 'force-dynamic';
export default async function Page() { await enforceAdminPage(['ADMIN', 'SALES'], '/admin/inquiries'); return <Suspense><InquiryList /></Suspense>; }
