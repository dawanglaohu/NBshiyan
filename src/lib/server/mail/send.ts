import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { escapeHtml, randomId } from '../security';
import { findInquiryForReply } from '../privacy';
import { extendInquiryRetention } from '../admin/inquiries';
import { capWindow, dailyCap, MAX_RETRIES, parseMailbox, smtpConfig, type SmtpConfig } from './config';
import { headerInjection, mailLog, type MailSendAdapter, type OutboundMail, type SendOutcome, type SendFailReason } from './adapter';

/**
 * #74 发信状态机（和发信商无关；适配器见 adapter.ts）。
 * 收件人只从库里取：先按管理员权限范围找到询盘，再用 findInquiryForReply（拒绝已匿名化询盘）确认，最后读该询盘联系人的邮箱。
 * 请求体里没有 to 字段，客户端永远不能指定收件人。
 *
 * §17 每日上限（MAIL_DAILY_CAP）按「发信日内占用名额的信」计数，而不是按请求次数累加：
 * 一条 MailMessage 最多占一个名额（capDay = 当天窗口起点）；占名额的是 SENDING / SENT 以及 unknown_delivery（可能已送达）的信。
 * 同一条信重试不会重复计数（同一行），失败后再重试必须重新走同一个名额检查，所以也绕不过上限。
 * 名额检查和占用在同一个事务里、先拿 pg_advisory_xact_lock，并发请求不会一起越过上限。
 */
export type MailDb = Pick<PrismaClient, 'inquiry' | 'mailMessage' | '$transaction'>;
type Tx = Prisma.TransactionClient;
type Env = Record<string, string | undefined>;

export type AlertFn = (kind: string, lines: Record<string, string | number>, dedupeKey: string) => Promise<void>;
export type AuditFn = (e: { actorId?: string | null; action: string; target?: string | null; meta?: Prisma.InputJsonValue; ip?: string | null }) => Promise<void>;

export type SendDeps = {
  db: MailDb;
  adapter: MailSendAdapter;
  env?: Env;
  now?: () => Date;
  alert?: AlertFn;
  audit?: AuditFn;
};

const CAP_LOCK_KEY = 740_017; // pg_advisory_xact_lock 的固定键：只用于每日发信名额
const LEASE_MS = 60_000;
const IDEM_WINDOW_MS = 10 * 60_000;

export type MailRow = {
  id: string; status: 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'RECEIVED' | 'UNASSIGNED' | 'IGNORED'; inquiryId: string | null;
  messageId: string | null; sendKey: string | null; inReplyTo: string | null; references: string | null;
  toAddr: string; subject: string; bodyHtml: string; bodyText: string;
  errorCode: string | null; retryable: boolean; retryCount: number; deliveryStatus: 'UNKNOWN' | 'BOUNCED';
  sentAt: Date | null; deferredUntil: Date | null; createdAt: Date; lockedUntil: Date | null; capDay: Date | null;
};

/** 8.3a 单条状态（含 §17 deferredUntil） */
export function statusBody(r: Pick<MailRow, 'id' | 'status' | 'errorCode' | 'retryable' | 'retryCount' | 'deliveryStatus' | 'sentAt' | 'deferredUntil'>) {
  return {
    id: r.id, status: r.status, errorCode: r.errorCode, retryable: r.retryable, retryCount: r.retryCount, maxRetries: MAX_RETRIES,
    deliveryStatus: r.deliveryStatus === 'BOUNCED' ? 'bounced' : 'unknown', sentAt: r.sentAt?.toISOString() ?? null,
    ...(r.errorCode === 'daily_cap_deferred' ? { deferredUntil: r.deferredUntil?.toISOString() ?? null } : {}),
  };
}

export type SendResponse =
  | { kind: 'sent'; status: 201; body: { id: string; status: 'SENT'; sentAt: string | null; retryCount: number; maxRetries: number } }
  | { kind: 'deferred'; status: 202; body: { id: string; status: 'QUEUED'; errorCode: 'daily_cap_deferred'; deferredUntil: string } }
  | { kind: 'sending'; status: 202; body: { id: string; status: 'SENDING'; pollAfterMs: number } }
  | { kind: 'failed'; status: 502; body: { error: 'mail_failed'; id: string; reason: string; retryable: boolean } }
  | { kind: 'error'; status: 400 | 404 | 409 | 503; body: { error: string; retryable?: boolean } };

