'use client';
// #74 询盘详情 · 往来邮件（8.3）+ 回复框（8.1）+ 发送状态（8.2 / 8.3a）。规格：ux-spec.md A / A-2 / C 节。
import { useCallback, useEffect, useRef, useState } from 'react';
import { mailApi, MailError, type MailConfig, type SendStatus, type ThreadItem, type ThreadPage } from '@/lib/admin/mail/api';
import {
  ANON_THREAD, authorText, DEFAULT_POLL_MS, DEFERRED_REASON, deferredText, BACKGROUND_SENDING, BODY_MAX, bodyCounter, DELETED, fmtCountdown, FORM_UNKNOWN, invalidFieldText, MAYBE_DELIVERED, MAYBE_DELIVERED_HINT,
  NOT_RETRYABLE, oneLineSubject, outboundView, rateLimitText, replySubject, RETRY_LIMIT_HINT, retryCountText, sendErrorText, SENDING_DISABLED, SENDING_DISABLED_HINT,
  showUnverified, SUBJECT_MAX, subjectText, UNCONFIRMED
} from '@/lib/admin/mail/logic';
import { browserVisibility, startSendPoll } from '@/lib/admin/mail/poller';
import { AttachmentCard, CopyBody, FlagChips, MailBody, Unverified, useCountdown } from './MailParts';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '');
const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

type Rate = { scope?: string; limit?: number; until: number };
type ItemNote = { text: string; tone: 'neutral' | 'error' } | { rate: Rate };

/** onSendAccepted：发信被接受（201 / 202）后调用，详情页用它把「新询盘」改为「跟进中」（沿用原回复框行为） */
export default function MailThread({ inquiryId, recipient, onAnonymized, onSendAccepted }: { inquiryId: string; recipient: string; onAnonymized?: () => void; onSendAccepted?: () => void }) {
  const [page, setPage] = useState<ThreadPage | null>();
  const [cfg, setCfg] = useState<MailConfig>();
  const [loadErr, setLoadErr] = useState<string>();
  /** 正在轮询 / 刚收到状态的出站信：覆盖列表里的状态字段 */
  const [live, setLive] = useState<Record<string, Partial<SendStatus> & { unconfirmed?: boolean; background?: boolean }>>({});
  const [itemNote, setItemNote] = useState<Record<string, ItemNote>>({});
  const [retrying, setRetrying] = useState<string>();
  const stops = useRef<(() => void)[]>([]);

  const load = useCallback(async () => {
    try { setPage(await mailApi.getThread(inquiryId)); setLoadErr(undefined); }
    catch (e) { const c = e instanceof MailError ? e.code : 'unknown'; if (c === 'not_found') setPage(null); else setLoadErr(c); }
  }, [inquiryId]);
  useEffect(() => { void load(); mailApi.getConfig().then(setCfg).catch(() => setCfg({ sendingEnabled: true })); }, [load]);
  useEffect(() => () => stops.current.forEach((s) => s()), []);

  const poll = useCallback((id: string, pollAfterMs: number, deferred = false, deferredUntil: string | null = null) => {
    setLive((l) => ({ ...l, [id]: deferred ? { status: 'QUEUED', errorCode: DEFERRED_REASON, deferredUntil } : { status: 'SENDING', background: true } }));
    stops.current.push(startSendPoll({
      fetchStatus: () => mailApi.status(id), pollAfterMs, onVisibility: browserVisibility,
      onEvent: (e) => {
        if (e.type === 'done' || e.type === 'update') setLive((l) => ({ ...l, [id]: { ...e.status, background: e.type === 'update' } }));
        if (e.type === 'done') void load();
        if (e.type === 'timeout') setLive((l) => ({ ...l, [id]: { ...l[id], unconfirmed: true, background: false } }));
        if (e.type === 'error' && e.error.code === 'anonymized') { onAnonymized?.(); void load(); }
      }
    }));
  }, [load, onAnonymized]);

  const retry = async (m: ThreadItem) => {
    setRetrying(m.id); setItemNote((n) => { const c = { ...n }; delete c[m.id]; return c; });
    try {
      const r = await mailApi.retry(m.id, uuid());
      if (r.kind === 'sending') poll(r.id, r.pollAfterMs, r.deferred, r.deferredUntil ?? null);
      await load();
    } catch (e) {
      const err = e instanceof MailError ? e : new MailError('unknown', 0);
      if (err.code === 'rate_limited') setItemNote((n) => ({ ...n, [m.id]: { rate: { scope: err.body.scope, limit: err.body.limit, until: Date.now() + (err.body.retryAfterSec ?? 60) * 1000 } } }));
      else if (err.code === 'retry_limit') setLive((l) => ({ ...l, [m.id]: { ...l[m.id], retryCount: m.maxRetries } }));
      else if (err.code === 'not_retryable') setItemNote((n) => ({ ...n, [m.id]: { text: NOT_RETRYABLE, tone: 'error' } }));
      else if (err.code === 'anonymized') { onAnonymized?.(); }
      else if (err.code === 'mail_failed' && err.body.reason === DEFERRED_REASON && err.body.id) poll(err.body.id, DEFAULT_POLL_MS, true, err.body.deferredUntil ?? null);
      else if (err.code !== 'mail_failed') { const t = sendErrorText(err); if (t) setItemNote((n) => ({ ...n, [m.id]: { text: t.text, tone: t.tone } })); }
      await load();
    } finally { setRetrying(undefined); }
  };

  if (page === undefined) return <section className="adm-sec ml"><h2>往来邮件</h2><p className="muted">{loadErr ? `加载失败：${loadErr}` : '加载中…'}</p></section>;
  if (page === null) return null;
  const anon = !!page.anonymizedAt;
  // 回复默认接最近一封客户本人的来信（跳过自动回复 / 退信）
  const lastInbound = [...page.items].reverse().find((m) => m.direction === 'INBOUND' && !m.redacted && m.source === 'mail' && !m.flags.includes('auto') && !m.flags.includes('bounce'));
  // 延后发送（daily_cap_deferred）可能等到明天，不挡新的回复
  const pollingNow = Object.values(live).some((s) => s.status === 'SENDING' && !s.unconfirmed && s.errorCode !== DEFERRED_REASON);

  return (
    <>
      <section className="adm-sec ml" aria-label="往来邮件">
        <h2>往来邮件 <span className="muted">{page.items.length} 封</span></h2>
        {anon && <div className="ml-banner" role="note" data-testid="mail-anon-notice">ⓘ {ANON_THREAD}</div>}
        <div className="ml-thread">
          {page.items.map((m) => <Bubble key={m.id} m={m} canSend={cfg?.sendingEnabled !== false} live={live[m.id]} note={itemNote[m.id]} retrying={retrying === m.id} onRetry={() => retry(m)} />)}
          {!page.items.length && <p className="muted">还没有往来邮件。</p>}
        </div>
      </section>
      {!anon && cfg && <Composer inquiryId={inquiryId} recipient={recipient} defaultSubject={replySubject(lastInbound?.subject)} inReplyToId={lastInbound?.id}
        sendingEnabled={cfg.sendingEnabled} pollingNow={pollingNow} onSent={load} onAccepted={onSendAccepted} onBackground={poll} onAnonymized={() => { onAnonymized?.(); void load(); }} />}
    </>
  );
}

