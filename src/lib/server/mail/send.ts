import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { escapeHtml, randomId } from '../security';
import { findInquiryForReply } from '../privacy';
import { extendInquiryRetention } from '../admin/inquiries';
import { capWindow, dailyCap, MAX_RETRIES, parseMailbox, smtpConfig, type SmtpConfig } from './config';
import { headerInjection, mailLog, type MailSendAdapter, type OutboundMail, type SendOutcome, type SendFailReason } from './adapter';
import type { AlertResult, AlertWithinOpts } from '../mail';
import { budgetExhausted, remainingBudgetMs, runWithinBudget, type JobBudget } from '../jobs/registry';

/**
 * #74 发信状态机（和发信商无关；适配器见 adapter.ts）。
 * 收件人只从库里取：先按管理员权限范围找到询盘，再用 findInquiryForReply（拒绝已匿名化询盘）确认，最后读该询盘联系人的邮箱。
 * 请求体里没有 to 字段，客户端永远不能指定收件人。
 *
 * §17 每日上限（MAIL_DAILY_CAP）按「发信日内占用名额的信」计数，而不是按请求次数累加：
 * 一条 MailMessage 最多占一个名额（capDay = 当天窗口起点）；占名额的是 SENDING / SENT 以及 unknown_delivery（可能已送达）的信。
 * 同一条信重试不会重复计数（同一行），失败后再重试必须重新走同一个名额检查，所以也绕不过上限。
 * 名额检查和占用在同一个事务里、先拿 pg_advisory_xact_lock，并发请求不会一起越过上限。
 *
 * `attempts` 口径：领取即计数（reserveAndStart 内 increment），终态写必须带本次领取读回的 attempts；
 * 不按 schema 注释的 decrement/清空理解，本单不改 schema。
 */
export type MailDb = Pick<PrismaClient, 'inquiry' | 'mailMessage' | '$transaction'>;
type Tx = Prisma.TransactionClient;
type Env = Record<string, string | undefined>;

export type AlertFn = (
  kind: string, lines: Record<string, string | number>, dedupeKey: string, opts?: AlertWithinOpts,
) => Promise<AlertResult | void>;
export type AuditFn = (e: { actorId?: string | null; action: string; target?: string | null; meta?: Prisma.InputJsonValue; ip?: string | null }) => Promise<void>;
export type AuditInTxFn = (tx: Tx, e: { actorId?: string | null; action: string; target?: string | null; meta?: Prisma.InputJsonValue; ip?: string | null }) => Promise<void>;

export type SendDeps = {
  db: MailDb;
  adapter: MailSendAdapter;
  env?: Env;
  now?: () => Date;
  alert?: AlertFn;
  audit?: AuditFn;
  /** 队列路径注入：必须持久化的审计与终态写同事务；交互路径不传。 */
  auditInTx?: AuditInTxFn;
};

const CAP_LOCK_KEY = 740_017; // pg_advisory_xact_lock 的固定键：只用于每日发信名额
const LEASE_MS = 60_000;
const IDEM_WINDOW_MS = 10 * 60_000;

/** 队列停止领取阈值：剩余预算不足 1s 就不再开新行，留出 JobState 摘要事务。 */
export const MAIL_STOP_RESERVE_MS = 1_000;
/** 整轮共享的收尾写窗口（绝对 2s，不是每次写 2s）。 */
export const MAIL_CLOSE_WINDOW_MS = 2_000;
export const MAIL_CLOSE_MAX_WAIT_MS = 250;
export const MAIL_CLOSE_TX_MS = 1_750;
/** 剩余预算低于此值不再开普通事务，直接走收尾窗口。 */
export const MAIL_TERMINAL_MIN_TX_MS = 750;
/** 队列告警的最小余量：低于它就跳过告警，避免在截止边缘启动 SMTP。 */
export const MAIL_ALERT_MIN_MS = 500;

/** 收尾窗口：每轮最多一次；`used` 在进入事务前置 true，失败也不得第二次进入。 */
export type MailCloseWindow = { used: boolean; deadlineAt: Date };

