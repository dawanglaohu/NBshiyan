import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import {
  assertConversationExceptRead, assertDbStable, assertHttpStable, assertOutboxStable, assertReadUnchanged, assertSafe,
} from './chat-seam-assertions.mjs';

const base = 'http://127.0.0.1:3100';
const origin = 'http://localhost:3100';
const artifact = '/tmp/mail-evidence-artifacts/http-real';
const state = '/tmp/chat-notifications-cron';
const key = 'chat-notifications';
const hook = 'CHAT_NOTIFICATION_TEST_PAUSE_AFTER_ACCEPT';
const scale = 'CHAT_NOTIFICATION_TEST_BACKOFF_SCALE';
const hookMarker = 'CHAT_NOTIFICATION_TEST_HOOK_ACTIVE';
const arg = process.argv.indexOf('--report');
const reportFile = arg >= 0 ? process.argv[arg + 1] : '';
const report = { pass: false, stage: 'preflight', ticks: [], checks: {} };

// The J2 seam is opt-in and owns a file of its own. A repeated, empty or colliding flag is refused
// here, before the preflight, so a malformed invocation cannot half-write either report.
function seamReportPath() {
  const hits = [];
  for (let index = 0; index < process.argv.length; index++) if (process.argv[index] === '--seam-report') hits.push(index);
  if (hits.length === 0) return '';
  if (hits.length > 1) throw new Error('SEAM_ARG_REPEATED');
  const value = process.argv[hits[0] + 1];
  if (typeof value !== 'string' || value === '' || value.startsWith('--')) throw new Error('SEAM_ARG_MISSING');
  if (reportFile && path.resolve(value) === path.resolve(reportFile)) throw new Error('SEAM_ARG_COLLIDES');
  return value;
}
const seamFile = seamReportPath();
const seamOn = seamFile !== '';
const seam = {
  pass: false, stage: 'preflight', ticks: [], checks: {}, failures: [],
  requests: [], snapshots: {}, receipts: {}, facts: {}, provenance: {}, env: {}, counts: {},
};
// Every J2 observation in the S4 phases below is one of these groups. A group that never runs is
// missing from checks and fails the seam, so a skipped observation cannot look like a pass.
const SEAM_GROUPS = [
  'a1-conflict-rejected', 'a1-queued-baseline', 'a1-sent-keeps-domain', 'a1-sync-first-message',
  'a1-read-advances', 'a1-read-idempotent',
  'b1-pre-kill-snapshot', 'b1-killed-db', 'b1-leased-db', 'b1-unknown-db', 'b1-sent2-db',
  'b1-http-after-recovery',
  'c1-target-baseline', 'c1-single-target', 'c1-arm-clean', 'c1-tick-minute', 'c1-job-state',
  'c1-sink-deltas', 'c1-row-retry-scheduled', 'c1-domain',
  'd1-own-read', 'd1-cross-404', 'd1-owner-advance',
  'e1-single-post-per-arm', 'e1-no-private-markers',
  'f1-db-identity', 'f1-pg17', 'f2-error-codes',
];
// Fixed vocabularies: the artifact may only carry these values, never an arbitrary string.
const SEAM_STAGES = [
  'preflight', 'default', 'accepted-before-kill', 'restart-sweep', 'restart-resend',
  'complete', 'transient-451', 'second-visitor', 'failed',
];
const SEAM_ERROR_CODES = ['AssertionError', 'TypeError', 'RangeError', 'Error', 'Other'];
let app, db;
// Set once the S4 receipt is on disk, so the finalizer never writes it a second time.
let s4Persisted = false;
function writeReportFile() {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
}