const err = (status: 400 | 404 | 409 | 503, error: string): SendResponse => ({ kind: 'error', status, body: status === 503 ? { error, retryable: false } : { error } });

/** 纯文本转安全 HTML：全部转义，换行变 <br>（与现有 reply 路由一致） */
export const textToHtml = (t: string) => t.split(/\r?\n/).map(escapeHtml).join('<br>');

const DELETED_EMAIL = /@invalid\.invalid$/i;
/**
 * 收件人：按权限范围（scope）找询盘 → findInquiryForReply 拒绝已匿名化 → 读联系人邮箱并校验是单个干净地址。
 * 返回 not_found / anonymized 或 { inquiryId, replyToken, email }。
 */
export async function findInquiryRecipient(db: Pick<PrismaClient, 'inquiry'>, inquiryId: string, scope: Prisma.InquiryWhereInput) {
  const inq = await db.inquiry.findFirst({ where: { AND: [{ id: inquiryId }, scope] }, select: { id: true, replyToken: true, anonymizedAt: true } });
  if (!inq) return 'not_found' as const;
  if (inq.anonymizedAt) return 'anonymized' as const;
  const ok = await findInquiryForReply(db, inq.replyToken);
  if (!ok || ok.id !== inq.id) return 'anonymized' as const;
  const c = await db.inquiry.findFirst({ where: { id: inq.id, anonymizedAt: null }, select: { contact: { select: { email: true } } } });
  const email = c?.contact?.email?.trim();
  const box = email ? parseMailbox(email) : null;
  if (!email || !box || box.name || email === '[deleted]' || DELETED_EMAIL.test(email)) return 'anonymized' as const;
  return { inquiryId: inq.id, replyToken: inq.replyToken, email: box.address };
}

/** Idempotency-Key（客户端 UUID）按管理员隔离后取哈希存库 */
export const idemKeyFor = (userId: string, key: string) => createHash('sha256').update(`mail-idem-v1:${userId}:${key}`).digest('base64url');

/**
 * 占名额并开始发送（同一事务、advisory lock）。
 * allowedFrom：允许从哪些状态开始（新信 SENDING、重试 FAILED、延后 QUEUED）。
 * 返回 started / deferred（名额已满，行改为 QUEUED + deferredUntil）/ busy（状态已被别的请求改掉，或租约未过期）。
 */
