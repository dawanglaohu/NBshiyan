/**
 * M4-T12 P2 phase: real cron tick over the isolated TLS SMTP evidence stack.
 *
 * Runs inside the existing private mount/net/pid namespace via
 *   node local-smtp.mjs exec --root <root> --mode http-real -- node mail-cron-phase.mjs --report <file>
 * so DATABASE_URL / CRON_SECRET / SMTP_* / AUTH_* / NODE_EXTRA_CA_CERTS are inherited
 * from the original exec() injection. The phase never POSTs the cron route directly and
 * never calls the job handler: scheduling comes only from the root busybox crond tick.
 *
 * It seeds one due QUEUED MailMessage, restarts the already-activated http-real artifact,
 * arms the fixed tick, asserts one POST -> SENT / JobState SUCCEEDED / sink +1, then runs
 * the N1/N2/N4 tick windows and the N3 root-directory denial check. No secret value is
 * written to argv, logs or the report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const STATE = '/tmp/mail-cron-state';
const ROOT_DIR = '/tmp/mail-cron';
const ACTIVE = '/tmp/mail-evidence-artifacts/http-real';
const BASE_URL = 'http://localhost:3100';
const SINK_STATS = 'http://127.0.0.1:3998/stats';
const require = createRequire(path.join(process.cwd(), 'package.json'));

const argv = process.argv.slice(2);
const reportPath = (() => { const i = argv.indexOf('--report'); return i >= 0 ? argv[i + 1] : null; })();
const sourceCommit = process.env.GITHUB_SHA || '';
const report = { version: 1, phase: 'mail-cron', pass: false, sourceCommit, checks: {}, windows: {}, error: null };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const code = (error) => (error && typeof error.code === 'string' ? error.code : 'PHASE_FAILED');

function writeReport() {
  if (!reportPath) return;
  try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch { /* report failure surfaces via exit code */ }
}

function check(condition, name) {
  if (!condition) throw Object.assign(new Error(name), { code: name });
  report.checks[name] = true;
}

function lstatFileNoFollow(file) {
  const st = fs.lstatSync(file);
  return st.isFile() && !st.isSymbolicLink() && st.nlink === 1;
}

async function sinkStats() {
  const res = await fetch(SINK_STATS);
  if (res.status !== 200) throw Object.assign(new Error('SINK_STATS_HTTP'), { code: 'SINK_STATS_HTTP' });
  const body = await res.json();
  for (const key of ['received', 'authenticated', 'rcptAttempts', 'rejectedRecipients']) {
    if (!Number.isSafeInteger(body[key]) || body[key] < 0) throw Object.assign(new Error('SINK_STATS_SCHEMA'), { code: 'SINK_STATS_SCHEMA' });
  }
  return body;
}

function appEnv() {
  return { ...process.env, PORT: '3100', HOSTNAME: '127.0.0.1', E2E_SITE_REVALIDATE: '1', AUTH_URL: BASE_URL, APP_ORIGIN: BASE_URL };
}

async function startApp() {
  const child = spawn(process.execPath, ['server.js'], { cwd: ACTIVE, env: appEnv(), stdio: ['ignore', 'inherit', 'inherit'] });
  let exited = null;
  child.once('exit', (exitCode, signal) => { exited = { exitCode, signal }; });
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (exited) throw Object.assign(new Error('APP_EXITED'), { code: 'APP_EXITED_EARLY' });
    try {
      const r = await fetch(`${BASE_URL}/en`, { redirect: 'manual' });
      if (r.status === 200) break;
    } catch {}
    if (Date.now() > deadline) throw Object.assign(new Error('APP_READY_TIMEOUT'), { code: 'APP_READY_TIMEOUT' });
    await sleep(200);
  }
  return { child, exited: () => exited };
}

async function stopApp(rec) {
  if (!rec || rec.exited()) return { termTimeout: false };
  rec.child.kill('SIGTERM');
  const deadline = Date.now() + 20_000;
  while (!rec.exited() && Date.now() < deadline) await sleep(100);
  if (rec.exited()) return { termTimeout: false };
  rec.child.kill('SIGKILL');
  const killDeadline = Date.now() + 5_000;
  while (!rec.exited() && Date.now() < killDeadline) await sleep(100);
  return { termTimeout: true };
}

