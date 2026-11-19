import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';

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
let app, db;

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
async function post(path, input, cookie) {
  const response = await fetch(base + path, {
    method: 'POST', headers: { origin, host: 'localhost:3100', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    redirect: 'error', body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
  });
  return response;
}
async function visitorMessage() {
  const session = await post('/api/chat/session', { locale: 'en' });
  assert.equal(session.status, 200);
  const set = session.headers.getSetCookie().find((x) => /HttpOnly/i.test(x));
  assert.ok(set, 'session did not set HttpOnly cookie');
  await session.body?.cancel();
  const cookie = set.split(';')[0];
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
  return row;
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
function arm() { const count = attempts().length; privateFile(`${state}/armed`, '1'); return count; }
async function tick(index, expected) {
  const entries = await until(() => { const values = attempts(); return values.length > index ? values : null; }, 120_000);
  assert.equal(entries.length, index + 1);
  const entry = entries[index];
  assert.equal(entry.status, expected);
  report.ticks.push(entry);
  return entry;
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
  const defaultRow = await visitorMessage();
  const sinkBefore = await stats();
  await stop(); await start();
  const initialTick = await tick(arm(), 200);
  const sent = await readRow(defaultRow);
  assert.equal(sent.status, 'SENT'); assert.equal(sent.attempts, 1); assert.equal(app.marker, false);
  const sinkAfter = await stats();
  assert.equal(sinkAfter.received - sinkBefore.received, 1);
  assert.ok(sinkAfter.chatEvidence.acceptedIds.includes(`<${defaultRow.stableMessageId}>`));
  report.checks.defaultRestart = true;

  report.stage = 'accepted-before-kill';
  const crashRow = await visitorMessage();
  await stop(); await start({ [hook]: '1', [scale]: '0.01' });
  const crashIndex = arm();
  await until(() => app.marker, 75_000);
  const paused = await readRow(crashRow);
  assert.equal(paused.status, 'SENDING'); assert.equal(paused.attempts, 1); assert.ok(paused.requestStartedAt);
  assert.equal((await stats()).chatEvidence.acceptedIds.filter((x) => x === `<${crashRow.stableMessageId}>`).length, 1);
  await stop('SIGKILL');
  const crashTick = await tick(crashIndex, 0);
  assert.ok(crashTick.at - initialTick.at >= 55_000 && crashTick.at - initialTick.at <= 65_000);
  await start({ [scale]: '0.01' });
  report.stage = 'restart-sweep';
  await tick(arm(), 409); // The 90s JobState lease still owns the first minute after the kill.
  assert.equal((await readRow(crashRow)).status, 'SENDING');
  await tick(arm(), 200);
  assert.equal((await readRow(crashRow)).status, 'UNKNOWN');
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
  assert.equal(JSON.stringify((await db.jobState.findUniqueOrThrow({ where: { key } })).summary).includes('m4t4-private-'), false);
  report.checks.stableIdAfterKill = true;
  report.checks.singlePostPerArm = attempts().length === report.ticks.length;
  assert.equal(report.checks.singlePostPerArm, true);
  report.pass = true;
  report.stage = 'complete';
} catch {
  console.error(`CHAT_NOTIFICATION_PHASE_FAILED ${report.stage}`);
  process.exitCode = 1;
} finally {
  try { await stop(); await db?.$disconnect(); } catch { report.pass = false; process.exitCode = 1; }
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
}
