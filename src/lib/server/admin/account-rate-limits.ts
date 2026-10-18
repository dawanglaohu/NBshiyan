import { clearRateLimits } from '../security';
import { LOGIN_WINDOW_MS, loginKeys } from './login';
import { ENROLL_CONFIRM_WINDOW_MS, enrollConfirmKey } from './enroll-guard';

/**
 * 只凭账号就能算出名字的限流 key（与 scripts/admin-reset-initial-password-lib.mjs 的 accountOnlyRateKeys 一致，测试逐一对比）：
 * - login-acct:<e>、login:untrusted:<e>（login.ts loginKeys，ip=null）
 * - enroll-confirm:untrusted:<e>（enroll-guard.ts enrollConfirmKey，ip=null）
 * 真实 IP 的 login:<ip>:<e>、enroll-confirm:<ip>:<e> 和所有 login-ip / enroll-ip 一律不在这里（不碰）。
 */
export function accountRateKeys(email: string) {
  const k = loginKeys(null, email);
  return [
    { key: k.acct, windowMs: LOGIN_WINDOW_MS },
    { key: k.ipAcct, windowMs: LOGIN_WINDOW_MS },
    { key: enrollConfirmKey(null, email), windowMs: ENROLL_CONFIRM_WINDOW_MS },
  ];
}

/**
 * 后台重置 2FA（解除锁定）提交之后调：删掉上面 3 个 key 的当前、上一个窗口（Upstash 一次 pipeline 6 个 DEL；内存直接删）。
 * 不 throw；失败不回滚重置，只返回 'failed'，由调用方记 rate_limit=failed。
 */
export const clearAccountRateLimits = (email: string) => clearRateLimits(accountRateKeys(email));