function readAttempt() {
  try {
    const parsed = JSON.parse(fs.readFileSync(`${STATE}/last-attempt.json`, 'utf8'));
    return typeof parsed.at === 'string' ? parsed : null;
  } catch { return null; }
}

function regularFile(file, content) {
  try { fs.rmSync(file, { force: true }); } catch {}
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); }
}

function prepareSecret(content) { regularFile(`${STATE}/secret`, content); }

function prepareSecretSymlink() {
  const real = `${STATE}/secret.real`;
  regularFile(real, process.env.CRON_SECRET || '');
  try { fs.rmSync(`${STATE}/secret`, { force: true }); } catch {}
  fs.symlinkSync(real, `${STATE}/secret`);
}

function prepareLogSymlink() {
  try { fs.rmSync(`${STATE}/cron-mail-queue.log`, { force: true }); } catch {}
  fs.symlinkSync('/tmp/mail-cron-pwn-log', `${STATE}/cron-mail-queue.log`);
}

function restoreLog() {
  try {
    const st = fs.lstatSync(`${STATE}/cron-mail-queue.log`);
    if (st.isSymbolicLink()) fs.rmSync(`${STATE}/cron-mail-queue.log`, { force: true });
  } catch {}
  if (!fs.existsSync(`${STATE}/cron-mail-queue.log`)) regularFile(`${STATE}/cron-mail-queue.log`, '');
}

