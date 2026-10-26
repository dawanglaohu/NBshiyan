import LoginForm from '@/components/admin/auth/LoginForm';
import { loginPageLang } from '@/lib/admin/login-step';
import { adminCallbackPath } from '@/lib/admin/safe-callback';

export const dynamic = 'force-dynamic';

/** 地址栏里的 error/code 只决定要不要显示笼统错误，不能决定是否进入验证码步骤。 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string; code?: string }>;
}) {
  const params = await searchParams;
  const callbackUrl = adminCallbackPath(params.callbackUrl);
  const urlError = Boolean(params.error || params.code);
  const initialLang = await loginPageLang();
  return <LoginForm callbackUrl={callbackUrl} urlError={urlError} initialLang={initialLang} />;
}
