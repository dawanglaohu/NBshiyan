import LoginForm from '@/components/admin/auth/LoginForm';
import { safeCallbackPath } from '@/lib/admin/safe-callback';

export const dynamic = 'force-dynamic';

/** 地址栏里的 error/code 只决定要不要显示笼统错误，不能决定是否进入验证码步骤。 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string; code?: string }>;
}) {
  const params = await searchParams;
  const callbackUrl = safeCallbackPath(params.callbackUrl);
  const urlError = Boolean(params.error || params.code);
  return <LoginForm callbackUrl={callbackUrl} urlError={urlError} />;
}