function arm() {
  try { fs.rmSync(`${STATE}/armed`, { force: true }); } catch {}
  const fd = fs.openSync(`${STATE}/armed`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try { fs.writeSync(fd, '1'); } finally { fs.closeSync(fd); }
}

async function generation() {
  const row = await prisma.jobState.findUnique({ where: { key: 'mail-queue' } });
  return row ? Number(row.generation) : 0;
}

async function tickWindow(name, prepare, expectOutcome) {
  const before = readAttempt();
  if (before && before.outcome) report.windows[name] = { previous: before.outcome };
  const genBefore = await generation();
  prepare();
  arm();
  const started = Date.now();
  let attempt = null;
  while (Date.now() - started < 75_000) {
    const current = readAttempt();
    if (current && (!before || current.at !== before.at)) { attempt = current; break; }
    await sleep(200);
  }
  try { fs.rmSync(`${STATE}/armed`, { force: true }); } catch {}
  if (!attempt) throw Object.assign(new Error(`${name}_NO_ATTEMPT`), { code: `${name}_NO_ATTEMPT` });
  if (expectOutcome && attempt.outcome !== expectOutcome) {
    throw Object.assign(new Error(`${name}_OUTCOME`), { code: `${name}_OUTCOME`, actual: attempt.outcome });
  }
  // One arm must produce at most one POST; a second minute must not re-fire it.
  await sleep(1_500);
  const after = readAttempt();
  if (after && after.at !== attempt.at) throw Object.assign(new Error(`${name}_SECOND_ATTEMPT`), { code: `${name}_SECOND_ATTEMPT` });
  const genAfter = await generation();
  report.windows[name] = { at: attempt.at, outcome: attempt.outcome, genBefore, genAfter };
  return { attempt, genBefore, genAfter };
}

let prisma;
let app = null;

try {
  check(process.platform === 'linux', 'PLATFORM_LINUX');
  check(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true', 'CI_ENV');
  check(process.env.SMTP_EVIDENCE_MODE === 'http-real', 'MODE_HTTP_REAL');
  check(/^[a-f0-9]{40}$/.test(sourceCommit), 'FREEZE_COMMIT');
  check(typeof process.env.CRON_SECRET === 'string' && process.env.CRON_SECRET.length >= 16, 'CRON_SECRET_PRESENT');
  check(typeof process.env.SMTP_EVIDENCE_RECIPIENT === 'string' && process.env.SMTP_EVIDENCE_RECIPIENT.includes('@'), 'RECIPIENT_PRESENT');
  check(process.getuid() > 0 && process.getgid() > 0, 'APP_UID_GID_POSITIVE');
  const db = new URL(process.env.DATABASE_URL || '');
  check(db.protocol === 'postgresql:' && db.hostname === '127.0.0.1' && db.pathname === '/mail_evidence', 'DATABASE_URL_ISOLATED');

  // Artifact provenance: reuse the directory activated by the earlier http-real run; do not re-activate.
  check(fs.realpathSync(ACTIVE) === ACTIVE, 'ACTIVE_REALPATH');
  const activeStat = fs.lstatSync(ACTIVE);
  check(activeStat.isDirectory() && !activeStat.isSymbolicLink() && activeStat.uid === process.getuid() && (activeStat.mode & 0o777) === 0o700, 'ACTIVE_SHAPE');
  check(lstatFileNoFollow(path.join(ACTIVE, 'server.js')), 'SERVER_JS_REGULAR');
  const provenancePath = path.join(ACTIVE, 'runtime-provenance.json');
  const provenanceStat = fs.lstatSync(provenancePath);
  check(provenanceStat.isFile() && !provenanceStat.isSymbolicLink() && provenanceStat.nlink === 1 && (provenanceStat.mode & 0o777) === 0o600, 'PROVENANCE_FILE');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  check(provenance.version === 1 && provenance.sourceCommit === sourceCommit && provenance.sourceTree === tree, 'PROVENANCE_SOURCE');
  check(provenance.runtimeMode === 'http-real' && provenance.buildMode === 'http' && provenance.businessCredentialsUsedInBuild === false, 'PROVENANCE_MODE');
  check(/^[A-Za-z0-9_-]{1,128}$/.test(provenance.buildId) && /^[a-f0-9]{64}$/.test(provenance.manifestSha256) && provenance.verifiedFiles > 0, 'PROVENANCE_ARTIFACT');
  report.buildId = provenance.buildId;
  report.sourceTree = provenance.sourceTree;

  prisma = new (require('@prisma/client').PrismaClient)();
  await prisma.$connect();

  const dueWhere = { direction: 'OUTBOUND', status: 'QUEUED', errorCode: 'daily_cap_deferred', deferredUntil: { lte: new Date() } };
  const preDue = await prisma.mailMessage.count({ where: dueWhere });
  check(preDue === 0, 'DUE_SET_EMPTY_BEFORE_SEED');
  report.preDue = preDue;

  const recipient = process.env.SMTP_EVIDENCE_RECIPIENT;
  const nonce = randomBytes(12).toString('hex');
  const contact = await prisma.contact.create({ data: { region: 'US', name: 'Synthetic Cron', email: recipient } });
  const inquiry = await prisma.inquiry.create({ data: {
    ref: `PJ-CRON-${nonce}`, replyToken: randomBytes(16).toString('hex'), contactId: contact.id,
    locale: 'en', source: 'FORM', retainUntil: new Date(Date.now() + 30 * 864e5),
  } });
  const sendKey = nonce;
  const mail = await prisma.mailMessage.create({ data: {
    direction: 'OUTBOUND', status: 'QUEUED', inquiryId: inquiry.id, sendKey,
    messageId: `<${sendKey}@reply.example.test>`, fromAddr: 'sender@example.test', toAddr: recipient,
    subject: 'Synthetic cron', bodyHtml: '<p>Synthetic cron</p>', bodyText: 'Synthetic cron',
    errorCode: 'daily_cap_deferred', deferredUntil: new Date(Date.now() - 1_000),
  } });
  report.mailId = mail.id;

  const jobBefore = await prisma.jobState.findUnique({ where: { key: 'mail-queue' } });
  check(!jobBefore || !jobBefore.lockedUntil || jobBefore.lockedUntil.getTime() <= Date.now(), 'JOBSTATE_NOT_LEASED');
  report.jobStateBefore = jobBefore ? { generation: jobBefore.generation, lastStatus: jobBefore.lastStatus } : null;
  const genBaseline = jobBefore ? Number(jobBefore.generation) : 0;
  report.jobGenerationBefore = genBaseline;

  app = await startApp();
  await stopApp(app);
  app = await startApp();
  const queuedAfterRestart = await prisma.mailMessage.findUnique({ where: { id: mail.id } });
  check(queuedAfterRestart.status === 'QUEUED' && queuedAfterRestart.attempts === 0, 'QUEUED_AFTER_RESTART');
  report.windows.restart = { queued: queuedAfterRestart.status, attempts: queuedAfterRestart.attempts };

  const sinkBefore = await sinkStats();
  report.sinkBefore = { received: sinkBefore.received };

  const success = await tickWindow('success', () => prepareSecret(process.env.CRON_SECRET), 'posted:200');
  check(success.genAfter === success.genBefore + 1, 'GENERATION_PLUS_ONE');

  const sentMail = await prisma.mailMessage.findUnique({ where: { id: mail.id } });
  check(sentMail.status === 'SENT' && sentMail.attempts === 1 && sentMail.sentAt !== null && sentMail.lockedUntil === null, 'MAIL_SENT_ATTEMPT_1');
  const jobAfter = await prisma.jobState.findUnique({ where: { key: 'mail-queue' } });
  check(jobAfter && jobAfter.lastStatus === 'SUCCEEDED' && jobAfter.lastSucceededAt !== null && jobAfter.lockedUntil === null, 'JOBSTATE_SUCCEEDED_UNLOCKED');
  check(jobAfter.summary && jobAfter.summary.counts && jobAfter.summary.counts.sent === 1, 'JOBSTATE_SUMMARY_SENT_1');
  const sinkAfter = await sinkStats();
  check(sinkAfter.received === sinkBefore.received + 1, 'SINK_RECEIVED_PLUS_ONE');
  report.sinkAfter = { received: sinkAfter.received };
  report.sent = { status: sentMail.status, attempts: sentMail.attempts, generation: jobAfter.generation };

  // N1: payload-looking secret is only a header value; no shell execution, no POST success.
  const control1 = await tickWindow('n1_payload_secret', () => prepareSecret('$(touch /tmp/mail-cron-pwn)'), 'posted:401');
  check(!fs.existsSync('/tmp/mail-cron-pwn'), 'N1_NO_MARKER_FILE');
  check(control1.genAfter === control1.genBefore, 'N1_NO_GENERATION');

  // N2: secret symlink must be rejected before any POST.
  const control2 = await tickWindow('n2_secret_symlink', () => prepareSecretSymlink(), 'secret_invalid');
  check(control2.genAfter === control2.genBefore, 'N2_NO_GENERATION');

  // N4: log symlink must fail closed before any POST; the target must never be created.
  const control4 = await tickWindow('n4_log_symlink', () => { prepareSecret(process.env.CRON_SECRET); prepareLogSymlink(); }, 'log_open_failed');
  check(!fs.existsSync('/tmp/mail-cron-pwn-log'), 'N4_NO_TARGET_FILE');
  check(control4.genAfter === control4.genBefore, 'N4_NO_GENERATION');
  restoreLog();

  // N3: the app identity cannot write or delete the root-owned cron files.
  const n3 = {};
  for (const target of [`${ROOT_DIR}/tick.sh`, `${ROOT_DIR}/run.conf`, `${ROOT_DIR}/spool/root`]) {
    let writeCode = null, unlinkCode = null;
    try {
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_APPEND);
      try { fs.writeSync(fd, ''); } finally { fs.closeSync(fd); }
    } catch (error) { writeCode = code(error); }
    try { fs.rmSync(target, { force: false }); } catch (error) { unlinkCode = code(error); }
    n3[path.basename(target)] = { write: writeCode, unlink: unlinkCode };
    check(['EACCES', 'EPERM'].includes(writeCode), `N3_WRITE_DENIED_${path.basename(target)}`);
    check(['EACCES', 'EPERM'].includes(unlinkCode), `N3_UNLINK_DENIED_${path.basename(target)}`);
  }
  report.windows.n3 = n3;

  report.pass = true;
} catch (error) {
  // Only the bounded code category is reported; never an error message that could
  // embed a connection string, credential or header value.
  report.error = { code: code(error) };
} finally {
  try { await stopApp(app); } catch {}
  try { if (prisma) await prisma.$disconnect(); } catch {}
  writeReport();
}

if (!report.pass) {
  console.error(JSON.stringify({ mailCronPhase: 'failed', code: report.error && report.error.code }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ mailCronPhase: 'passed', buildId: report.buildId, sent: report.sent }));
}