function Bubble({ m, canSend, live, note, retrying, onRetry }: { m: ThreadItem; canSend: boolean; live?: Partial<SendStatus> & { unconfirmed?: boolean; background?: boolean }; note?: ItemNote; retrying: boolean; onRetry: () => void }) {
  const out = m.direction === 'OUTBOUND';
  const s = { ...m, ...live };
  const subject = subjectText(m);
  const who = authorText(m);
  return (
    <article className={`ml-msg ${out ? 'out' : 'in'}`} aria-label={out ? '我方回复' : '客户来信'} data-id={m.id}>
      <div className="ml-meta">
        {who && <b>{who}</b>}
        {!m.redacted && !out && m.from && m.from !== who && <span>{m.from}</span>}
        <time dateTime={m.createdAt}>{fmt(m.createdAt)}</time>
        {!out && <span className="ml-pill">收件</span>}
        {m.source === 'legacy' && <span className="ml-pill" title="迁移前的站内记录，只读">旧记录</span>}
        {m.redacted && <span className="ml-pill">已删除</span>}
        {!m.redacted && m.source !== 'legacy' && <FlagChips flags={m.flags} />}
      </div>
      {showUnverified(m) && <Unverified />}
      {subject !== null && <div className={`ml-subj${subject === m.subject ? '' : ' ph'}`}>{subject}</div>}
      {m.redacted
        ? <div className="ml-deleted" data-testid="deleted-body">{DELETED}</div>
        : <>
            <MailBody html={m.bodyHtml} text={m.bodyText} hasRemoteImages={m.hasRemoteImages} title={`邮件正文：${subject ?? ''}`} />
            {m.attachments.map((a) => <AttachmentCard key={a.id} a={a} />)}
          </>}
      {out && m.source === 'mail' && !m.redacted && <OutStatus s={s} canSend={canSend} bodyText={m.bodyText} note={note} retrying={retrying} onRetry={onRetry} />}
    </article>
  );
}

