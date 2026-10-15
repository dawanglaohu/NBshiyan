import { NextResponse } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import { assertSameOrigin, enforceAdminRateLimit } from './admin-guard';
import { jsonErr, type AdminCtx } from './admin/guard';
import { readJson, TOO_LARGE } from './admin/inquiries';
import { PrivacyExportBody, PrivacyDeleteBody, emailHash, exportCustomer, deleteCustomer, privacyHashReady } from './privacy';
import type { PrivateStorage } from './storage';
import type { audit as auditFn } from './admin/audit';

/**
 * 隐私导出/删除的处理逻辑。依赖（会话鉴权、数据库、审计、存储）由路由注入，方便用 HTTP Request 做集成测试。
 * 顺序：requireAdmin(['ADMIN']) → assertSameOrigin → 限流 → PRIVACY_HASH_SECRET 检查 → 读 body / 校验 → 执行 → 审计。
 */
export type PrivacyDeps = {
  requireAdmin: (req: Request, roles: ('ADMIN')[]) => Promise<AdminCtx | Response>;
  db: PrismaClient;
  audit: (e: Parameters<typeof auditFn>[0]) => Promise<unknown>;
  storage?: PrivateStorage;
};
const NO_STORE = { 'Cache-Control': 'no-store' };

async function guard(req: Request, deps: PrivacyDeps, key: string): Promise<AdminCtx | Response> {
  const ctx = await deps.requireAdmin(req, ['ADMIN']);
  if (ctx instanceof Response) return ctx;
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const limited = await enforceAdminRateLimit(req, key, 5);
  if (limited) return limited;
  if (!privacyHashReady()) return jsonErr('privacy_hash_secret_missing', 503);
  return ctx;
}

export async function handlePrivacyExport(req: Request, deps: PrivacyDeps) {
  const ctx = await guard(req, deps, 'privacy.export');
  if (ctx instanceof Response) return ctx;
  const raw = await readJson(req, 2_000);
  if (raw === TOO_LARGE) return jsonErr('too_large', 413);
  const p = PrivacyExportBody.safeParse(raw);
  if (!p.success) return jsonErr('invalid', 400);
  const data = await exportCustomer(deps.db, p.data.email);
  const hash = emailHash(p.data.email);
  await deps.audit({ actorId: ctx.user.id, action: 'privacy.export', target: hash, meta: { inquiries: data.inquiries.length, quoteLists: data.quoteLists.length, samples: data.samples.length }, ip: ctx.ip });
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="privacy-export-${hash.slice(0, 12)}.json"`,
      ...NO_STORE,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function handlePrivacyDelete(req: Request, deps: PrivacyDeps) {
  const ctx = await guard(req, deps, 'privacy.delete');
  if (ctx instanceof Response) return ctx;
  const raw = await readJson(req, 2_000);
  if (raw === TOO_LARGE) return jsonErr('too_large', 413);
  const p = PrivacyDeleteBody.safeParse(raw);
  if (!p.success) {
    const mismatch = p.error.issues.some((i) => i.message === 'confirm_mismatch');
    return NextResponse.json({ error: mismatch ? 'confirm_mismatch' : 'invalid' }, { status: 400, headers: NO_STORE });
  }
  const result = await deleteCustomer(deps.db, p.data.email, deps.storage);
  await deps.audit({ actorId: ctx.user.id, action: 'privacy.delete', target: emailHash(p.data.email), meta: result, ip: ctx.ip });
  return NextResponse.json({ ok: true, ...result }, { headers: NO_STORE });
}