export type MailRow = {
  id: string; status: 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'RECEIVED' | 'UNASSIGNED' | 'IGNORED'; inquiryId: string | null;
  messageId: string | null; sendKey: string | null; inReplyTo: string | null; references: string | null;
  toAddr: string; subject: string; bodyHtml: string; bodyText: string;
  errorCode: string | null; retryable: boolean; retryCount: number; deliveryStatus: 'UNKNOWN' | 'BOUNCED';
  sentAt: Date | null; deferredUntil: Date | null; createdAt: Date; lockedUntil: Date | null; capDay: Date | null;
  attempts: number; redactedAt: Date | null;
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

export type ReserveResult =
  | { kind: 'deferred'; until: Date; used: number; cap: number }
  | { kind: 'busy' }
  | { kind: 'budget' }
  | { kind: 'started'; used: number; cap: number; attempts: number; lockedUntil: Date };

/**
 * 占名额并开始发送（同一事务、advisory lock）。
 * allowedFrom：允许从哪些状态开始（新信 SENDING、重试 FAILED、延后 QUEUED）。
 * 返回 started / deferred（名额已满，行改为 QUEUED + deferredUntil）/ busy / budget（预算不足，未写入）。
 * started 的 attempts 只在同一事务内、updateMany 成功后读回（事务持有行锁），不接受事务外重读。
 */
export async function reserveAndStart(
  db: MailDb,
  id: string,
  allowedFrom: MailRow['status'][],
  opts: { now: Date; env: Env; countRetry?: boolean; budget?: JobBudget },
): Promise<ReserveResult> {
  const { start, end } = capWindow(opts.now, opts.env);
  const cap = dailyCap(opts.env);
  const work = async (tx: Tx): Promise<ReserveResult> => {
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(${CAP_LOCK_KEY})::text AS ok`);
    const used = await tx.mailMessage.count({
      where: { direction: 'OUTBOUND', capDay: start, id: { not: id }, OR: [{ status: { in: ['SENDING', 'SENT'] } }, { errorCode: 'unknown_delivery' }] },
    });
    const guard = { id, status: { in: allowedFrom }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: opts.now } }] };
    if (used >= cap) {
      const r = await tx.mailMessage.updateMany({ where: guard, data: { status: 'QUEUED', errorCode: 'daily_cap_deferred', retryable: false, deferredUntil: end, capDay: null, lockedUntil: null } });
      return r.count ? { kind: 'deferred', until: end, used, cap } : { kind: 'busy' };
    }
    const r = await tx.mailMessage.updateMany({
      where: guard,
      data: {
        status: 'SENDING', capDay: start, errorCode: null, retryable: false, deferredUntil: null,
        lockedUntil: new Date(opts.now.getTime() + LEASE_MS), requestStartedAt: opts.now, attempts: { increment: 1 },
        ...(opts.countRetry ? { retryCount: { increment: 1 } } : {}),
      },
    });
    if (!r.count) return { kind: 'busy' };
    const row = await tx.mailMessage.findUnique({ where: { id }, select: { attempts: true, lockedUntil: true } });
    if (!row || !Number.isInteger(row.attempts) || row.attempts <= 0 || !row.lockedUntil) {
      throw new Error('mail_reserve_token_unreadable');
    }
    return { kind: 'started', used: used + 1, cap, attempts: row.attempts, lockedUntil: row.lockedUntil };
  };
  if (!opts.budget) return db.$transaction(work);
  const result = await runWithinBudget(db as unknown as Pick<PrismaClient, '$transaction'>, opts.budget, work);
  if (result.kind === 'budget') return { kind: 'budget' };
  if (result.kind === 'error') throw result.error;
  return result.value;
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

// ---------------------------------------------------------------------------
// 终态写：一条完整 guard + data 的 UPDATE（普通预算事务与收尾事务共用）
// ---------------------------------------------------------------------------

type TerminalData =
  | { status: 'SENT'; sentAt: Date; errorCode: null; retryable: false; lockedUntil: null }
  | { status: 'FAILED'; errorCode: string; retryable: boolean; lockedUntil: null };

type TerminalOutcome =
  | { kind: 'ok'; counted: 'sent' | 'failed' | null; written: boolean; upgraded: boolean }
  | { kind: 'rolled_back' }
  | { kind: 'unconfirmed' }
  | { kind: 'skipped' };

/** 失败终态的一些情形要写审计；只在事务内调用（auditInTx 由队列注入）。 */
async function terminalTx(
  deps: SendDeps,
  tx: Tx,
  row: MailRow,
  attempts: number,
  res: SendOutcome,
  sentAt: Date,
): Promise<{ counted: 'sent' | 'failed' | null; written: boolean; upgraded: boolean }> {
  const data: TerminalData = res.ok
    ? { status: 'SENT', sentAt, errorCode: null, retryable: false, lockedUntil: null }
    : { status: 'FAILED', errorCode: res.reason, retryable: res.retryable, lockedUntil: null };
  const r = await tx.mailMessage.updateMany({
    where: { id: row.id, status: 'SENDING', attempts, redactedAt: null },
    data,
  });
  if (r.count === 1) {
    if (res.ok) {
      if (row.inquiryId) await extendInquiryRetention(tx, row.inquiryId);
      return { counted: 'sent', written: true, upgraded: false };
    }
    await deps.auditInTx?.(tx, { action: 'mail.send_fail', target: row.id, meta: { mailId: row.id, reason: res.reason } });
    return { counted: 'failed', written: true, upgraded: false };
  }
  // 成功结果遇到 stale（unknown_delivery）时的受控升级：同一 attempt 的第二条条件 SQL，只发一次。
  if (res.ok) {
    const up = await tx.mailMessage.updateMany({
      where: { id: row.id, status: 'FAILED', errorCode: 'unknown_delivery', retryable: false, attempts, redactedAt: null },
      data: { status: 'SENT', sentAt, errorCode: null, retryable: false, lockedUntil: null },
    });
    if (up.count === 1) {
      if (row.inquiryId) await extendInquiryRetention(tx, row.inquiryId);
      await deps.auditInTx?.(tx, { action: 'mail.delivery_reconciled', target: row.id, meta: { mailId: row.id, attempts } });
      return { counted: 'sent', written: true, upgraded: true };
    }
  }
  await deps.auditInTx?.(tx, { action: 'mail.terminal_conflict', target: row.id, meta: { mailId: row.id, attempts, outcome: res.ok ? 'late_success' : 'late_failure' } });
  return { counted: null, written: false, upgraded: false };
}

function isKnownCommitRollback(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; meta?: { code?: unknown } };
  if (e.code === 'P2034') return true;
  if (e.code !== 'P2010') return false;
  return ['40001', '40P01', '57014', '55P03'].includes(String(e.meta?.code ?? ''));
}

/** 收尾写：绝对截止 + 每轮最多一次；不改预算 signal（abort 之后仍允许这一笔）。 */
async function closeTerminal(
  deps: SendDeps,
  row: MailRow,
  attempts: number,
  res: SendOutcome,
  sentAt: Date,
  close: MailCloseWindow | undefined,
): Promise<TerminalOutcome> {
  if (!close || close.used) {
    mailLog('error', 'mail.close_skipped', { mailId: row.id });
    return { kind: 'skipped' };
  }
  const remaining = close.deadlineAt.getTime() - Date.now();
  if (remaining < MAIL_CLOSE_MAX_WAIT_MS) {
    mailLog('error', 'mail.close_skipped', { mailId: row.id });
    return { kind: 'skipped' };
  }
  close.used = true;
  const maxWait = Math.min(MAIL_CLOSE_MAX_WAIT_MS, Math.floor(remaining / 2));
  const timeout = Math.min(MAIL_CLOSE_TX_MS, remaining - maxWait);
  let callbackDone = false;
  try {
    const value = await deps.db.$transaction(async (tx: Tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.max(1, timeout)}`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${Math.max(1, timeout)}`);
      const v = await terminalTx(deps, tx, row, attempts, res, sentAt);
      callbackDone = true;
      return v;
    }, { maxWait: Math.max(1, maxWait), timeout: Math.max(1, timeout) });
    return { kind: 'ok', counted: value.counted, written: value.written, upgraded: value.upgraded };
  } catch (error) {
    // 回调内抛出 = 已知回滚；回调完成后 reject 只有可确认的 SQLSTATE/P2034 才算已知回滚，其余保守未知。
    const known = !callbackDone || isKnownCommitRollback(error);
    mailLog('error', known ? 'mail.close_rolled_back' : 'mail.close_unconfirmed', {
      mailId: row.id, stage: callbackDone ? 'commit' : 'callback',
    });
    return { kind: known ? 'rolled_back' : 'unconfirmed' };
  }
}

/**
 * 普通预算事务写终态；剩余不足 750ms 时改走收尾窗口。
 * 普通事务 budget/抛错不重试、不用收尾窗再写：记 close_unconfirmed，交给下一轮 stale。
 */
async function runTerminal(
  deps: SendDeps,
  row: MailRow,
  attempts: number,
  res: SendOutcome,
  sentAt: Date,
  opts: { budget?: JobBudget; close?: MailCloseWindow },
): Promise<TerminalOutcome> {
  if (opts.budget) {
    if (remainingBudgetMs(opts.budget) <= MAIL_TERMINAL_MIN_TX_MS) {
      return closeTerminal(deps, row, attempts, res, sentAt, opts.close);
    }
    const r = await runWithinBudget(deps.db as unknown as Pick<PrismaClient, '$transaction'>, opts.budget, (tx) =>
      terminalTx(deps, tx, row, attempts, res, sentAt));
    if (r.kind === 'ok') return { kind: 'ok', counted: r.value.counted, written: r.value.written, upgraded: r.value.upgraded };
    mailLog('error', 'mail.close_unconfirmed', { mailId: row.id, stage: r.kind === 'budget' ? 'terminal_budget' : 'terminal_error' });
    return { kind: 'unconfirmed' };
  }
  // 交互路径：不套队列预算/收尾窗，失败照旧抛给路由。
  const value = await deps.db.$transaction((tx: Tx) => terminalTx(deps, tx, row, attempts, res, sentAt));
  return { kind: 'ok', counted: value.counted, written: value.written, upgraded: value.upgraded };
}

/** 0 行后的一次有界只读观察：只在收尾窗剩余 ≥250ms 时做一次，不做状态断言。 */
async function observeAfterZero(deps: SendDeps, row: MailRow, close: MailCloseWindow | undefined): Promise<string> {
  if (!close || Date.now() >= close.deadlineAt.getTime() - MAIL_CLOSE_MAX_WAIT_MS) return 'skipped';
  try {
    const current = await deps.db.mailMessage.findUnique({
      where: { id: row.id }, select: { status: true, errorCode: true, redactedAt: true },
    });
    if (!current) return 'missing';
    if (current.redactedAt) return 'redacted';
    return `${current.status}:${current.errorCode ?? 'none'}`;
  } catch {
    return 'unreadable';
  }
}

/** 队列告警统一出口：截止前 500ms 自查；结果分 skipped/failed 记日志，不参与计数。 */
async function queueAlert(
  deps: SendDeps,
  kind: string,
  lines: Record<string, string | number>,
  dedupeKey: string,
  deadlineAt: Date | undefined,
  mailId?: string,
): Promise<void> {
  if (!deps.alert) return;
  if (deadlineAt && Date.now() >= deadlineAt.getTime() - MAIL_ALERT_MIN_MS) {
    mailLog('info', 'mail.queue_alert_skipped', { mailId: mailId ?? 'none', dedupeKey, reason: 'deadline' });
    return;
  }
  let result: AlertResult | void;
  try {
    result = await deps.alert(kind, lines, dedupeKey, deadlineAt ? { deadlineAt } : undefined);
  } catch {
    result = 'failed';
  }
  if (result === 'skipped') mailLog('info', 'mail.queue_alert_skipped', { mailId: mailId ?? 'none', dedupeKey, reason: 'alert' });
  else if (result === 'failed') mailLog('error', 'mail.queue_alert_failed', { mailId: mailId ?? 'none', dedupeKey });
}

export type DeliverOutcome = { response: SendResponse; counted: 'sent' | 'failed' | null };

/** 交给适配器并落最终状态。只有在 reserveAndStart 返回 started 之后调用。 */
export async function deliver(
  deps: SendDeps,
  row: MailRow,
  cfg: SmtpConfig,
  replyToken: string,
  now: () => Date,
  opts: { attempts: number; budget?: JobBudget; close?: MailCloseWindow },
): Promise<DeliverOutcome> {
  // fail closed：没有本次领取的 attempts 一律不写终态（也不进 SMTP）。
  if (!Number.isInteger(opts.attempts) || opts.attempts <= 0) throw new Error('mail_attempt_token_missing');
  const mail = outbound(row, cfg, replyToken);
  let res: SendOutcome;
  try {
    res = await deps.adapter.send(mail);
  } catch (e) {
    // 适配器本身抛错（不应发生）：无法确定是否已发出 → 按可能已送达处理；日志只记错误类型
    mailLog('error', 'mail.adapter_threw', { mailId: row.id, kind: (e as { name?: string })?.name ?? 'Error' });
    res = { ok: false, reason: 'unknown_delivery', retryable: false, code: null, alert: false };
  }
  const sentAt = now();
  const outcome = await runTerminal(deps, row, opts.attempts, res, sentAt, { budget: opts.budget, close: opts.close });
  const response = responseFor({ ...row, attempts: opts.attempts, status: res.ok ? 'SENT' : 'FAILED', errorCode: res.ok ? null : res.reason, retryable: res.ok ? false : res.retryable, sentAt: res.ok ? sentAt : row.sentAt });
  if (outcome.kind !== 'ok') return { response, counted: null };
  if (outcome.counted === 'sent') {
    mailLog('info', outcome.upgraded ? 'mail.delivery_reconciled' : 'mail.sent', { mailId: row.id, attempts: opts.attempts });
    return { response, counted: 'sent' };
  }
  if (outcome.counted === 'failed') {
    if (!res.ok) {
      mailLog('error', 'mail.send_failed', { mailId: row.id, reason: res.reason, code: res.code ?? 'none', retryable: res.retryable });
      if (res.alert) {
        await queueAlert(deps, ALERT_TITLE[res.reason] ?? '邮件发信配置错误', alertFields(res.code, now()), `mail-config:${res.reason}`, opts.budget?.deadlineAt, row.id);
      }
    }
    return { response, counted: 'failed' };
  }
  const observed = await observeAfterZero(deps, row, opts.close);
  mailLog('info', 'mail.terminal_conflict', { mailId: row.id, attempts: opts.attempts, observed });
  if (!deps.auditInTx) await deps.audit?.({
    action: 'mail.terminal_conflict', target: row.id, meta: { mailId: row.id, attempts: opts.attempts, observed },
  });
  if (!opts.budget) {
    // 交互路径：0 行后按一次重读取当前行；已匿名化按现行错误协议返回 409，不新增 DTO 字段。
    const fresh = await deps.db.mailMessage.findUnique({ where: { id: row.id } }) as MailRow | null;
    if (!fresh) return { response: err(404, 'not_found'), counted: null };
    if (fresh.redactedAt) return { response: err(409, 'anonymized'), counted: null };
    return { response: responseFor(fresh), counted: null };
  }
  return { response, counted: null };
}

async function afterReserve(
  deps: SendDeps,
  r: ReserveResult,
  id: string,
  now: Date,
  alertOpts?: { budget?: JobBudget },
): Promise<SendResponse | null> {
  if (r.kind === 'budget') return err(503, 'service_unavailable');
  if (r.kind === 'deferred') {
    mailLog('info', 'mail.daily_cap_deferred', { mailId: id, count: r.used, cap: r.cap });
    await queueAlert(deps, '今日发信已达上限', { 上限: r.cap, 已占用: r.used }, `mail-daily-cap:${now.toISOString().slice(0, 10)}`, alertOpts?.budget?.deadlineAt, id);
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
  if (r.kind !== 'started') return err(503, 'service_unavailable');
  return (await deliver(deps, created, cfg, rcpt.replyToken, now, { attempts: r.attempts })).response;
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
  if (r.kind !== 'started') return err(503, 'service_unavailable');
  return (await deliver(deps, { ...fresh, retryCount: row.retryCount + 1 }, c.cfg, rcpt.replyToken, now, { attempts: r.attempts })).response;
}

// ---------------------------------------------------------------------------
// 队列：预算内 stale/due/reserve/终态；收尾窗只一次
// ---------------------------------------------------------------------------

type QueueOut = { stale: number; sent: number; failed: number; deferred: number; dropped: number };

function budgetOf(deps: SendDeps, opts: { budget?: JobBudget }): JobBudget | undefined {
  return opts.budget;
}

/** 普通预算内跑一次只读/写入；无预算走原路径。 */
async function runBudgeted<T>(
  deps: SendDeps,
  budget: JobBudget | undefined,
  work: (q: Tx) => Promise<T>,
): Promise<{ kind: 'ok'; value: T } | { kind: 'budget' } | { kind: 'error'; error: unknown }> {
  if (!budget) return { kind: 'ok', value: await work(deps.db as unknown as Tx) };
  const r = await runWithinBudget(deps.db as unknown as Pick<PrismaClient, '$transaction'>, budget, work);
  if (r.kind === 'ok') return { kind: 'ok', value: r.value };
  if (r.kind === 'budget') return { kind: 'budget' };
  return { kind: 'error', error: r.error };
}

/** D 回退：只允许一次收尾事务；命中后调用方必须 break。 */
async function closeDeferred(
  deps: SendDeps,
  row: MailRow,
  attempts: number,
  close: MailCloseWindow | undefined,
): Promise<'deferred' | 'unconfirmed' | 'skipped' | 'conflict'> {
  if (!close || close.used) {
    mailLog('error', 'mail.close_skipped', { mailId: row.id, stage: 'deferred' });
    return 'skipped';
  }
  const remaining = close.deadlineAt.getTime() - Date.now();
  if (remaining < MAIL_CLOSE_MAX_WAIT_MS) {
    mailLog('error', 'mail.close_skipped', { mailId: row.id, stage: 'deferred' });
    return 'skipped';
  }
  close.used = true;
  const maxWait = Math.min(MAIL_CLOSE_MAX_WAIT_MS, Math.floor(remaining / 2));
  const timeout = Math.min(MAIL_CLOSE_TX_MS, remaining - maxWait);
  let callbackDone = false;
  try {
    const value = await deps.db.$transaction(async (tx: Tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.max(1, timeout)}`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${Math.max(1, timeout)}`);
      const r = await tx.mailMessage.updateMany({
        where: { id: row.id, status: 'SENDING', attempts, redactedAt: null },
        data: {
          status: 'QUEUED', errorCode: 'daily_cap_deferred', retryable: false,
          deferredUntil: row.deferredUntil, capDay: null, lockedUntil: null,
        },
      });
      if (r.count === 1) { callbackDone = true; return 'deferred' as const; }
      const observed = await tx.mailMessage.findUnique({
        where: { id: row.id }, select: { status: true, errorCode: true, redactedAt: true },
      });
      callbackDone = true;
      return observed === null ? 'missing' as const : observed.redactedAt ? 'redacted' as const : `${observed.status}:${observed.errorCode ?? 'none'}` as const;
    }, { maxWait: Math.max(1, maxWait), timeout: Math.max(1, timeout) });
    if (value === 'deferred') return 'deferred';
    mailLog('info', 'mail.close_unobserved', { mailId: row.id, observed: value });
    return 'conflict';
  } catch (error) {
    const known = !callbackDone || isKnownCommitRollback(error);
    mailLog('error', known ? 'mail.close_rolled_back' : 'mail.close_unconfirmed', {
      mailId: row.id, stage: callbackDone ? 'commit' : 'callback',
    });
    return known ? 'conflict' : 'unconfirmed';
  }
}

/**
 * cron：① 租约过期仍是 SENDING 的信 → FAILED unknown_delivery（已开始会话，可能已送达，M5）；
 * ② 到了 deferredUntil 的 daily_cap_deferred 信按创建顺序自动发送，名额再满就停（剩下的顺延到下一次重置）。
 * 带 budget 时每步都受整轮预算约束；收尾窗由调用方创建并共享（每轮最多一次）。
 */
export async function processMailQueue(
  deps: SendDeps,
  opts: { limit?: number; budget?: JobBudget; close?: MailCloseWindow } = {},
): Promise<QueueOut> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const limit = opts.limit ?? 50;
  const budget = opts.budget ?? budgetOf(deps, opts);
  const close = opts.close;
  const out: QueueOut = { stale: 0, sent: 0, failed: 0, deferred: 0, dropped: 0 };
  const stop = () => budget !== undefined && remainingBudgetMs(budget) <= MAIL_STOP_RESERVE_MS;

  const sweep = async (q: Tx) => q.mailMessage.updateMany({
    where: { direction: 'OUTBOUND', status: 'SENDING', lockedUntil: { lt: now() } },
    data: { status: 'FAILED', errorCode: 'unknown_delivery', retryable: false, lockedUntil: null },
  });
  const swept = await runBudgeted(deps, budget, sweep);
  if (swept.kind === 'ok') out.stale = swept.value.count;
  else if (swept.kind === 'budget') return out; // 本轮清理都开不了事务：直接结束（摘要仍会写）
  // 未知错误：跳过本轮 stale，继续处理 due（旧实现也不因单步失败中断）。

  const c = smtpConfig(env);
  if (!c.ok) return out;
  if (stop() || (budget && budgetExhausted(budget))) return out;

  const dueResult = await runBudgeted(deps, budget, async (q) => q.mailMessage.findMany({
    where: { direction: 'OUTBOUND', status: 'QUEUED', errorCode: 'daily_cap_deferred', deferredUntil: { lte: now() } },
    orderBy: { createdAt: 'asc' }, take: limit,
  }) as Promise<MailRow[]>);
  if (dueResult.kind !== 'ok') return out;
  const due = dueResult.value;

  for (const row of due) {
    if (stop()) break;
    const rcptResult = row.inquiryId
      ? await runBudgeted(deps, budget, (q) => findInquiryRecipient(q as unknown as Pick<PrismaClient, 'inquiry'>, row.inquiryId!, {}))
      : { kind: 'ok' as const, value: 'not_found' as const };
    if (rcptResult.kind === 'budget') break;
    if (rcptResult.kind === 'error') break;
    const rcpt = rcptResult.value;
    if (typeof rcpt === 'string') {
      // 询盘已匿名化 / 不存在：不再发送。只有确认写的 count===1 才计 dropped；未领取，不占收尾窗。
      const dropped = await runBudgeted(deps, budget, (q) => q.mailMessage.updateMany({
        where: { id: row.id, status: 'QUEUED' },
        data: { status: 'FAILED', errorCode: 'unknown', retryable: false },
      }));
      if (dropped.kind === 'budget') break;
      if (dropped.kind === 'ok' && dropped.value.count === 1) out.dropped++;
      else mailLog('info', 'mail.terminal_conflict', { mailId: row.id, observed: 'dropped_not_written' });
      continue;
    }
    const r = await reserveAndStart(deps.db, row.id, ['QUEUED'], {
      now: now(), env, countRetry: false, ...(budget ? { budget } : {}),
    });
    if (r.kind === 'budget') break;
    if (r.kind === 'deferred') { out.deferred++; break; }
    if (r.kind === 'busy') continue;
    // 截止落在 reserve 后、SMTP 前：D 回退（同一收尾窗），成功后 break。
    if (budget && budgetExhausted(budget)) {
      const back = await closeDeferred(deps, row, r.attempts, close);
      if (back === 'deferred') out.deferred++;
      break;
    }
    const delivered = await deliver(deps, { ...row, toAddr: rcpt.email }, c.cfg, rcpt.replyToken, now, {
      attempts: r.attempts, budget, close,
    });
    if (delivered.counted === 'sent') out.sent++;
    else if (delivered.counted === 'failed') out.failed++;
  }
  return out;
}