function OutStatus({ s, canSend, bodyText, note, retrying, onRetry }: { s: ThreadItem & { unconfirmed?: boolean; background?: boolean }; canSend: boolean; bodyText: string | null; note?: ItemNote; retrying: boolean; onRetry: () => void }) {
  const v = outboundView(s);
  const rate = note && 'rate' in note ? note.rate : undefined;
  const left = useCountdown(rate?.until);
  // 延后发送优先于「状态未确认」：轮询 2 分钟后停，但仍显示预计发送时间 +「刷新」
  if (v.kind === 'deferred') return <div className="ml-status" role="status" data-testid="deferred">ⓘ <span className="t">{deferredText(s.deferredUntil)}</span><button type="button" className="ml-btn" onClick={() => location.reload()}>刷新</button></div>;
  if (s.unconfirmed) return <div className="ml-status" role="status">{UNCONFIRMED} <button type="button" className="ml-btn" onClick={() => location.reload()}>刷新</button></div>;
  if (v.kind === 'sending') return <div className="ml-status" role="status">{s.background ? BACKGROUND_SENDING : '正在发送…'}</div>;
  if (v.kind === 'sent') return <div className="ml-status ok" role="status">✓ 已发送 · {hhmm(v.at)}</div>;
  if (v.kind === 'maybe_delivered') return (
    <div className="ml-status" role="status" data-testid="maybe-delivered"><span className="ml-pill strong">{MAYBE_DELIVERED}</span><span className="t">{MAYBE_DELIVERED_HINT}</span><CopyBody text={bodyText} /></div>);
  const rc = retryCountText(v.retryCount);
  return (
    <div className="ml-status err" role="alert" data-testid="send-failed">
      <span className="t"><b>⚠ 发送失败：</b>{v.retryLimit ? RETRY_LIMIT_HINT : v.text}</span>
      {rc && !v.retryLimit && <span className={`ml-rc${rc.last ? ' last' : ''}`}>{rc.text}</span>}
      {v.canRetry && !(rate && left > 0) && <button type="button" className="ml-btn" disabled={retrying || !canSend} title={canSend ? undefined : SENDING_DISABLED} onClick={onRetry}>{retrying ? '重试中…' : '重试'}</button>}
      {(v.retryLimit || !v.canRetry) && <CopyBody text={bodyText} />}
      {note && 'text' in note && <span className="t">{note.text}</span>}
      {rate && left > 0 && <span className="t" role="status">ⓘ {rateLimitText(rate.scope, rate.limit, '')}<span aria-live="off">{fmtCountdown(left)}</span></span>}
    </div>
  );
}

