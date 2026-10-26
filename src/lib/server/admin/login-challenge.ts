import { CredentialsSignin } from 'next-auth';
import { TOTP_REQUIRED_CODE } from '../../admin/login-step';

/**
 * 密码已经正确、账号开了两步验证、这次又没带验证码。
 * authorize 对返回 null 一律抛普通 CredentialsSignin，前端无法区分。
 * 这个 code 只在密码正确之后抛出，不增加 failedLogins，也不写入审计失败。
 */
export function throwTotpRequired(): never {
  const error = new CredentialsSignin();
  error.code = TOTP_REQUIRED_CODE;
  throw error;
}