async function until(probe, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw new Error('TIMEOUT');
}
function privateFile(file, value) { fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' }); }
async function stop(signal = 'SIGTERM') {
  const child = app?.child;
  if (!child) return;
  app = undefined;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit');
  child.kill(signal);
  try { await until(() => child.exitCode !== null || child.signalCode !== null, 5_000); }
  catch { child.kill('SIGKILL'); await closed; throw new Error('APP_STOP_TIMEOUT'); }
}
async function start(hooks = {}) {
  const env = { ...process.env, HOSTNAME: '127.0.0.1', PORT: '3100', E2E_SITE_REVALIDATE: '1', APP_ORIGIN: origin, AUTH_URL: origin };
  delete env.NODE_PATH;
  delete env[hook];
  delete env[scale];
  Object.assign(env, hooks);
  const child = spawn(process.execPath, ['server.js'], { cwd: artifact, env, stdio: ['ignore', 'pipe', 'pipe'] });
  app = { child, marker: false, output: '' };
  const own = app;
  const observe = (chunk) => {
    own.output = (own.output + chunk.toString()).slice(-16_384);
    if (own.output.includes(hookMarker)) own.marker = true;
  };
  child.stdout.on('data', observe); child.stderr.on('data', observe);
  child.on('error', () => { own.error = true; });
  await until(async () => {
    assert.ok(!own.error && child.exitCode === null && child.signalCode === null);
    try { const r = await fetch(`${base}/en`, { signal: AbortSignal.timeout(1_000) }); await r.body?.cancel(); return r.ok; } catch { return false; }
  }, 30_000);
}
async function post(pathname, input, cookie) {
  const response = await fetch(base + pathname, {
    method: 'POST', headers: { origin, host: 'localhost:3100', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    redirect: 'error', body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
  });
  return response;
}
// J2 recorders. Every request keeps only its method, a pattern path, the afterSeq input and the status.
async function getSync(cookie, conversationId, afterSeq = 0) {
  const response = await fetch(`${base}/api/chat/conversations/${conversationId}?afterSeq=${afterSeq}`, {
    headers: { cookie }, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  seam.requests.push({ method: 'GET', path: '/api/chat/conversations/[id]', afterSeq, status: response.status });
  return response;
}
async function markRead(cookie, conversationId, lastReadSeq) {
  const response = await post(`/api/chat/conversations/${conversationId}/read`, { lastReadSeq }, cookie);
  seam.requests.push({ method: 'POST', path: '/api/chat/conversations/[id]/read', status: response.status });
  return response;
}
async function sinkControl(pathname) {
  const response = await fetch(`http://127.0.0.1:3998${pathname}`, {
    method: 'POST',
    headers: { 'x-mail-evidence-control': process.env.SMTP_EVIDENCE_CONTROL ?? '', 'content-length': '0' },
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function iso(value) { return value == null ? null : value.toISOString(); }
// Safe projections. The conversation keeps scalars plus two digests over the columns that must not
// move; the notification row is operational only (no body, email, cookie or token).
function conversationProjection(row, messages) {
  return {
    id: row.id, status: row.status, version: row.version, lastSeq: row.lastSeq,
    visitorReadSeq: row.visitorReadSeq,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    lastActivityAt: iso(row.lastActivityAt), retainUntil: iso(row.retainUntil),
    anonymizedAt: iso(row.anonymizedAt), locale: row.locale, productSlug: row.productSlug,
    identityDigest: digest([row.visitorSessionId, row.clientConversationId, row.createPayloadHash, row.email, row.sourcePath]),
    messageCount: messages.length,
    messageDigest: digest(messages.map((message) => [
      message.id, message.conversationId, message.seq, message.sender, message.authorId,
      message.clientMessageId, message.payloadHash, digest(message.bodyText),
      iso(message.createdAt), iso(message.redactedAt),
    ])),
  };
}
function outboxProjection(note) {
  // The lease owner and provider message id never leave the process: they only enter the digest and
  // a presence flag, so an arbitrary value cannot reach the artifact through this row.
  const full = [
    note.id, note.conversationId, note.messageId, note.status, note.attempts,
    iso(note.availableAt), note.leaseVersion, note.leaseOwner, note.stableMessageId, iso(note.lockedUntil),
    iso(note.requestStartedAt), note.lastErrorCode, note.providerMessageId, iso(note.sentAt),
    iso(note.createdAt), iso(note.updatedAt),
  ];
  return {
    id: note.id, conversationId: note.conversationId, messageId: note.messageId,
    status: note.status, attempts: note.attempts, availableAt: iso(note.availableAt),
    leaseVersion: note.leaseVersion, stableMessageId: note.stableMessageId,
    lockedUntil: iso(note.lockedUntil), requestStartedAt: iso(note.requestStartedAt),
    lastErrorCode: note.lastErrorCode, sentAt: iso(note.sentAt),
    createdAt: iso(note.createdAt), updatedAt: iso(note.updatedAt),
    leaseHeld: note.leaseOwner !== null,
    ownerDigest: note.leaseOwner === null ? null : digest(note.leaseOwner),
    providerDigest: note.providerMessageId === null ? null : digest(note.providerMessageId),
    digest: digest(full),
  };
}
// mode 'db' reads only PostgreSQL: used inside the crash window, where an HTTP round trip would
// compete with the bounded failure window that the S4 probe is measuring.
async function snapshot(tag, cookie, bundle, mode = 'http') {
  const conversationId = bundle.received.conversationId;
  let http = null;
  if (mode === 'http') {
    const response = await getSync(cookie, conversationId);
    assert.equal(response.status, 200, `${tag}: sync failed`);
    const sync = await response.json();
    http = {
      status: sync.conversation.status, version: sync.conversation.version,
      createdAt: sync.conversation.createdAt, updatedAt: sync.conversation.updatedAt,
      lastActivityAt: sync.conversation.lastActivityAt, retainUntil: sync.conversation.retainUntil,
      anonymizedAt: sync.conversation.anonymizedAt,
      lastSeq: sync.lastSeq, nextAfterSeq: sync.nextAfterSeq, hasMore: sync.hasMore,
      readLastSeq: sync.read.lastReadSeq,
      messages: sync.messages.map((message) => ({ id: message.id, seq: message.seq, createdAt: message.createdAt })),
    };
  }
  const row = await db.chatConversation.findUniqueOrThrow({ where: { id: conversationId } });
  const messages = await db.chatMessage.findMany({ where: { conversationId }, orderBy: { seq: 'asc' } });
  const note = await db.chatNotification.findUniqueOrThrow({ where: { id: bundle.row.id } });
  const value = { http, db: conversationProjection(row, messages), outbox: outboxProjection(note) };
  seam.snapshots[tag] = value;
  return value;
}
// J2 side effects never abort the S4 sequence: a failed observation is recorded and the original
// phase continues with its own assertions untouched.
function seamCode(error) {
  const name = error instanceof Error ? error.name : '';
  return SEAM_ERROR_CODES.includes(name) ? name : 'Other';
}
async function seamStep(name, work) {
  if (!seamOn) return;
  try { await work(); seam.checks[name] = true; }
  catch (error) { seam.checks[name] = false; seam.failures.push({ name, code: seamCode(error) }); }
}
async function visitorMessage(reuse) {
  // Reusing an existing visitor session keeps the new-session IP budget for the second-visitor probe.
  let cookie = reuse?.cookie;
  if (!cookie) {
    const session = await post('/api/chat/session', { locale: 'en' });
    assert.equal(session.status, 200);
    const set = session.headers.getSetCookie().find((x) => /HttpOnly/i.test(x));
    assert.ok(set, 'session did not set HttpOnly cookie');
    await session.body?.cancel();
    cookie = set.split(';')[0];
  }
  const input = { clientConversationId: randomUUID(), clientMessageId: randomUUID(), locale: 'en', bodyText: 'm4t4-private-body-probe', email: 'm4t4-private-visitor@example.test' };
  const saved = await post('/api/chat/conversations', input, cookie);
  assert.equal(saved.status, 200);
  const received = await saved.json();
  assert.equal(received.duplicate, false);
  const replay = await post('/api/chat/conversations', input, cookie);
  assert.equal(replay.status, 200);
  const duplicated = await replay.json();
  assert.equal(duplicated.duplicate, true);
  assert.equal(duplicated.receivedAt, received.receivedAt);
  const row = await db.chatNotification.findUniqueOrThrow({ where: { messageId: received.message.id } });
  assert.equal(row.status, 'QUEUED');
  return { row, received, duplicated, cookie, input };
}
const readRow = (row) => db.chatNotification.findUniqueOrThrow({ where: { id: row.id } });
async function stats() {
  const res = await fetch('http://127.0.0.1:3998/stats', { signal: AbortSignal.timeout(5_000) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.chatEvidence?.acceptedIds));
  return body;
}
function attempts() {
  if (!fs.existsSync(`${state}/attempts.jsonl`)) return [];
  return fs.readFileSync(`${state}/attempts.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x));
}
function arm() {
  const index = attempts().length;
  const armedAt = Date.now();
  privateFile(`${state}/armed`, '1');
  return { index, armedAt };
}
// sink defaults to the S4 array: a J2 tick can never lengthen the completed S4 report.
async function tick({ index, armedAt }, expected, sink = report.ticks) {
  const entries = await until(() => { const values = attempts(); return values.length > index ? values : null; }, 120_000);
  assert.equal(entries.length, index + 1);
  const entry = entries[index];
  assert.equal(entry.status, expected);
  const elapsed = entry.at - armedAt;
  const minute = 60_000;
  const offset = entry.at % minute;
  assert.ok(elapsed >= 0 && elapsed <= minute + 5_000, 'tick missed the first minute after arming');
  assert.ok(Math.min(offset, minute - offset) <= 5_000, 'tick was not aligned to a real minute');
  sink.push({ at: entry.at, status: entry.status, armedAt });
}

// J2-B: one isolated transient refusal for its own first message, then the cross-visitor negative.
// Runs only after the S4 report is final; failures here set the process exit code, never report.pass.
async function seamTail(bundle) {
  const { crashVisitor, crashBefore, crashRow, leasedRow, unknownRow, recovered } = bundle;
  seam.stage = 'transient-451';
  seam.provenance = { commit: report.sourceCommit, tree: report.sourceTree, buildId: report.buildId };
  seam.env = {
    platform: process.platform, node: process.version,
    database: null, pgServerVersionNum: null, pgMajor: null, pg17: false,
  };
  // The crash window is over and the S4 receipt is on disk. These three projections are built from the
  // rows the S4 timed path itself read, so they cost no query and cannot move a minute: each is the
  // state the probe observed at that tick, never a late re-read of a later state.
  await seamStep('b1-leased-db', async () => {
    const outbox = outboxProjection(leasedRow);
    seam.snapshots['crash:killed'] = { http: null, db: null, outbox };
    assert.equal(outbox.status, 'SENDING');
    assert.equal(outbox.attempts, 1);
    assert.equal(outbox.stableMessageId, crashRow.stableMessageId);
    assert.notEqual(outbox.requestStartedAt, null);
    assert.equal(outbox.leaseHeld, true);
    assert.notEqual(outbox.lockedUntil, null);
    assert.equal(outbox.providerDigest, null);
    assert.equal(outbox.sentAt, null);
    assert.equal(outbox.lastErrorCode, null);
  });
  await seamStep('b1-unknown-db', async () => {
    const outbox = outboxProjection(unknownRow);
    seam.snapshots['crash:unknown'] = { http: null, db: null, outbox };
    assert.equal(outbox.status, 'UNKNOWN');
    assert.equal(outbox.attempts, 1);
    assert.equal(outbox.lastErrorCode, 'CHAT_WORKER_UNKNOWN');
    assert.equal(outbox.leaseHeld, false);
  });
  await seamStep('b1-sent2-db', async () => {
    const outbox = outboxProjection(recovered);
    seam.snapshots['crash:sent-2'] = { http: null, db: null, outbox };
    assert.equal(outbox.status, 'SENT');
    assert.equal(outbox.attempts, 2);
    assert.equal(outbox.stableMessageId, crashRow.stableMessageId);
    assert.equal(outbox.leaseHeld, false);
    assert.notEqual(outbox.sentAt, null);
    assert.equal(outbox.lastErrorCode, null);
  });
  // The conversation, its messages and the read cursor are read once, after the S4 receipt is on disk:
  // what they support is "unchanged across the crash window" (a write inside the window would still be
  // visible here), not "observed at the killed instant". No time-sensitive claim is attached to them.
  await seamStep('b1-http-after-recovery', async () => {
    assert.ok(crashBefore, 'missing the crash baseline');
    const after = await snapshot('after-s4', crashVisitor.cookie, crashVisitor);
    assertHttpStable('after-s4', crashBefore, after);
    assertDbStable('after-s4', crashBefore, after);
    assertReadUnchanged('after-s4', crashBefore, after);
    assert.equal(after.http.messages.length, 1);
    assert.equal(after.http.messages[0].id, crashRow.messageId);
  });
  // The accepted error vocabulary is read from the product source instead of being guessed from a
  // prefix: the artifact may only carry a code the product itself can write, and a list that cannot be
  // read, parsed or trusted fails the seam before any snapshot is projected.
  await seamStep('f2-error-codes', async () => {
    const codes = readNotificationErrorCodes();
    assert.ok(Array.isArray(NOTIFICATION_ERROR_CODES), 'the product vocabulary was not loaded at startup');
    assert.deepEqual(codes, NOTIFICATION_ERROR_CODES, 'the product vocabulary changed during the run');
    seam.facts.errorCodes = { count: codes.length };
  });
  // §17 identity is a J2 diagnostic and runs only here, after the S4 result is final: a failed query
  // is a J2 failure and can never shorten or abort the S4 sequence.
  await seamStep('f1-db-identity', async () => {
    const [row] = await db.$queryRaw`
      SELECT current_database() AS db, current_setting('server_version_num')::int AS num,
        host(inet_server_addr()) AS host, inet_server_port() AS port`;
    assert.equal(row.db, 'mail_evidence', 'the J2 database is not the reviewed one');
    assert.equal(row.host, '127.0.0.1', 'the J2 connection is not loopback');
    assert.equal(Number(row.port), 5432, 'the J2 connection is not the private instance port');
    const num = Number(row.num);
    assert.ok(Number.isInteger(num) && num >= 100_000 && num < 200_000, 'server_version_num is not a plausible version');
    seam.env.database = row.db;
    seam.env.pgServerVersionNum = num;
    seam.env.pgMajor = Math.floor(num / 10_000);
    seam.env.pg17 = seam.env.pgMajor === 17;
    seam.facts.dbIdentity = {
      database: row.db, host: row.host, port: Number(row.port),
      pgServerVersionNum: num, pgMajor: seam.env.pgMajor,
    };
  });
  // Fail closed: the J2 evidence only passes on the same instance running PostgreSQL 17.
  await seamStep('f1-pg17', async () => {
    assert.ok(seam.facts.dbIdentity, 'the database identity was not recorded');
    assert.equal(seam.facts.dbIdentity.pgMajor, 17, 'the J2 database is not PostgreSQL 17');
    assert.equal(seam.env.pg17, true);
  });
  await stop(); await start();
  const transientVisitor = await visitorMessage(crashVisitor);
  const transientRow = transientVisitor.row;
  let sinkAtArm = null;
  let tickEntry = null;

  await seamStep('c1-target-baseline', async () => {
    const before = await snapshot('transient:before', transientVisitor.cookie, transientVisitor);
    assert.equal(before.outbox.status, 'QUEUED');
    assert.equal(before.outbox.attempts, 0);
    assert.equal(before.http.readLastSeq, 0);
    assert.equal(before.http.lastSeq, 1);
  });
  // Exactly one claimable row, exactly one refusal armed: the 451 cannot land on another message,
  // and no lease sweep or UNKNOWN promotion can run in the same tick.
  await seamStep('c1-single-target', async () => {
    const statuses = await db.chatNotification.groupBy({ by: ['status'], _count: { _all: true } });
    seam.facts.statusCounts = Object.fromEntries(statuses.map((row) => [row.status, row._count._all]));
    const queued = await db.chatNotification.findMany({ where: { status: 'QUEUED' }, select: { id: true, attempts: true, availableAt: true } });
    assert.equal(queued.length, 1, 'more than one claimable notification exists');
    assert.equal(queued[0].id, transientRow.id, 'the single claimable row is not the 451 target');
    assert.equal(queued[0].attempts, 0);
    assert.ok(queued[0].availableAt.getTime() <= Date.now(), 'the 451 target is not due');
    assert.equal(await db.chatNotification.count({ where: { status: { in: ['SENDING', 'UNKNOWN'] } } }), 0, 'a sweep or promote candidate exists');
  });
  // A failed uniqueness check ends J2 before any refusal is armed: the completed S4 result stays.
  if (!seam.checks['c1-single-target']) throw new Error('J2_TARGET_NOT_UNIQUE');
  await seamStep('c1-arm-clean', async () => {
    const beforeArm = await stats();
    assert.equal(beforeArm.chatEvidence.rcptRemaining, 0, 'a refusal was already armed');
    const armed = await sinkControl('/chat/rcpt-1');
    assert.equal(armed.status, 200, 'the sink refused to arm the controlled 451');
    assert.equal(armed.body?.armed, true);
    sinkAtArm = await stats();
    assert.equal(sinkAtArm.chatEvidence.rcptRemaining, 1);
  });
  if (!seam.checks['c1-arm-clean']) throw new Error('J2_ARM_FAILED');
  const jobBefore = (await db.jobState.findUniqueOrThrow({ where: { key } })).generation;
  await seamStep('c1-tick-minute', async () => {
    await tick(arm(), 200, seam.ticks);
    assert.equal(seam.ticks.length, 1);
    tickEntry = seam.ticks[0];
  });
  await seamStep('c1-job-state', async () => {
    assert.ok(tickEntry, 'missing the observed tick');
    const job = await db.jobState.findUniqueOrThrow({ where: { key } });
    assert.equal(job.generation, jobBefore + 1);
    assert.equal(job.lastStatus, 'SUCCEEDED');
    assert.equal(job.leaseOwner, null);
    assert.equal(job.lockedUntil, null, 'the JobState lease was not released');
    assert.equal(job.lastErrorCode, null);
    // The success instant must belong to this tick, not to an older run that a stale row still carries.
    assert.ok(job.lastSucceededAt instanceof Date, 'missing lastSucceededAt');
    assert.ok(job.lastSucceededAt.getTime() >= tickEntry.at - 2_000, 'lastSucceededAt predates the observed tick');
    assert.ok(job.lastSucceededAt.getTime() <= Date.now() + 1_000, 'lastSucceededAt is in the future');
    assert.ok(job.lastFinishedAt instanceof Date, 'missing lastFinishedAt');
    assert.ok(job.lastFinishedAt.getTime() >= job.lastSucceededAt.getTime() - 1, 'lastFinishedAt predates the success');
    assert.deepEqual(job.summary.counts, { candidateCount: 1, sent: 0, failed: 0, deferred: 1, dropped: 0, stale: 0 });
    seam.facts.transientJob = {
      generationBefore: jobBefore, generationAfter: job.generation, status: job.lastStatus,
      lastSucceededAt: iso(job.lastSucceededAt), lastFinishedAt: iso(job.lastFinishedAt),
      leaseReleased: job.leaseOwner === null && job.lockedUntil === null,
      counts: job.summary.counts,
    };
  });
  await seamStep('c1-sink-deltas', async () => {
    assert.ok(sinkAtArm, 'missing the armed sink baseline');
    const after = await stats();
    assert.equal(after.rcptAttempts - sinkAtArm.rcptAttempts, 1, 'the tick did not make exactly one RCPT attempt');
    assert.equal(after.rcptFailures - sinkAtArm.rcptFailures, 1, 'the controlled 451 did not fire exactly once');
    assert.equal(after.received - sinkAtArm.received, 0, 'a refused notification was accepted');
    assert.deepEqual(after.chatEvidence.acceptedIds, sinkAtArm.chatEvidence.acceptedIds, 'an extra message was accepted');
    assert.equal(after.chatEvidence.rcptRemaining, 0);
    seam.facts.sink = {
      rcptAttempts: after.rcptAttempts - sinkAtArm.rcptAttempts,
      rcptFailures: after.rcptFailures - sinkAtArm.rcptFailures,
      received: after.received - sinkAtArm.received,
    };
  });
  await seamStep('c1-row-retry-scheduled', async () => {
    const row = await readRow(transientRow);
    assert.equal(row.id, transientRow.id);
    assert.equal(row.messageId, transientVisitor.received.message.id);
    assert.equal(row.conversationId, transientVisitor.received.conversationId);
    assert.equal(row.stableMessageId, transientRow.stableMessageId);
    assert.equal(row.status, 'QUEUED');
    assert.equal(row.attempts, 1);
    assert.equal(row.lastErrorCode, 'CHAT_SMTP_TEMPORARY');
    assert.equal(row.leaseOwner, null);
    assert.equal(row.lockedUntil, null);
    assert.notEqual(row.requestStartedAt, null);
    assert.equal(row.providerMessageId, null);
    assert.equal(row.sentAt, null);
    const tier = row.availableAt.getTime() - row.updatedAt.getTime();
    assert.ok(tier >= 59_000 && tier <= 61_000, `the backoff tier is ${tier}ms, expected the one minute tier`);
    const fromTick = row.availableAt.getTime() - (tickEntry ? tickEntry.at : 0);
    assert.ok(fromTick >= 55_000 && fromTick <= 66_000, `availableAt is ${fromTick}ms from the observed tick`);
    assert.ok(tickEntry && row.updatedAt.getTime() >= tickEntry.at, 'the retry row was not written inside the observed tick');
    assert.ok(row.updatedAt.getTime() <= Date.now() + 1_000, 'the retry row updatedAt is in the future');
    assert.equal(await db.chatNotification.count({ where: { messageId: transientVisitor.received.message.id } }), 1);
    seam.facts.transient = {
      status: row.status, attempts: row.attempts, code: row.lastErrorCode,
      tierMs: tier, fromTickMs: fromTick, leaseReleased: true, updatedAt: iso(row.updatedAt),
    };
  });
  await seamStep('c1-domain', async () => {
    const before = seam.snapshots['transient:before'];
    assert.ok(before, 'missing the transient baseline');
    const after = await snapshot('transient:after', transientVisitor.cookie, transientVisitor);
    assertHttpStable('transient:451', before, after);
    assertDbStable('transient:451', before, after);
    assertReadUnchanged('transient:451', before, after);
    assert.equal(after.http.messages[0].id, transientVisitor.received.message.id);
  });

  // J2-A/B: a second visitor shares the same email but must not read or mark read on the first
  // visitor's conversation, whose cursor is still 0 and whose only message is still unread.
  seam.stage = 'second-visitor';
  const secondVisitor = await visitorMessage();
  let crossBefore = null;
  await seamStep('d1-own-read', async () => {
    const own = await getSync(secondVisitor.cookie, secondVisitor.received.conversationId);
    assert.equal(own.status, 200);
    const body = await own.json();
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].id, secondVisitor.received.message.id);
    assert.equal(body.read.lastReadSeq, 0);
    crossBefore = await snapshot('a:before-cross', transientVisitor.cookie, transientVisitor);
    assert.equal(crossBefore.http.readLastSeq, 0, 'the cross-visitor target is already read');
    assert.equal(crossBefore.http.lastSeq, 1);
    assert.equal(crossBefore.db.visitorReadSeq, 0);
  });
  await seamStep('d1-cross-404', async () => {
    assert.ok(crossBefore, 'missing the cross-visitor baseline');
    const crossGet = await getSync(secondVisitor.cookie, transientVisitor.received.conversationId);
    assert.equal(crossGet.status, 404);
    await crossGet.body?.cancel();
    const crossRead = await markRead(secondVisitor.cookie, transientVisitor.received.conversationId, 1);
    assert.equal(crossRead.status, 404);
    await crossRead.body?.cancel();
    const after = await snapshot('a:after-cross', transientVisitor.cookie, transientVisitor);
    assertHttpStable('a:cross', crossBefore, after);
    assertDbStable('a:cross', crossBefore, after);
    assertReadUnchanged('a:cross', crossBefore, after);
    assertOutboxStable('a:cross', crossBefore, after);
    assert.equal(after.http.readLastSeq, 0, 'a cross-visitor read moved the owner cursor');
    assert.equal(after.db.visitorReadSeq, 0, 'a cross-visitor read reached PostgreSQL');
    seam.facts.crossVisitor = { targetSeq: 1, get: 404, read: 404, readAfter: 0 };
  });
  await seamStep('d1-owner-advance', async () => {
    const read = await markRead(transientVisitor.cookie, transientVisitor.received.conversationId, 1);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { lastReadSeq: 1 });
    const after = await snapshot('a:after-owner-read', transientVisitor.cookie, transientVisitor);
    assertConversationExceptRead('a:owner-read', seam.snapshots['a:after-cross'], after);
    assertOutboxStable('a:owner-read', seam.snapshots['a:after-cross'], after);
    assert.equal(after.http.readLastSeq, 1);
    assert.equal(after.db.visitorReadSeq, 1);
  });

  await seamStep('e1-single-post-per-arm', async () => {
    assert.equal(report.ticks.length, 5, 'the S4 report no longer holds exactly five ticks');
    assert.equal(seam.ticks.length, 1, 'the J2 tick is not isolated');
    assert.equal(attempts().length, report.ticks.length + seam.ticks.length, 'an unarmed tick or a second post is present');
  });
  await seamStep('e1-no-private-markers', async () => { assertSafe('seam', seam); });

  const recorded = Object.keys(seam.checks);
  const missing = SEAM_GROUPS.filter((name) => !(name in seam.checks));
  const failed = recorded.filter((name) => seam.checks[name] !== true);
  const extra = recorded.filter((name) => !SEAM_GROUPS.includes(name));
  seam.counts = {
    groups: SEAM_GROUPS.length, recorded: recorded.length,
    failed: failed.length, missing: missing.length, extra: extra.length, failures: seam.failures.length,
  };
  seam.pass = missing.length === 0 && failed.length === 0 && extra.length === 0 && seam.failures.length === 0;
  seam.stage = seam.pass ? 'complete' : 'failed';
}

// The artifact is built through typed builders: every published field has a fixed type, enum or
// format. Anything else makes the whole projection fail closed into a minimal failure receipt, so a
// generic string can never reach the file through a provider value, a DTO field or an error name.
const SEAM_TAGS = [
  'default:after-replay', 'default:after-conflict', 'default:before-notification', 'default:after-sent',
  'default:after-read', 'default:after-repeat-read',
  'crash:before-notification', 'crash:killed', 'crash:unknown', 'crash:sent-2',
  'after-s4', 'transient:before', 'transient:after',
  'a:before-cross', 'a:after-cross', 'a:after-owner-read',
];
const CONVERSATION_STATUS = ['OPEN', 'CLOSED'];
const NOTIFICATION_STATUS = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'DISABLED'];
const REQUEST_PATHS = ['/api/chat/conversations/[id]', '/api/chat/conversations/[id]/read'];
const FINALIZE_CODES = ['stop', 'disconnect', 's4-report', 'seam-report'];
const TICK_STATUS = [0, 200, 409];
const REPORT_STATES = ['complete', 'rejected'];
const isBool = (value) => value === true || value === false;
const isInt = (value) => Number.isSafeInteger(value);
const isUuid = (value) => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const isHex = (length) => (value) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const isIso = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const oneOf = (values) => (value) => values.includes(value);
const nullable = (check) => (value) => value === null || check(value);
const isSlug = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const isLocale = (value) => typeof value === 'string' && /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/.test(value);
const isStableMessageId = (value) => typeof value === 'string' && /^[0-9a-f-]{36}@chat\.packjoyu$/.test(value);
// The product's own notification error vocabulary is the only accepted set. It is read from
// src/lib/server/chat/notification-policy.ts instead of being inferred from a prefix, so a synthetic
// code can never reach the artifact and a drifted product list fails the seam rather than silently
// widening this gate. It loads as soon as the seam is opted in, before any snapshot exists; the J2 tail
// repeats the same read as a checked group.
let NOTIFICATION_ERROR_CODES = null;
function readNotificationErrorCodes() {
  const source = fs.readFileSync('src/lib/server/chat/notification-policy.ts', 'utf8');
  const start = source.indexOf('export const CHAT_NOTIFICATION_SAFE_CODES = [');
  if (start < 0) throw new Error('NOTIFICATION_CODE_LIST_MISSING');
  const end = source.indexOf('] as const;', start);
  if (end <= start) throw new Error('NOTIFICATION_CODE_LIST_UNTERMINATED');
  const codes = [...source.slice(start, end).matchAll(/'([^'\\\r\n]{1,64})'/g)].map((match) => match[1]);
  if (!codes.includes('CHAT_WORKER_UNKNOWN')) throw new Error('NOTIFICATION_CODE_LIST_UNREADABLE');
  if (codes.length < 10 || codes.length > 32) throw new Error('NOTIFICATION_CODE_COUNT');
  if (new Set(codes).size !== codes.length) throw new Error('NOTIFICATION_CODE_LIST_REPEATED');
  return codes;
}
if (seamOn) {
  try { NOTIFICATION_ERROR_CODES = readNotificationErrorCodes(); }
  catch { /* the J2 tail reports the same read as f2-error-codes */ }
}
const isErrorCode = (value) => typeof value === 'string'
  && NOTIFICATION_ERROR_CODES !== null && NOTIFICATION_ERROR_CODES.includes(value);
const isBuildId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isNodeVersion = (value) => typeof value === 'string' && /^v\d+\.\d+\.\d+$/.test(value);
const isStage = oneOf(SEAM_STAGES);
const isAbsent = (value) => value === null || value === undefined || (typeof value === 'object' && Object.keys(value).length === 0);

function tBool(value, field) {
  if (!isBool(value)) throw new Error(`PAYLOAD_BOOL:${field}`);
  return value;
}
function tInt(value, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!isInt(value) || value < min || value > max) throw new Error(`PAYLOAD_INT:${field}`);
  return value;
}
function tStr(value, field, check) {
  if (!check(value)) throw new Error(`PAYLOAD_STR:${field}`);
  return value;
}
function tIntOrNull(value, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return value === null ? null : tInt(value, field, min, max);
}
function tList(value, field, build, limit = 64) {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`PAYLOAD_LIST:${field}`);
  return value.map((item, index) => build(item, index));
}
function typedCounts(value) {
  return {
    candidateCount: tInt(value.candidateCount, 'counts.candidateCount'),
    sent: tInt(value.sent, 'counts.sent'),
    failed: tInt(value.failed, 'counts.failed'),
    deferred: tInt(value.deferred, 'counts.deferred'),
    dropped: tInt(value.dropped, 'counts.dropped'),
    stale: tInt(value.stale, 'counts.stale'),
  };
}
function typedHttp(http, tag) {
  if (http === null) return null;
  if (typeof http !== 'object') throw new Error(`PAYLOAD_HTTP:${tag}`);
  return {
    status: tStr(http.status, `${tag}.status`, oneOf(CONVERSATION_STATUS)),
    version: tInt(http.version, `${tag}.version`),
    createdAt: tStr(http.createdAt, `${tag}.createdAt`, isIso),
    updatedAt: tStr(http.updatedAt, `${tag}.updatedAt`, isIso),
    lastActivityAt: tStr(http.lastActivityAt, `${tag}.lastActivityAt`, isIso),
    retainUntil: tStr(http.retainUntil, `${tag}.retainUntil`, isIso),
    anonymizedAt: tStr(http.anonymizedAt, `${tag}.anonymizedAt`, nullable(isIso)),
    lastSeq: tInt(http.lastSeq, `${tag}.lastSeq`),
    nextAfterSeq: tInt(http.nextAfterSeq, `${tag}.nextAfterSeq`),
    hasMore: tBool(http.hasMore, `${tag}.hasMore`),
    readLastSeq: tInt(http.readLastSeq, `${tag}.readLastSeq`),
    messages: tList(http.messages, `${tag}.messages`, (message, index) => ({
      id: tStr(message.id, `${tag}.messages[${index}].id`, isUuid),
      seq: tInt(message.seq, `${tag}.messages[${index}].seq`),
      createdAt: tStr(message.createdAt, `${tag}.messages[${index}].createdAt`, isIso),
    })),
  };
}
function typedDb(db, tag) {
  return {
    id: tStr(db.id, `${tag}.id`, isUuid),
    status: tStr(db.status, `${tag}.status`, oneOf(CONVERSATION_STATUS)),
    version: tInt(db.version, `${tag}.version`),
    lastSeq: tInt(db.lastSeq, `${tag}.lastSeq`),
    visitorReadSeq: tInt(db.visitorReadSeq, `${tag}.visitorReadSeq`),
    createdAt: tStr(db.createdAt, `${tag}.createdAt`, isIso),
    updatedAt: tStr(db.updatedAt, `${tag}.updatedAt`, isIso),
    lastActivityAt: tStr(db.lastActivityAt, `${tag}.lastActivityAt`, isIso),
    retainUntil: tStr(db.retainUntil, `${tag}.retainUntil`, isIso),
    anonymizedAt: tStr(db.anonymizedAt, `${tag}.anonymizedAt`, nullable(isIso)),
    locale: tStr(db.locale, `${tag}.locale`, isLocale),
    productSlug: tStr(db.productSlug, `${tag}.productSlug`, nullable(isSlug)),
    identityDigest: tStr(db.identityDigest, `${tag}.identityDigest`, isHex(64)),
    messageCount: tInt(db.messageCount, `${tag}.messageCount`),
    messageDigest: tStr(db.messageDigest, `${tag}.messageDigest`, isHex(64)),
  };
}
function typedOutbox(outbox, tag) {
  return {
    id: tStr(outbox.id, `${tag}.id`, isUuid),
    conversationId: tStr(outbox.conversationId, `${tag}.conversationId`, isUuid),
    messageId: tStr(outbox.messageId, `${tag}.messageId`, isUuid),
    status: tStr(outbox.status, `${tag}.status`, oneOf(NOTIFICATION_STATUS)),
    attempts: tInt(outbox.attempts, `${tag}.attempts`),
    availableAt: tStr(outbox.availableAt, `${tag}.availableAt`, isIso),
    leaseVersion: tInt(outbox.leaseVersion, `${tag}.leaseVersion`),
    stableMessageId: tStr(outbox.stableMessageId, `${tag}.stableMessageId`, isStableMessageId),
    lockedUntil: tStr(outbox.lockedUntil, `${tag}.lockedUntil`, nullable(isIso)),
    requestStartedAt: tStr(outbox.requestStartedAt, `${tag}.requestStartedAt`, nullable(isIso)),
    lastErrorCode: tStr(outbox.lastErrorCode, `${tag}.lastErrorCode`, nullable(isErrorCode)),
    sentAt: tStr(outbox.sentAt, `${tag}.sentAt`, nullable(isIso)),
    createdAt: tStr(outbox.createdAt, `${tag}.createdAt`, isIso),
    updatedAt: tStr(outbox.updatedAt, `${tag}.updatedAt`, isIso),
    leaseHeld: tBool(outbox.leaseHeld, `${tag}.leaseHeld`),
    ownerDigest: tStr(outbox.ownerDigest, `${tag}.ownerDigest`, nullable(isHex(64))),
    providerDigest: tStr(outbox.providerDigest, `${tag}.providerDigest`, nullable(isHex(64))),
    digest: tStr(outbox.digest, `${tag}.digest`, isHex(64)),
  };
}
// The crash tags publish only the outbox projection of a row the S4 probe already read; every other tag
// must carry its conversation projection, so a dropped domain read cannot pass as a valid snapshot.
const ROW_ONLY_TAGS = ['crash:killed', 'crash:unknown', 'crash:sent-2'];
function typedSnapshots(snapshots) {
  const out = {};
  for (const tag of Object.keys(snapshots)) {
    if (!SEAM_TAGS.includes(tag)) throw new Error(`PAYLOAD_TAG:${tag}`);
    const value = snapshots[tag];
    if (value.db === null && !ROW_ONLY_TAGS.includes(tag)) throw new Error(`PAYLOAD_DB:${tag}`);
    out[tag] = {
      http: typedHttp(value.http, tag),
      db: value.db === null ? null : typedDb(value.db, tag),
      outbox: typedOutbox(value.outbox, tag),
    };
  }
  return out;
}
function typedChecks(checks) {
  const out = {};
  for (const name of Object.keys(checks)) {
    if (!SEAM_GROUPS.includes(name)) throw new Error(`PAYLOAD_CHECK:${name}`);
    out[name] = tBool(checks[name], `checks.${name}`);
  }
  return out;
}
function typedFacts(facts) {
  const out = {};
  if (facts.statusCounts) {
    out.statusCounts = {};
    for (const [status, count] of Object.entries(facts.statusCounts)) {
      if (!NOTIFICATION_STATUS.includes(status)) throw new Error(`PAYLOAD_STATUS:${status}`);
      out.statusCounts[status] = tInt(count, `statusCounts.${status}`);
    }
  }
  if (facts.sink) {
    out.sink = {
      rcptAttempts: tInt(facts.sink.rcptAttempts, 'sink.rcptAttempts'),
      rcptFailures: tInt(facts.sink.rcptFailures, 'sink.rcptFailures'),
      received: tInt(facts.sink.received, 'sink.received'),
    };
  }
  if (facts.transient) {
    out.transient = {
      status: tStr(facts.transient.status, 'transient.status', oneOf(NOTIFICATION_STATUS)),
      attempts: tInt(facts.transient.attempts, 'transient.attempts'),
      code: tStr(facts.transient.code, 'transient.code', nullable(isErrorCode)),
      tierMs: tInt(facts.transient.tierMs, 'transient.tierMs'),
      fromTickMs: tInt(facts.transient.fromTickMs, 'transient.fromTickMs'),
      leaseReleased: tBool(facts.transient.leaseReleased, 'transient.leaseReleased'),
      updatedAt: tStr(facts.transient.updatedAt, 'transient.updatedAt', isIso),
    };
  }
  if (facts.transientJob) {
    out.transientJob = {
      generationBefore: tInt(facts.transientJob.generationBefore, 'transientJob.generationBefore'),
      generationAfter: tInt(facts.transientJob.generationAfter, 'transientJob.generationAfter'),
      status: tStr(facts.transientJob.status, 'transientJob.status', oneOf(['SUCCEEDED'])),
      lastSucceededAt: tStr(facts.transientJob.lastSucceededAt, 'transientJob.lastSucceededAt', isIso),
      lastFinishedAt: tStr(facts.transientJob.lastFinishedAt, 'transientJob.lastFinishedAt', isIso),
      leaseReleased: tBool(facts.transientJob.leaseReleased, 'transientJob.leaseReleased'),
      counts: typedCounts(facts.transientJob.counts),
    };
  }
  if (facts.crossVisitor) {
    out.crossVisitor = {
      targetSeq: tInt(facts.crossVisitor.targetSeq, 'crossVisitor.targetSeq'),
      get: tInt(facts.crossVisitor.get, 'crossVisitor.get', 100, 599),
      read: tInt(facts.crossVisitor.read, 'crossVisitor.read', 100, 599),
      readAfter: tInt(facts.crossVisitor.readAfter, 'crossVisitor.readAfter'),
    };
  }
  if (facts.dbIdentity) {
    out.dbIdentity = {
      database: tStr(facts.dbIdentity.database, 'dbIdentity.database', oneOf(['mail_evidence'])),
      host: tStr(facts.dbIdentity.host, 'dbIdentity.host', oneOf(['127.0.0.1'])),
      port: tInt(facts.dbIdentity.port, 'dbIdentity.port', 1, 65_535),
      pgServerVersionNum: tInt(facts.dbIdentity.pgServerVersionNum, 'dbIdentity.pgServerVersionNum', 100_000, 199_999),
      pgMajor: tInt(facts.dbIdentity.pgMajor, 'dbIdentity.pgMajor', 10, 19),
    };
  }
  if (facts.errorCodes) {
    out.errorCodes = { count: tInt(facts.errorCodes.count, 'errorCodes.count', 1, 64) };
  }
  if (facts.s4Receipt) {
    out.s4Receipt = {
      persisted: tBool(facts.s4Receipt.persisted, 's4Receipt.persisted'),
      sha256: tStr(facts.s4Receipt.sha256, 's4Receipt.sha256', isHex(64)),
      ticks: tInt(facts.s4Receipt.ticks, 's4Receipt.ticks'),
    };
  }
  return out;
}
function typedRequests(requests) {
  return tList(requests, 'requests', (item) => ({
    method: tStr(item.method, 'request.method', oneOf(['GET', 'POST'])),
    path: tStr(item.path, 'request.path', oneOf(REQUEST_PATHS)),
    status: tInt(item.status, 'request.status', 100, 599),
    ...(item.afterSeq === undefined ? {} : { afterSeq: tInt(item.afterSeq, 'request.afterSeq') }),
  }), 128);
}
function typedTicks(ticks) {
  return tList(ticks, 'ticks', (tick) => ({
    at: tInt(tick.at, 'tick.at'),
    status: tInt(tick.status, 'tick.status', 0, 599),
    armedAt: tInt(tick.armedAt, 'tick.armedAt'),
  }), 8).map((tick, index) => {
    if (!TICK_STATUS.includes(tick.status)) throw new Error(`PAYLOAD_TICK:${index}`);
    return tick;
  });
}
function typedReceipts(receipts) {
  const out = {};
  if (receipts.conflict) {
    out.conflict = {
      status: tInt(receipts.conflict.status, 'conflict.status', 400, 499),
      error: tStr(receipts.conflict.error, 'conflict.error', oneOf(['idempotency_conflict'])),
      field: tStr(receipts.conflict.field, 'conflict.field', oneOf(['clientConversationId'])),
      requestIdUuid: tBool(receipts.conflict.requestIdUuid, 'conflict.requestIdUuid'),
    };
  }
  if (receipts.firstWrite) {
    out.firstWrite = {
      conversationId: tStr(receipts.firstWrite.conversationId, 'firstWrite.conversationId', isUuid),
      messageId: tStr(receipts.firstWrite.messageId, 'firstWrite.messageId', isUuid),
      seq: tInt(receipts.firstWrite.seq, 'firstWrite.seq'),
      receivedAt: tStr(receipts.firstWrite.receivedAt, 'firstWrite.receivedAt', isIso),
      duplicate: tBool(receipts.firstWrite.duplicate, 'firstWrite.duplicate'),
    };
  }
  if (receipts.replay) {
    out.replay = {
      duplicate: tBool(receipts.replay.duplicate, 'replay.duplicate'),
      sameConversation: tBool(receipts.replay.sameConversation, 'replay.sameConversation'),
      sameMessage: tBool(receipts.replay.sameMessage, 'replay.sameMessage'),
      sameSeq: tBool(receipts.replay.sameSeq, 'replay.sameSeq'),
      sameReceivedAt: tBool(receipts.replay.sameReceivedAt, 'replay.sameReceivedAt'),
    };
  }
  return out;
}
function typedEnv(env) {
  return {
    platform: tStr(env.platform, 'env.platform', oneOf(['linux'])),
    node: tStr(env.node, 'env.node', isNodeVersion),
    database: tStr(env.database, 'env.database', nullable(oneOf(['mail_evidence']))),
    pgServerVersionNum: tIntOrNull(env.pgServerVersionNum, 'env.pgServerVersionNum', 0, 199_999),
    pgMajor: tIntOrNull(env.pgMajor, 'env.pgMajor', 0, 19),
    pg17: tBool(env.pg17, 'env.pg17'),
  };
}
function typedProvenance(provenance) {
  return {
    commit: tStr(provenance.commit, 'provenance.commit', isHex(40)),
    tree: tStr(provenance.tree, 'provenance.tree', isHex(40)),
    buildId: tStr(provenance.buildId, 'provenance.buildId', isBuildId),
  };
}
function typedSummary(counts) {
  return {
    groups: tInt(counts.groups, 'counts.groups'),
    recorded: tInt(counts.recorded, 'counts.recorded'),
    failed: tInt(counts.failed, 'counts.failed'),
    missing: tInt(counts.missing, 'counts.missing'),
    extra: tInt(counts.extra, 'counts.extra'),
    failures: tInt(counts.failures, 'counts.failures'),
  };
}
function typedFinalize(codes) {
  return tList(codes, 'finalizeFailures', (code) => tStr(code, 'finalize', oneOf(FINALIZE_CODES)), 8);
}
function minimalSeamReceipt(phaseReport, finalizeFailures) {
  const stage = SEAM_STAGES.includes(phaseReport?.stage) ? phaseReport.stage : null;
  const codes = Array.isArray(finalizeFailures) ? finalizeFailures.filter((code) => FINALIZE_CODES.includes(code)) : [];
  return {
    pass: false, reportState: 'rejected', stage: 'failed',
    failedAtPhaseStage: stage, finalizeFailures: codes,
  };
}
function seamPayload(current, phaseReport, finalizeFailures) {
  try {
    const payload = {
      pass: current.pass === true && finalizeFailures.length === 0,
      reportState: tStr('complete', 'reportState', oneOf(REPORT_STATES)),
      stage: tStr(current.stage, 'stage', isStage),
      failedAtPhaseStage: tStr(current.failedAtPhaseStage ?? null, 'failedAtPhaseStage', nullable(isStage)),
      provenance: isAbsent(current.provenance) ? null : typedProvenance(current.provenance),
      env: isAbsent(current.env) ? null : typedEnv(current.env),
      counts: isAbsent(current.counts) ? null : typedSummary(current.counts),
      facts: typedFacts(current.facts ?? {}),
      checks: typedChecks(current.checks ?? {}),
      failures: tList(current.failures ?? [], 'failures', (failure) => ({
        name: tStr(failure.name, 'failure.name', (value) => SEAM_GROUPS.includes(value) || value === 'seam-tail'),
        code: tStr(failure.code, 'failure.code', oneOf(SEAM_ERROR_CODES)),
      }), 64),
      ticks: typedTicks(current.ticks ?? []),
      requests: typedRequests(current.requests ?? []),
      receipts: typedReceipts(current.receipts ?? {}),
      snapshots: typedSnapshots(current.snapshots ?? {}),
      finalizeFailures: typedFinalize(finalizeFailures),
    };
    assertSafe('seam payload', payload);
    return payload;
  } catch {
    return minimalSeamReceipt(phaseReport, finalizeFailures);
  }
}

try {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.SMTP_EVIDENCE_MODE, 'http-real');
  assert.ok(process.getuid() > 0 && process.env.CRON_SECRET?.length >= 32);
  const owner = JSON.parse(fs.readFileSync(`${process.env.SMTP_EVIDENCE_ROOT}/owner.json`, 'utf8'));
  assert.notEqual(fs.readlinkSync('/proc/self/ns/net'), owner.hostNetNamespace);
  assert.notEqual(fs.readlinkSync('/proc/self/ns/pid'), owner.hostPidNamespace);
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/mail_evidence');
  const provenance = JSON.parse(fs.readFileSync(`${artifact}/runtime-provenance.json`, 'utf8'));
  assert.equal(provenance.sourceCommit, process.env.GITHUB_SHA);
  assert.equal(provenance.sourceTree, execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim());
  Object.assign(report, { sourceCommit: provenance.sourceCommit, sourceTree: provenance.sourceTree, buildId: provenance.buildId });
  const deploy = fs.readFileSync('deploy/cron.nbshiyan', 'utf8').split(/\r?\n/).filter((s) => s.startsWith('* * * * * root ') && s.includes("jobKey:'chat-notifications'"));
  assert.equal(deploy.length, 1); assert.match(deploy[0], /\/api\/admin\/cron\/operations/); assert.match(deploy[0], /AbortSignal\.timeout\(55000\)/);
  db = new PrismaClient();
  privateFile(`${state}/secret`, process.env.CRON_SECRET);
  report.stage = 'default';
  await start();
  const unauth = await post('/api/admin/cron/operations', { jobKey: key });
  assert.equal(unauth.status, 401); await unauth.body?.cancel();
  const defaultVisitor = await visitorMessage();
  const defaultRow = defaultVisitor.row;
  let defaultBefore = null;

  // J2-A: a changed payload under the same ids is a typed conflict and persists nothing. The
  // baseline is the successful replay, taken before the conflict request.
  await seamStep('a1-conflict-rejected', async () => {
    const before = await snapshot('default:after-replay', defaultVisitor.cookie, defaultVisitor);
    assert.equal(before.outbox.status, 'QUEUED');
    assert.equal(before.outbox.attempts, 0);
    assert.equal(before.db.messageCount, 1);
    assert.equal(before.http.readLastSeq, 0);
    const conflict = await post('/api/chat/conversations', { ...defaultVisitor.input, bodyText: 'm4t4-private-body-conflict' }, defaultVisitor.cookie);
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.deepEqual(Object.keys(body).sort(), ['error', 'fieldErrors', 'requestId']);
    assert.equal(body.error, 'idempotency_conflict');
    assert.deepEqual(Object.keys(body.fieldErrors), ['clientConversationId']);
    assert.equal(body.fieldErrors.clientConversationId, 'This identifier was used for different content.');
    assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(JSON.stringify(body).includes('m4t4-private-'), false);
    const after = await snapshot('default:after-conflict', defaultVisitor.cookie, defaultVisitor);
    assertHttpStable('default:conflict', before, after);
    assertDbStable('default:conflict', before, after);
    assertOutboxStable('default:conflict', before, after);
    seam.receipts.conflict = { status: 409, error: body.error, field: 'clientConversationId', requestIdUuid: true };
  });
  await seamStep('a1-queued-baseline', async () => {
    defaultBefore = await snapshot('default:before-notification', defaultVisitor.cookie, defaultVisitor);
    assert.equal(defaultBefore.outbox.status, 'QUEUED');
    assert.equal(defaultBefore.outbox.attempts, 0);
    assert.equal(defaultBefore.http.readLastSeq, 0);
    assert.equal(defaultBefore.http.messages.length, 1);
  });
  const sinkBefore = await stats();
  const baselineGeneration = (await db.jobState.findUnique({ where: { key } }))?.generation ?? 0;
  await stop(); await start();
  await tick(arm(), 200);
  const sent = await readRow(defaultRow);
  assert.equal(sent.status, 'SENT'); assert.equal(sent.attempts, 1); assert.equal(app.marker, false);
  const sinkAfter = await stats();
  assert.equal(sinkAfter.received - sinkBefore.received, 1);
  assert.ok(sinkAfter.chatEvidence.acceptedIds.includes(`<${defaultRow.stableMessageId}>`));
  report.checks.defaultRestart = true;
  let defaultSent = null;
  await seamStep('a1-sent-keeps-domain', async () => {
    assert.ok(defaultBefore, 'missing the pre-delivery snapshot');
    defaultSent = await snapshot('default:after-sent', defaultVisitor.cookie, defaultVisitor);
    assertHttpStable('default:sent', defaultBefore, defaultSent);
    assertDbStable('default:sent', defaultBefore, defaultSent);
    assert.equal(defaultSent.outbox.id, defaultRow.id);
    assert.equal(defaultSent.outbox.messageId, defaultRow.messageId);
    assert.equal(defaultSent.outbox.conversationId, defaultRow.conversationId);
    assert.equal(defaultSent.outbox.status, 'SENT');
    assert.equal(defaultSent.outbox.attempts, 1);
    assert.equal(defaultSent.outbox.stableMessageId, defaultRow.stableMessageId);
    assert.equal(defaultSent.outbox.leaseHeld, false);
    assert.equal(defaultSent.outbox.lockedUntil, null);
    assert.equal(defaultSent.outbox.providerDigest, null);
    assert.equal(defaultSent.outbox.lastErrorCode, null);
    assert.notEqual(defaultSent.outbox.sentAt, null);
  });
  await seamStep('a1-sync-first-message', async () => {
    assert.equal(defaultVisitor.duplicated.conversationId, defaultVisitor.received.conversationId);
    assert.equal(defaultVisitor.duplicated.message.id, defaultVisitor.received.message.id);
    assert.equal(defaultVisitor.duplicated.message.seq, defaultVisitor.received.message.seq);
    const response = await getSync(defaultVisitor.cookie, defaultVisitor.received.conversationId);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.read.lastReadSeq, 0, 'a delivery moved the read position');
    assert.equal(body.lastSeq, defaultVisitor.received.message.seq);
    assert.equal(body.nextAfterSeq, defaultVisitor.received.message.seq);
    assert.equal(body.hasMore, false);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].id, defaultVisitor.received.message.id);
    assert.equal(body.messages[0].seq, defaultVisitor.received.message.seq);
    assert.equal(body.messages[0].sender, 'VISITOR');
    assert.equal(body.messages[0].createdAt, defaultVisitor.received.receivedAt);
    seam.receipts.firstWrite = {
      conversationId: defaultVisitor.received.conversationId, messageId: defaultVisitor.received.message.id,
      seq: defaultVisitor.received.message.seq, receivedAt: defaultVisitor.received.receivedAt, duplicate: false,
    };
    seam.receipts.replay = { duplicate: true, sameConversation: true, sameMessage: true, sameSeq: true, sameReceivedAt: true };
  });
  await seamStep('a1-read-advances', async () => {
    assert.ok(defaultSent, 'missing the delivered snapshot');
    const read = await markRead(defaultVisitor.cookie, defaultVisitor.received.conversationId, defaultVisitor.received.message.seq);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { lastReadSeq: defaultVisitor.received.message.seq });
    const after = await snapshot('default:after-read', defaultVisitor.cookie, defaultVisitor);
    assertConversationExceptRead('default:read', defaultSent, after);
    assertOutboxStable('default:read', defaultSent, after);
    assert.equal(after.http.readLastSeq, defaultVisitor.received.message.seq);
    assert.equal(after.db.visitorReadSeq, defaultVisitor.received.message.seq);
  });
  await seamStep('a1-read-idempotent', async () => {
    const before = seam.snapshots['default:after-read'];
    assert.ok(before, 'missing the read snapshot');
    const again = await markRead(defaultVisitor.cookie, defaultVisitor.received.conversationId, defaultVisitor.received.message.seq);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { lastReadSeq: defaultVisitor.received.message.seq });
    const after = await snapshot('default:after-repeat-read', defaultVisitor.cookie, defaultVisitor);
    assertHttpStable('default:repeat-read', before, after);
    assertDbStable('default:repeat-read', before, after);
    assertOutboxStable('default:repeat-read', before, after);
  });

  report.stage = 'accepted-before-kill';
  const crashVisitor = await visitorMessage();
  const crashRow = crashVisitor.row;
  let crashBefore = null;
  await seamStep('b1-pre-kill-snapshot', async () => {
    crashBefore = await snapshot('crash:before-notification', crashVisitor.cookie, crashVisitor);
    assert.equal(crashBefore.outbox.status, 'QUEUED');
    assert.equal(crashBefore.outbox.attempts, 0);
    assert.equal(crashBefore.http.readLastSeq, 0);
  });
  await stop(); await start({ [hook]: '1', [scale]: '0.01' });
  const crashIndex = arm();
  await until(() => app.marker, 75_000);
  const paused = await readRow(crashRow);
  assert.equal(paused.status, 'SENDING'); assert.equal(paused.attempts, 1); assert.ok(paused.requestStartedAt);
  assert.equal((await stats()).chatEvidence.acceptedIds.filter((x) => x === `<${crashRow.stableMessageId}>`).length, 1);
  await stop('SIGKILL');
  // The minute that carries the first post-kill 409 belongs to the S4 probe. Between the kill and that
  // tick the seam reads nothing: it only re-checks the row it already read while the process was
  // paused, which is the state the kill froze.
  await seamStep('b1-killed-db', async () => {
    assert.ok(crashBefore, 'missing the crash baseline');
    assert.equal(paused.status, 'SENDING');
    assert.equal(paused.attempts, 1);
    assert.notEqual(paused.requestStartedAt, null);
    assert.notEqual(paused.leaseOwner, null, 'the mid-flight row lost its lease owner');
    assert.notEqual(paused.lockedUntil, null, 'the mid-flight row lost its row lease');
    assert.equal(paused.stableMessageId, crashRow.stableMessageId);
    assert.equal(paused.providerMessageId, null);
    assert.equal(paused.sentAt, null);
    assert.equal(paused.lastErrorCode, null);
    assert.equal(crashBefore.outbox.status, 'QUEUED');
    assert.equal(crashBefore.outbox.leaseHeld, false);
  });
  await tick(crashIndex, 0);
  await start({ [scale]: '0.01' });
  report.stage = 'restart-sweep';
  await tick(arm(), 409); // The 90s JobState lease still owns the first minute after the kill.
  // From here to the job readback the seam adds no read, no wait and no query buffer: each binding
  // below is the row the S4 probe already reads (same call, same order), and every J2 projection of
  // those rows runs in the tail, after the S4 receipt is on disk.
  const leasedRow = await readRow(crashRow);
  assert.equal(leasedRow.status, 'SENDING');
  await tick(arm(), 200);
  const unknownRow = await readRow(crashRow);
  assert.equal(unknownRow.status, 'UNKNOWN');
  report.stage = 'restart-resend';
  await tick(arm(), 200);
  const recovered = await readRow(crashRow);
  assert.equal(recovered.status, 'SENT'); assert.equal(recovered.attempts, 2);
  assert.equal((await stats()).chatEvidence.acceptedIds.filter((x) => x === `<${crashRow.stableMessageId}>`).length, 2);
  assert.equal(await db.chatNotification.count({ where: { messageId: crashRow.messageId } }), 1);
  assert.equal(await db.chatNotification.count({ where: { OR: [
    { status: 'QUEUED', attempts: { gte: 4 } }, { attempts: { gt: 4 } },
    { status: 'SENDING', requestStartedAt: null, attempts: { gte: 4 } },
    { status: 'SENDING', OR: [{ leaseOwner: null }, { lockedUntil: null }] },
  ] } }), 0);
  const job = await db.jobState.findUniqueOrThrow({ where: { key } });
  assert.equal(job.generation, baselineGeneration + 4);
  assert.equal(job.lastStatus, 'SUCCEEDED');
  assert.equal(job.leaseOwner, null);
  assert.equal(JSON.stringify(job.summary).includes('m4t4-private-'), false);
  report.checks.jobGenerations = { before: baselineGeneration, after: job.generation };
  report.checks.stableIdAfterKill = true;
  report.checks.singlePostPerArm = attempts().length === report.ticks.length;
  assert.equal(report.checks.singlePostPerArm, true);

  // The S4 result is final here. The J2 seam below reports to its own file and may fail the process,
  // but it never rewrites report.pass, report.stage, report.ticks or report.checks.
  report.pass = true;
  report.stage = 'complete';
  // The S4 receipt is persisted before the opt-in J2 tail can run: a tail that hangs until the outer
  // namespace deadline must not discard five completed ticks. Every later failure is reported in the
  // seam receipt and in the exit code, never by rewriting this file.
  if (seamOn && reportFile) {
    writeReportFile();
    s4Persisted = true;
    seam.facts.s4Receipt = {
      persisted: true,
      sha256: createHash('sha256').update(fs.readFileSync(reportFile)).digest('hex'),
      ticks: report.ticks.length,
    };
  }

  if (seamOn) {
    try { await seamTail({ crashVisitor, crashBefore, crashRow, leasedRow, unknownRow, recovered }); }
    catch (error) { seam.failures.push({ name: 'seam-tail', code: seamCode(error) }); }
    if (seam.pass !== true) process.exitCode = 1;
  }
} catch {
  console.error(`CHAT_NOTIFICATION_PHASE_FAILED phase=${report.stage} seam=${seam.stage}`);
  process.exitCode = 1;
} finally {
  const finalizeFailures = [];
  try { await stop(); } catch { finalizeFailures.push('stop'); }
  try { await db?.$disconnect(); } catch { finalizeFailures.push('disconnect'); }
  if (reportFile && !s4Persisted) {
    if (finalizeFailures.length > 0) report.pass = false;
    try { writeReportFile(); }
    catch { finalizeFailures.push('s4-report'); }
  }
  if (seamFile) {
    if (report.pass !== true) { seam.pass = false; seam.failedAtPhaseStage = report.stage; }
    if (finalizeFailures.length > 0) seam.pass = false;
    const payload = seamPayload(seam, report, finalizeFailures);
    try { fs.writeFileSync(seamFile, JSON.stringify(payload, null, 2), { mode: 0o600, flag: 'wx' }); }
    catch { finalizeFailures.push('seam-report'); }
    // A written red receipt must never leave the process green, whatever produced the red.
    if (payload.pass !== true) process.exitCode = 1;
  }
  if (finalizeFailures.length > 0) process.exitCode = 1;
}