export async function reserveAndStart(db: MailDb, id: string, allowedFrom: MailRow['status'][], opts: { now: Date; env: Env; countRetry?: boolean }) {
  const { start, end } = capWindow(opts.now, opts.env);
  const cap = dailyCap(opts.env);
  return db.$transaction(async (tx: Tx) => {
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(${CAP_LOCK_KEY})::text AS ok`);
    const used = await tx.mailMessage.count({
      where: { direction: 'OUTBOUND', capDay: start, id: { not: id }, OR: [{ status: { in: ['SENDING', 'SENT'] } }, { errorCode: 'unknown_delivery' }] },
    });
    const guard = { id, status: { in: allowedFrom }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: opts.now } }] };
    if (used >= cap) {
      const r = await tx.mailMessage.updateMany({ where: guard, data: { status: 'QUEUED', errorCode: 'daily_cap_deferred', retryable: false, deferredUntil: end, capDay: null, lockedUntil: null } });
      return r.count ? { kind: 'deferred' as const, until: end, used, cap } : { kind: 'busy' as const };
    }
    const r = await tx.mailMessage.updateMany({
      where: guard,
      data: {
        status: 'SENDING', capDay: start, errorCode: null, retryable: false, deferredUntil: null,
        lockedUntil: new Date(opts.now.getTime() + LEASE_MS), requestStartedAt: opts.now, attempts: { increment: 1 },
        ...(opts.countRetry ? { retryCount: { increment: 1 } } : {}),
      },
    });
    return r.count ? { kind: 'started' as const, used: used + 1, cap } : { kind: 'busy' as const };
  });
}

function outbound(row: MailRow, cfg: SmtpConfig, replyToken: string): OutboundMail {
  return {
    to: row.toAddr, replyTo: `reply+${replyToken}@${cfg.replyDomain}`, subject: row.subject,
    text: row.bodyText, html: row.bodyHtml, messageId: row.messageId!, sendKey: row.sendKey!,
    ...(row.inReplyTo ? { inReplyTo: row.inReplyTo } : {}), ...(row.references ? { references: row.references } : {}),
  };
}

const ALERT_TITLE: Partial<Record<SendFailReason, string>> = {
  send_auth: '邮件发信认证失败（需检查 SMTP 配置）', smtp_tls: '邮件发信 TLS 错误', provider_throttled: '邮件服务商限流 / 配额',
};
/** 告警正文：只有错误码（数字响应码或清洗过的错误码）和时间 */
export function alertFields(code: string | null, at: Date): Record<string, string> {
  const safe = code && /^[A-Z0-9_]{1,24}$/i.test(code) ? code : 'unknown';
  return { 错误码: safe, 时间: at.toISOString() };
}

/** 交给适配器并落最终状态。只有在 reserveAndStart 返回 started 之后调用 */
async function deliver(deps: Required<Pick<SendDeps, 'db' | 'adapter'>> & SendDeps, row: MailRow, cfg: SmtpConfig, replyToken: string, now: () => Date): Promise<SendResponse> {
  const mail = outbound(row, cfg, replyToken);
  let res: SendOutcome;
  try { res = await deps.adapter.send(mail); } catch (e) {
    // 适配器本身抛错（不应发生）：无法确定是否已发出 → 按可能已送达处理；日志只记错误类型
    mailLog('error', 'mail.adapter_threw', { mailId: row.id, kind: (e as { name?: string })?.name ?? 'Error' });
    res = { ok: false, reason: 'unknown_delivery', retryable: false, code: null, alert: false };
  }
  const db = deps.db;
  if (res.ok) {
    const sentAt = now();
    await db.mailMessage.update({ where: { id: row.id }, data: { status: 'SENT', sentAt, errorCode: null, retryable: false, lockedUntil: null } });
    if (row.inquiryId) await extendInquiryRetention(db, row.inquiryId).catch(() => false);
    mailLog('info', 'mail.sent', { mailId: row.id });
    return { kind: 'sent', status: 201, body: { id: row.id, status: 'SENT', sentAt: sentAt.toISOString(), retryCount: row.retryCount, maxRetries: MAX_RETRIES } };
  }
  await db.mailMessage.update({ where: { id: row.id }, data: { status: 'FAILED', errorCode: res.reason, retryable: res.retryable, lockedUntil: null } });
  mailLog('error', 'mail.send_failed', { mailId: row.id, reason: res.reason, code: res.code ?? 'none', retryable: res.retryable });
  await deps.audit?.({ action: 'mail.send_fail', target: row.id, meta: { mailId: row.id, reason: res.reason } });
  if (res.alert) {
    // 535 认证失败 / TLS 配置错误 / Gmail 配额：配置问题，发运维告警（同类 30 分钟一封）。
    // 内容只有错误码和时间：不放 SMTP_USER / SMTP_PASS / 服务器原始响应 / 收件人 / 主题。
    await deps.alert?.(ALERT_TITLE[res.reason] ?? '邮件发信配置错误', alertFields(res.code, now()), `mail-config:${res.reason}`).catch(() => {});
  }
  return { kind: 'failed', status: 502, body: { error: 'mail_failed', id: row.id, reason: res.reason, retryable: res.retryable } };
}

async function afterReserve(deps: SendDeps, r: Awaited<ReturnType<typeof reserveAndStart>>, id: string, now: Date): Promise<SendResponse | null> {
  if (r.kind === 'deferred') {
    mailLog('info', 'mail.daily_cap_deferred', { mailId: id, count: r.used, cap: r.cap });
    await deps.alert?.('今日发信已达上限', { 上限: r.cap, 已占用: r.used }, `mail-daily-cap:${now.toISOString().slice(0, 10)}`).catch(() => {});
    return { kind: 'deferred', status: 202, body: { id, status: 'QUEUED', errorCode: 'daily_cap_deferred', deferredUntil: r.until.toISOString() } };
  }
  if (r.kind === 'busy') return { kind: 'sending', status: 202, body: { id, status: 'SENDING', pollAfterMs: 5000 } };
  return null;
}

/** 已存在的信按当前状态回给客户端（幂等重放 / 并发） */
export function responseFor(row: MailRow): SendResponse {
  if (row.status === 'SENT') return { kind: 'sent', status: 201, body: { id: row.id, status: 'SENT', sentAt: row.sentAt?.toISOString() ?? null, retryCount: row.retryCount, maxRetries: MAX_RETRIES } };
  if (row.status === 'QUEUED' && row.errorCode === 'daily_cap_deferred') return { kind: 'deferred', status: 202, body: { id: row.id, status: 'QUEUED', errorCode: 'daily_cap_deferred', deferredUntil: row.deferredUntil?.toISOString() ?? '' } };
  if (row.status === 'FAILED') return { kind: 'failed', status: 502, body: { error: 'mail_failed', id: row.id, reason: row.errorCode ?? 'unknown', retryable: row.retryable } };
  return { kind: 'sending', status: 202, body: { id: row.id, status: 'SENDING', pollAfterMs: 5000 } };
}

export type SendInput = {
  userId: string; inquiryId: string; scope: Prisma.InquiryWhereInput;
  subject: string; body: string; inReplyToId?: string; idempotencyKey?: string | null;
};

/** 8.1 发送回复 */
export async function sendInquiryMail(deps: SendDeps, input: SendInput): Promise<SendResponse> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const c = smtpConfig(env);
  if (!c.ok) return err(409, 'sending_disabled'); // §15 补充：不建记录、不计 retryCount
  const cfg = c.cfg;
  if (headerInjection({ to: '', replyTo: '', subject: input.subject })) return err(400, 'invalid'); // 路由层已拦（400 fields.subject=newline），这里兜底
  const rcpt = await findInquiryRecipient(deps.db, input.inquiryId, input.scope);
  if (rcpt === 'not_found') return err(404, 'not_found');
  if (rcpt === 'anonymized') return err(409, 'anonymized');

  const idemKey = input.idempotencyKey ? idemKeyFor(input.userId, input.idempotencyKey) : null;
  if (idemKey) {
    const prev = await deps.db.mailMessage.findUnique({ where: { idemKey } }) as MailRow | null;
    if (prev && now().getTime() - prev.createdAt.getTime() < IDEM_WINDOW_MS) return responseFor(prev);
  }

  let inReplyTo: string | null = null, references: string | null = null;
  if (input.inReplyToId) {
    const parent = await deps.db.mailMessage.findFirst({ where: { id: input.inReplyToId, inquiryId: rcpt.inquiryId }, select: { messageId: true, references: true } });
    if (!parent) return err(404, 'not_found');
    if (parent.messageId && !/[\r\n\0]/.test(parent.messageId)) {
      inReplyTo = parent.messageId;
      references = `${parent.references ? `${parent.references} ` : ''}${parent.messageId}`.slice(-2000);
    }
  }

  const sendKey = randomId(24);
  const created = await deps.db.$transaction(async (tx: Tx) => {
    // 和 reply 路由一样：在 anonymizedAt IS NULL 条件下顺延保留期；期间被匿名化则不写入
    if (!(await extendInquiryRetention(tx, rcpt.inquiryId, now()))) return null;
    return tx.mailMessage.create({
      data: {
        direction: 'OUTBOUND', status: 'SENDING', inquiryId: rcpt.inquiryId, sendKey, messageId: `<${sendKey}@${cfg.replyDomain}>`,
        inReplyTo, references, idemKey, fromAddr: cfg.from.address, toAddr: rcpt.email,
        subject: input.subject, bodyHtml: textToHtml(input.body), bodyText: input.body, authorId: input.userId,
      },
    });
  }).catch(async (e: unknown) => {
    // 同一 Idempotency-Key 并发：唯一约束冲突 → 回第一条的状态
    if ((e as { code?: string })?.code === 'P2002' && idemKey) return (await deps.db.mailMessage.findUnique({ where: { idemKey } })) ?? null;
    throw e;
  }) as MailRow | null;
  if (!created) return err(409, 'anonymized');
  if (created.sendKey !== sendKey) return responseFor(created); // 幂等冲突，返回已有那条
  await deps.audit?.({ actorId: input.userId, action: 'mail.send', target: created.id, meta: { mailId: created.id, inquiryId: rcpt.inquiryId } });

  const r = await reserveAndStart(deps.db, created.id, ['SENDING'], { now: now(), env, countRetry: false });
  const early = await afterReserve(deps, r, created.id, now());
  if (early) return early;
  return deliver({ ...deps, db: deps.db, adapter: deps.adapter }, created, cfg, rcpt.replyToken, now);
}

/** 8.2 手动重试：只有 FAILED + retryable（不含 unknown_delivery），最多 5 次；同样走名额检查 */
export async function retryMail(deps: SendDeps, input: { userId: string; messageId: string; scope: Prisma.InquiryWhereInput }): Promise<SendResponse> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const c = smtpConfig(env);
  if (!c.ok) return err(409, 'sending_disabled');
  const row = await deps.db.mailMessage.findFirst({ where: { id: input.messageId, direction: 'OUTBOUND', inquiry: { is: input.scope } } }) as MailRow | null;
  if (!row || !row.inquiryId) return err(404, 'not_found');
  const rcpt = await findInquiryRecipient(deps.db, row.inquiryId, input.scope);
  if (rcpt === 'not_found') return err(404, 'not_found');
  if (rcpt === 'anonymized') return err(409, 'anonymized');
  if (row.status !== 'FAILED' || !row.retryable || row.errorCode === 'unknown_delivery') return err(409, 'not_retryable');
  if (row.retryCount >= MAX_RETRIES) return err(409, 'retry_limit');
  // 收件人以库里当前联系人邮箱为准（与新发信一致）
  const fresh: MailRow = { ...row, toAddr: rcpt.email };
  if (fresh.toAddr !== row.toAddr) await deps.db.mailMessage.update({ where: { id: row.id }, data: { toAddr: rcpt.email } });
  const r = await reserveAndStart(deps.db, row.id, ['FAILED'], { now: now(), env, countRetry: true });
  const early = await afterReserve(deps, r, row.id, now());
  if (early) return early;
  await deps.audit?.({ actorId: input.userId, action: 'mail.retry', target: row.id, meta: { mailId: row.id } });
  return deliver({ ...deps, db: deps.db, adapter: deps.adapter }, { ...fresh, retryCount: row.retryCount + 1 }, c.cfg, rcpt.replyToken, now);
}

/**
 * cron：① 租约过期仍是 SENDING 的信 → FAILED unknown_delivery（已开始会话，可能已送达，M5）；
 * ② 到了 deferredUntil 的 daily_cap_deferred 信按创建顺序自动发送，名额再满就停（剩下的顺延到下一次重置）。
 */
export async function processMailQueue(deps: SendDeps, limit = 50) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const out = { stale: 0, sent: 0, failed: 0, deferred: 0, dropped: 0 };
  const stale = await deps.db.mailMessage.updateMany({ where: { direction: 'OUTBOUND', status: 'SENDING', lockedUntil: { lt: now() } }, data: { status: 'FAILED', errorCode: 'unknown_delivery', retryable: false, lockedUntil: null } });
  out.stale = stale.count;
  const c = smtpConfig(env);
  if (!c.ok) return out;
  const due = await deps.db.mailMessage.findMany({ where: { direction: 'OUTBOUND', status: 'QUEUED', errorCode: 'daily_cap_deferred', deferredUntil: { lte: now() } }, orderBy: { createdAt: 'asc' }, take: limit }) as MailRow[];
  for (const row of due) {
    const rcpt = row.inquiryId ? await findInquiryRecipient(deps.db, row.inquiryId, {}) : 'not_found';
    if (typeof rcpt === 'string') {
      // 询盘已匿名化 / 不存在：不再发送
      await deps.db.mailMessage.updateMany({ where: { id: row.id, status: 'QUEUED' }, data: { status: 'FAILED', errorCode: 'unknown', retryable: false } });
      out.dropped++; continue;
    }
    const r = await reserveAndStart(deps.db, row.id, ['QUEUED'], { now: now(), env, countRetry: false });
    if (r.kind === 'deferred') { out.deferred++; break; }
    if (r.kind === 'busy') continue;
    const res = await deliver({ ...deps, db: deps.db, adapter: deps.adapter }, { ...row, toAddr: rcpt.email }, c.cfg, rcpt.replyToken, now);
    if (res.kind === 'sent') out.sent++; else out.failed++;
  }
  return out;
}