type FieldErrs = Partial<Record<'subject' | 'body', string>>;
function Composer({ inquiryId, recipient, defaultSubject, inReplyToId, sendingEnabled, pollingNow, onSent, onAccepted, onBackground, onAnonymized }: {
  inquiryId: string; recipient: string; defaultSubject: string; inReplyToId?: string; sendingEnabled: boolean; pollingNow: boolean;
  onSent: () => Promise<void> | void; onAccepted?: () => void; onBackground: (id: string, ms: number, deferred?: boolean, deferredUntil?: string | null) => void; onAnonymized: () => void;
}) {
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState('');
  const [fieldErr, setFieldErr] = useState<FieldErrs>({});
  const [formErr, setFormErr] = useState<{ text: string; tone: 'neutral' | 'error' }>();
  const [rate, setRate] = useState<Rate>();
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>();
  const key = useRef<string>(undefined);
  const subjRef = useRef<HTMLInputElement>(null); const bodyRef = useRef<HTMLTextAreaElement>(null);
  const left = useCountdown(rate?.until);
  const len = [...body].length;
  const counter = bodyCounter(len);
  const limited = !!rate && left > 0;
  const blocked = !sendingEnabled || busy || pollingNow || limited || counter.level === 'over';

  const edit = (f: () => void) => { f(); key.current = undefined; setSentAt(undefined); };
  const submit = async () => {
    const errs: FieldErrs = {};
    if (!subject.trim()) errs.subject = '请填写主题';
    if (!body.trim()) errs.body = '请填写正文';
    setFieldErr(errs); setFormErr(undefined);
    if (errs.subject) return subjRef.current?.focus();
    if (errs.body) return bodyRef.current?.focus();
    key.current ??= uuid(); // 同一份内容重复提交用同一个 Idempotency-Key
    setBusy(true);
    try {
      const r = await mailApi.send(inquiryId, { subject: subject.trim(), body, ...(inReplyToId ? { inReplyToId } : {}) }, key.current);
      key.current = undefined; setBody('');
      if (r.kind === 'sending') onBackground(r.id, r.pollAfterMs, r.deferred, r.deferredUntil ?? null); else setSentAt(r.sentAt);
      onAccepted?.();
      await onSent();
    } catch (e) {
      const err = e instanceof MailError ? e : new MailError('unknown', 0);
      if (err.code === 'invalid') {
        const fe: FieldErrs = {}; let unknown = false;
        for (const [f, c] of Object.entries(err.body.fields ?? {})) { const t = invalidFieldText(f, c, err.body.limits); if (t && (f === 'subject' || f === 'body')) fe[f] = t; else unknown = true; }
        setFieldErr(fe); if (unknown || !Object.keys(fe).length) setFormErr({ text: FORM_UNKNOWN, tone: 'error' });
        (fe.subject ? subjRef : fe.body ? bodyRef : null)?.current?.focus();
      } else if (err.code === 'rate_limited') {
        setRate({ scope: err.body.scope, limit: err.body.limit, until: Date.now() + (err.body.retryAfterSec ?? 60) * 1000 });
      } else if (err.code === 'mail_failed') {
        // 失败的信已作为 FAILED 记录出现在往来记录里（带重试 / 可能已送达），回复框清空
        key.current = undefined; setBody('');
        if (err.body.reason === DEFERRED_REASON && err.body.id) onBackground(err.body.id, DEFAULT_POLL_MS, true, err.body.deferredUntil ?? null);
        await onSent();
      } else {
        const t = sendErrorText(err)!;
        if (t.at === 'body') setFieldErr({ body: t.text }); else setFormErr(t);
        if (err.code === 'anonymized') onAnonymized();
      }
    } finally { setBusy(false); }
  };

  return (
    <section className="adm-sec ml ml-compose" aria-label="回复客户">
      <h2>回复客户</h2>
      {!sendingEnabled && <div className="ml-banner" role="note" data-testid="sending-disabled"><b>{SENDING_DISABLED}</b>　{SENDING_DISABLED_HINT}</div>}
      {formErr && <div className={`ml-status${formErr.tone === 'error' ? ' err' : ''}`} role={formErr.tone === 'error' ? 'alert' : 'status'}>{formErr.tone === 'error' ? '⚠ ' : 'ⓘ '}{formErr.text}</div>}
      {limited && <div className="ml-status" role="status" data-testid="rate-limited">ⓘ {rateLimitText(rate!.scope, rate!.limit, '')}<span aria-live="off">{fmtCountdown(left)}</span></div>}
      {sentAt !== undefined && <div className="ml-status ok" role="status">✓ 已发送 · {hhmm(sentAt)}</div>}
      <label htmlFor="ml-to">收件人</label>
      <input id="ml-to" type="text" readOnly value={recipient} />
      <label htmlFor="ml-subj">主题</label>
      <input id="ml-subj" ref={subjRef} type="text" maxLength={SUBJECT_MAX} value={subject} aria-invalid={!!fieldErr.subject} aria-describedby={fieldErr.subject ? 'ml-subj-err' : undefined}
        onChange={(e) => edit(() => setSubject(oneLineSubject(e.target.value)))} placeholder={defaultSubject ? undefined : '必填'} />
      {fieldErr.subject && <div id="ml-subj-err" className="ml-ferr">{fieldErr.subject}</div>}
      <label htmlFor="ml-body">正文</label>
      <textarea id="ml-body" ref={bodyRef} rows={8} value={body} aria-invalid={!!fieldErr.body} aria-describedby={`ml-cnt${fieldErr.body ? ' ml-body-err' : ''}`}
        onChange={(e) => edit(() => setBody(e.target.value))} />
      {fieldErr.body && <div id="ml-body-err" className="ml-ferr">{fieldErr.body}</div>}
      <div className="ml-row">
        <span id="ml-cnt" className={`ml-cnt ${counter.level}`} aria-live="off">{counter.text}</span>
        <span style={{ flex: 1 }} />
        <CopyBody text={body || null} />
        <button type="button" className="ml-btn primary" disabled={blocked} onClick={submit} aria-describedby={!sendingEnabled ? 'ml-disabled-why' : undefined}>{busy ? '正在发送…' : '发送'}</button>
      </div>
      {!sendingEnabled && <p id="ml-disabled-why" className="muted">「发送」暂不可用：{SENDING_DISABLED}。</p>}
      {pollingNow && <p className="muted" role="status">上一封还在后台发送，完成前暂不能再发。</p>}
      <p className="muted">第一期不支持发信附件。正文上限 {BODY_MAX} 字。</p>
    </section>
  );
}
