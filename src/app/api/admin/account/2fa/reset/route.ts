import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { reauth } from '@/lib/server/admin/accounts';
import { enrollLinkBase } from '@/lib/server/admin/enroll-token';
import { recoverySetCookie } from '@/lib/server/admin/recovery-start';
import { classifySelfResetBody, SELF_REBIND_PAGE } from '@/lib/server/admin/self-rebind';
import { createAdminServices } from '@/lib/server/composition';
import { AppError, classifyThrown, mapAppError } from '@/lib/server/http/errors';

export const runtime = 'nodejs';

/**
 * 本人换验证器（10 节:20）：
 * - 主路径消费 TOTP_RESET actionGrant（M3-T3 签发，5 分钟、一次）；兼容旧的 currentPassword+totp；
 * - 恢复码在此入口拒绝（E-75），且不改任何绑定；
 * - 成功后不直接清 2FA，而是建 SELF_REAUTH 受限 session、设受限 cookie、返回 /admin-recovery 链接；
 *   原因素保留到受限 confirm 原子发布新绑定（M3-T5）。
 */
export async function POST(req: Request) {
  const requestId = randomUUID();
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES', 'EDITOR']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'account.2fa_reset', 5));
  if (blocked) return blocked;

  const json = await readJson(req, 2_000);
  if (json === TOO_LARGE) return jsonErr('too_large', 413);

  let mode;
  try {
    mode = classifySelfResetBody(json);
  } catch (error) {
    return failure(error, requestId);
  }

  // 站点地址不合格时在消费任何凭据之前拒绝（grant 不被烧掉）。
  const base = enrollLinkBase();
  if (!base) return jsonErr('site_url_invalid', 500);

  try {
    if (mode.mode === 'password') {
      const r = await reauth(ctx.user, mode.currentPassword, mode.totp, undefined, ctx.ip, 'account.2fa_reset');
      if (r !== 'ok') return jsonErr(r, r === 'locked' ? 423 : 401);
    }

    const services = createAdminServices();
    const result = await services.selfRebind.rebind(
      mode.mode === 'grant'
        ? { kind: 'grant', userId: ctx.user.id, sid: ctx.device.id, actionGrant: mode.actionGrant, ip: ctx.ip }
        : { kind: 'password', userId: ctx.user.id, sid: ctx.device.id, ip: ctx.ip },
    );

    const maxAge = Math.max(1, Math.floor((result.expiresAt.getTime() - Date.now()) / 1000));
    // 既有字段保持：ok / reenrollRequired / enrollLink；链接改指受限重绑页（cookie 已带受限会话）。
    const body = {
      ok: true,
      reenrollRequired: true,
      enrollLink: `${base}${SELF_REBIND_PAGE}`,
      expiresAt: result.expiresAt.toISOString(),
      expiresTruncated: false,
    };
    const response = NextResponse.json(body, { headers: noStore });
    response.headers.append('set-cookie', recoverySetCookie(result.token, maxAge));
    return response;
  } catch (error) {
    return failure(error, requestId);
  }
}

function failure(error: unknown, requestId: string): Response {
  if (error instanceof AppError) {
    const mapped = mapAppError(error, requestId);
    return NextResponse.json(mapped.body, { status: mapped.status, headers: mapped.headers });
  }
  const mapped = classifyThrown(error, requestId);
  if (mapped.kind === 'legacy-response') return mapped.response;
  if (mapped.kind === 'legacy-body') return jsonErr(mapped.body.error, 500);
  return NextResponse.json(mapped.body, { status: mapped.status, headers: mapped.headers });
}
