#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readFile, mkdtemp, writeFile, link, rm, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual as equal, TextDecoder } from 'node:util';

const KEY = 'analytics-aggregate';
const OTHERS = ['analytics-retention', 'chat-notifications', 'mail-queue'];
const KEYS = [KEY, ...OTHERS];
const ROUTE = '/api/admin/cron/operations';
const ERROR = 'version_conflict';
const STATUSES = ['NEVER', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL'];
const maxJsonBytes = 1024 * 1024;

class Rejection extends Error {}
function check(condition, code) {
  if (!condition) throw new Rejection(code);
}

function fields(value, names, code) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    equal(Object.keys(value).sort(), names.split(' ').sort()), code);
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hex(value, length, code) {
  check(typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value) && !/^0+$/.test(value), code);
  return value.toLowerCase();
}

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
function time(value, code) {
  const parsed = Date.parse(value);
  check(typeof value === 'string' && Number.isFinite(parsed) && new Date(parsed).toISOString() === value, code);
  return parsed;
}

function windowOf(value, code) {
  fields(value, 'startedAt endedAt', code);
  const start = time(value.startedAt, code);
  const end = time(value.endedAt, code);
  check(start <= end, code);
  return [start, end];
}

async function input(file, code) {
  try {
    const info = await lstat(file);
    check(info.isFile() && info.size > 0 && info.size <= maxJsonBytes, code);
    const bytes = await readFile(file);
    check(bytes.length === info.size, code);
    return { bytes, doc: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    throw new Rejection(code);
  }
}

async function publish(file, doc) {
  let temporary;
  try {
    temporary = await mkdtemp(path.join(path.dirname(file), '.j7-retryable-'));
    const prepared = path.join(temporary, 'report.json');
    await writeFile(prepared, `${JSON.stringify(doc, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await link(prepared, file);
  } catch {
    throw new Rejection('OUTPUT');
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

function origin(value, code) {
  check(typeof value === 'string' && /^http:\/\/(?:localhost|127\.0\.0\.1):[1-9]\d{0,4}$/.test(value), code);
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  check(port <= 65535, code);
  return port;
}

function runIdentity(value, code) {
  fields(value, 'workflow job id attempt', code);
  check(value.workflow === 'CI' && value.job === 'e2e' && positive(value.id) && positive(value.attempt), code);
  return value;
}

function sourceIdentity(value, code) {
  fields(value, 'commit tree', code);
  return { commit: hex(value.commit, 40, code), tree: hex(value.tree, 40, code) };
}

function pgIdentity(value, code) {
  fields(value, 'versionNum database clusterSha256', code);
  check(Number.isInteger(value.versionNum) && value.versionNum >= 170000 && value.versionNum < 180000 &&
    typeof value.database === 'string' && /^e2e(?:_j7_[a-f0-9]{12})?$/.test(value.database), code);
  return { versionNum: value.versionNum, database: value.database, clusterSha256: hex(value.clusterSha256, 64, code) };
}

function appIdentity(value, code) {
  fields(value, 'origin pid startTicks', code);
  origin(value.origin, code);
  check(positive(value.pid) && value.pid > 1 && typeof value.startTicks === 'string' && /^[1-9]\d{0,19}$/.test(value.startTicks), code);
  return value;
}

function buildIdentity(value, code) {
  fields(value, 'buildId serverJsSha256', code);
  check(typeof value.buildId === 'string' && /^(?!0+$)[A-Za-z0-9_-]{1,128}$/.test(value.buildId), code);
  return { buildId: value.buildId, serverJsSha256: hex(value.serverJsSha256, 64, code) };
}

function expected(value) {
  fields(value, 'schema run source build pg app probeSha256 expectedFailedGeneration', 'EXPECT');
  check(value.schema === 'j7-retryable-expect/1' && positive(value.expectedFailedGeneration), 'EXPECT');
  return {
    run: runIdentity(value.run, 'EXPECT_RUN'), source: sourceIdentity(value.source, 'EXPECT_SOURCE'),
    build: buildIdentity(value.build, 'EXPECT_BUILD'), pg: pgIdentity(value.pg, 'EXPECT_PG'),
    app: appIdentity(value.app, 'EXPECT_APP'), probeSha256: hex(value.probeSha256, 64, 'EXPECT_PROBE_SHA'),
    expectedFailedGeneration: value.expectedFailedGeneration,
  };
}

function jobRows(rows, code) {
  check(Array.isArray(rows) && rows.length === KEYS.length, code);
  const map = new Map(rows.map((row) => [row?.key, row]));
  check(KEYS.every((key) => map.has(key)), code);
  return map;
}

function anchorFor(probe, want) {
  check(sha(probe.bytes) === want.probeSha256, 'PROBE_SHA');
  const doc = probe.doc;
  check(doc?.schema === 'j7-probe/3' && doc.pass === true && doc.mode === 'full' && doc.cleanup?.fixtureRestored === true, 'PROBE_SHAPE');
  const f = doc.failureAttribution;
  check(f?.mode === 'main-instance' && f.jobKey === KEY && f.httpStatus === 200 && f.failedStatus === 'FAILED' &&
    f.errorCode === ERROR && f.fixture?.restored === true && f.responseCounts?.candidateCount === 0 &&
    f.failed?.lastStatus === 'FAILED' && f.failed.lastErrorCode === ERROR && f.failed.leaseReleased === true &&
    f.failed.candidateCount === 0, 'PROBE_FAILURE');
  fields(doc.run, 'workflow id attempt', 'PROBE_IDENTITY');
  check(equal({ ...doc.run, job: want.run.job }, want.run) && equal(sourceIdentity(doc.source, 'PROBE_SOURCE'), want.source) &&
    equal(sourceIdentity(f.source, 'PROBE_SOURCE'), want.source), 'PROBE_IDENTITY');
  check(doc.build?.buildId === want.build.buildId && f.buildId === want.build.buildId &&
    doc.app?.origin === want.app.origin && f.appOrigin === want.app.origin && doc.app.health === 200, 'PROBE_IDENTITY');
  check(equal(pgIdentity(doc.pg, 'PROBE_PG'), want.pg) && equal(pgIdentity(f.pg, 'PROBE_PG'), want.pg), 'PROBE_PG');
  const failed = f.failed;
  check(failed.generation === want.expectedFailedGeneration && positive(f.warm?.generation) &&
    f.warm.generation + 1 === failed.generation && failed.lastSucceededAt === f.warm.lastSucceededAt &&
    positive(failed.timezoneRevision) && failed.timezoneRevision === f.warm.timezoneRevision, 'PROBE_GENERATION');
  const [start, end] = windowOf(f.window, 'PROBE_CLOCK');
  const finished = time(failed.lastFinishedAt, 'PROBE_CLOCK');
  const succeeded = time(failed.lastSucceededAt, 'PROBE_CLOCK');
  const probeEnd = time(doc.finishedAt, 'PROBE_CLOCK');
  check(time(doc.startedAt, 'PROBE_CLOCK') <= start && start <= finished && finished <= end && end <= probeEnd && succeeded < start, 'PROBE_CLOCK');
  const rows = jobRows(doc.jobs, 'PROBE_JOBS');
  const aggregate = rows.get(KEY);
  const calls = Array.isArray(doc.http) ? doc.http.filter((row) => row?.id === 'operations-aggregate-conflict') : [];
  check(calls.length === 1 && calls[0].status === 200 && calls[0].method === 'POST' && calls[0].path === ROUTE &&
    aggregate.generationAfter === failed.generation && aggregate.statusAfter === failed.lastStatus && aggregate.errorCode === ERROR &&
    Array.isArray(aggregate.runs) && aggregate.runs.length === 2 &&
    equal(aggregate.runs[0], { status: 'SUCCEEDED', generation: f.warm.generation, finishedAt: failed.lastSucceededAt }) &&
    equal(aggregate.runs[1], { status: 'FAILED', generation: failed.generation, finishedAt: failed.lastFinishedAt }), 'PROBE_JOBS');
  const priorOthers = f.otherKeys;
  check(Array.isArray(priorOthers) && priorOthers.length === OTHERS.length - 1, 'PROBE_JOBS');
  const others = new Map(priorOthers.map((row) => [row?.key, row]));
  for (const key of OTHERS.slice(1)) {
    const row = others.get(key);
    const job = rows.get(key);
    check(row && row.generationBefore === row.generationAfter && row.generationAfter === job.generationAfter &&
      row.statusBefore === row.statusAfter && row.statusAfter === job.statusAfter &&
      row.lastSucceededAtBefore === row.lastSucceededAtAfter, 'PROBE_JOBS');
    if (row.lastSucceededAtAfter !== null) time(row.lastSucceededAtAfter, 'PROBE_CLOCK');
  }
  const state = {
    status: failed.lastStatus, generation: failed.generation, lastErrorCode: failed.lastErrorCode,
    lastSucceededAt: failed.lastSucceededAt, lastFinishedAt: failed.lastFinishedAt,
    candidateCount: failed.candidateCount, timezoneRevision: failed.timezoneRevision, leaseReleased: failed.leaseReleased,
  };
  return { state, rows, others, probeEnd, failureHttp: calls[0].status };
}

function validateReport(doc, want, anchor) {
  fields(doc, 'schema jobKey sameKey attempts run source build pg app anchor before after window http otherKeys', 'REPORT');
  check(doc.schema === 'j7-retryable/2', 'REPORT_SCHEMA');
  check(doc.jobKey === KEY && doc.sameKey === true, 'JOB_KEY');
  check(equal(runIdentity(doc.run, 'RUN_BIND'), want.run) && equal(sourceIdentity(doc.source, 'SOURCE_BIND'), want.source), 'SOURCE_RUN_BIND');
  check(equal(buildIdentity(doc.build, 'BUILD_BIND'), want.build), 'BUILD_BIND');
  check(equal(pgIdentity(doc.pg, 'PG_BIND'), want.pg), 'PG_BIND');
  check(equal(appIdentity(doc.app, 'APP_BIND'), want.app), 'APP_BIND');
  fields(doc.anchor, 'mainProbeReportSha256 expectedFailedGeneration errorCode', 'ANCHOR');
  check(hex(doc.anchor.mainProbeReportSha256, 64, 'ANCHOR') === want.probeSha256 && doc.anchor.errorCode === ERROR, 'ANCHOR');
  check(doc.anchor.expectedFailedGeneration === want.expectedFailedGeneration, 'ANCHOR_GENERATION');
  check(equal(doc.before, anchor.state), 'BEFORE_ANCHOR');
  fields(doc.after, 'status generation lastErrorCode lastSucceededAt lastFinishedAt candidateCount timezoneRevision leaseReleased', 'AFTER');
  check(doc.after.status === 'SUCCEEDED' && doc.after.lastErrorCode === null && doc.after.leaseReleased === true &&
    nonnegative(doc.after.candidateCount) && doc.after.timezoneRevision === doc.before.timezoneRevision, 'NO_RECOVERY');
  check(doc.attempts === 2 && positive(doc.after.generation) && doc.after.generation === doc.before.generation + 1, 'ATTEMPTS');
  fields(doc.http, 'status bodyStatus finishedAt', 'HTTP');
  check(doc.http.status === 200 && doc.http.bodyStatus === doc.after.status, 'HTTP');
  const [start, end] = windowOf(doc.window, 'WINDOW');
  const success = time(doc.after.lastSucceededAt, 'SUCCESS_CLOCK');
  const responseFinish = time(doc.http.finishedAt, 'SUCCESS_CLOCK');
  check(anchor.probeEnd <= start && start <= success && success <= responseFinish && responseFinish <= end &&
    success > time(doc.before.lastFinishedAt, 'SUCCESS_CLOCK') && success > time(doc.before.lastSucceededAt, 'SUCCESS_CLOCK') &&
    doc.after.lastFinishedAt === doc.after.lastSucceededAt, 'SUCCESS_CLOCK');
  check(Array.isArray(doc.otherKeys) && doc.otherKeys.length === OTHERS.length, 'OTHER_KEYS');
  for (const [index, key] of OTHERS.entries()) {
    const row = doc.otherKeys[index];
    const prior = anchor.rows.get(key);
    fields(row, 'key generationBefore generationAfter statusBefore statusAfter lastSucceededAtBefore lastSucceededAtAfter', 'OTHER_KEYS');
    check(row.key === key && nonnegative(row.generationBefore) && row.generationBefore === row.generationAfter &&
      row.generationBefore === prior.generationAfter && STATUSES.includes(row.statusBefore) &&
      row.statusBefore === row.statusAfter && row.statusBefore === prior.statusAfter &&
      row.lastSucceededAtBefore === row.lastSucceededAtAfter &&
      (!anchor.others.has(key) || row.lastSucceededAtBefore === anchor.others.get(key).lastSucceededAtAfter), 'OTHER_KEYS');
    if (row.lastSucceededAtBefore !== null) {
      check(time(row.lastSucceededAtBefore, 'OTHER_KEYS') <= start, 'OTHER_KEYS');
    }
  }
}

async function observeApp(appOrigin, pid) {
  const port = origin(appOrigin, 'APP_ORIGIN');
  check(positive(pid) && pid > 1, 'APP_PID');
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    check(stat.startsWith(`${pid} (`) && !['Z', 'X'].includes(tail[0]), 'APP_PID');
    const socket = execFileSync('ss', ['-Hltnp', `sport = :${port}`], { encoding: 'utf8', timeout: 2000, maxBuffer: 16384,
      stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
    const owners = [...socket[0].matchAll(/\bpid=(\d+),/g)].map((match) => Number(match[1]));
    check(socket.length === 1 && socket[0].split(/\s+/).some((value) =>
      ['0.0.0.0', '127.0.0.1', '*'].some((host) => value === `${host}:${port}`)) &&
      owners.length === 1 && owners[0] === pid, 'APP_PID');
    return appIdentity({ origin: appOrigin, pid, startTicks: tail[19] }, 'APP_PID');
  } catch {
    throw new Rejection('APP_PID');
  }
}

async function digestServer(file) {
  try {
    const stat = await lstat(file);
    check(stat.isFile() && stat.size > 0, 'LOCAL_BUILD');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  } catch {
    throw new Rejection('LOCAL_BUILD');
  }
}

async function checkBuild(dir, want) {
  const id = await readFile(path.join(dir, '.next', 'BUILD_ID'), 'utf8');
  const metadata = JSON.parse(await readFile(path.join(dir, '.next', 'required-server-files.json'), 'utf8'));
  check(id.trim() === want.buildId && metadata.config?.env?.APP_ENV_AT_BUILD === 'test' &&
    await digestServer(path.join(dir, 'server.js')) === want.serverJsSha256, 'LOCAL_BUILD');
}

function env(name) {
  const value = process.env[name];
  check(typeof value === 'string' && value.length > 0, 'ENV');
  return value;
}

function dbConnection(want) {
  const raw = env('J7_PROBE_DB_URL');
  let url;
  try { url = new URL(raw); } catch { throw new Rejection('DB_URL'); }
  check(raw === env('DATABASE_URL') && ['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port !== '' && url.hash === '' &&
    (url.search === '' || url.search === '?schema=public') && url.pathname === `/${want.database}`, 'DB_URL');
  return raw;
}

async function observePg(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT current_database() AS database,
    current_setting('server_version_num')::int AS version_num,
    system_identifier::text AS system_identifier FROM pg_control_system()`);
  const row = rows[0];
  check(rows.length === 1 && typeof row.system_identifier === 'string' && /^[1-9]\d{0,31}$/.test(row.system_identifier), 'LOCAL_PG');
  return pgIdentity({ versionNum: row.version_num, database: row.database,
    clusterSha256: sha(`system_identifier:${row.system_identifier}`) }, 'LOCAL_PG');
}

const iso = (value) => value === null ? null : value.toISOString();
function rowState(row) {
  return { status: row.lastStatus, generation: row.generation, lastErrorCode: row.lastErrorCode,
    lastSucceededAt: iso(row.lastSucceededAt), lastFinishedAt: iso(row.lastFinishedAt),
    candidateCount: row.summary?.counts?.candidateCount, timezoneRevision: row.summary?.versions?.timezoneRevision,
    leaseReleased: row.leaseOwner === null && row.lockedUntil === null };
}

function otherRows(before, after, anchor) {
  return OTHERS.map((key) => {
    const a = before.get(key);
    const b = after.get(key);
    check(equal(a, b) && a.generation === anchor.rows.get(key).generationAfter && a.lastStatus === anchor.rows.get(key).statusAfter &&
      (!anchor.others.has(key) || iso(a.lastSucceededAt) === anchor.others.get(key).lastSucceededAtAfter), 'OTHER_KEYS');
    return { key, generationBefore: a.generation, generationAfter: b.generation, statusBefore: a.lastStatus,
      statusAfter: b.lastStatus, lastSucceededAtBefore: iso(a.lastSucceededAt), lastSucceededAtAfter: iso(b.lastSucceededAt) };
  });
}

async function retry(want, anchor, prisma, dir, secret, timeout) {
  check(equal(await observeApp(want.app.origin, want.app.pid), want.app), 'APP_BIND');
  check(equal(await observePg(prisma), want.pg), 'LOCAL_PG');
  const prior = jobRows(await prisma.jobState.findMany({ orderBy: { key: 'asc' } }), 'LOCAL_JOBS');
  const before = rowState(prior.get(KEY));
  check(equal(before, anchor.state), 'BEFORE_ANCHOR');
  otherRows(prior, prior, anchor);
  const startedAt = new Date().toISOString();
  check(time(startedAt, 'WINDOW') >= anchor.probeEnd, 'WINDOW');
  let response, body;
  try {
    response = await fetch(new URL(ROUTE, want.app.origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', origin: want.app.origin },
      body: JSON.stringify({ jobKey: KEY }),
    });
    body = await response.json();
  } catch {
    throw new Rejection('FETCH');
  }
  const endedAt = new Date().toISOString();
  check(response.status === 200 && body?.jobKey === KEY && body.status === 'SUCCEEDED' &&
    /\bno-store\b/i.test(response.headers.get('cache-control') ?? ''), 'HTTP');
  check(equal(await observeApp(want.app.origin, want.app.pid), want.app), 'APP_BIND');
  check(equal(await observePg(prisma), want.pg), 'LOCAL_PG');
  const next = jobRows(await prisma.jobState.findMany({ orderBy: { key: 'asc' } }), 'LOCAL_JOBS');
  const after = rowState(next.get(KEY));
  check(equal(next.get(KEY).summary?.counts, body.counts), 'AFTER_COUNTS');
  await checkBuild(dir, want.build);
  const report = {
    schema: 'j7-retryable/2', jobKey: KEY, sameKey: body.jobKey === KEY,
    attempts: [anchor.failureHttp, response.status].filter((value) => value === 200).length,
    run: want.run, source: want.source, build: want.build, pg: want.pg, app: want.app,
    anchor: { mainProbeReportSha256: want.probeSha256, expectedFailedGeneration: before.generation, errorCode: before.lastErrorCode },
    before, after, window: { startedAt, endedAt },
    http: { status: response.status, bodyStatus: body.status, finishedAt: body.finishedAt },
    otherKeys: otherRows(prior, next, anchor),
  };
  validateReport(report, want, anchor);
  return report;
}

async function produce(args, want, anchor) {
  check(process.env.J7_ALLOW_WRITES === '1', 'WRITES_NOT_ALLOWED');
  const rawDb = dbConnection(want.pg);
  const repo = await realpath(env('J7_REPO'));
  const dir = await realpath(env('J7_STANDALONE_DIR'));
  const secret = env('J7_CRON_SECRET');
  const timeout = Number(process.env.J7_RETRYABLE_TIMEOUT_MS ?? '60000');
  check(positive(timeout) && timeout <= 60000, 'TIMEOUT');
  check(dir === await realpath(path.join(repo, '.next', 'standalone')), 'LOCAL_BUILD');
  const [commit, tree] = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD', 'HEAD^{tree}'],
    { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/);
  check(equal({ commit, tree }, want.source), 'LOCAL_SOURCE');
  try {
    await lstat(args.out);
    throw new Rejection('OUTPUT');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await checkBuild(dir, want.build);
  const { PrismaClient } = createRequire(path.join(repo, 'package.json'))('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: rawDb } } });
  let report;
  try {
    report = await retry(want, anchor, prisma, dir, secret, timeout);
  } finally {
    await prisma.$disconnect();
  }
  await publish(args.out, report);
}

function options(tokens, required) {
  const result = Object.create(null);
  check(tokens.length === required.length * 2, 'ARGS');
  for (let i = 0; i < tokens.length; i += 2) {
    const name = tokens[i].slice(2);
    const value = tokens[i + 1];
    check(tokens[i] === `--${name}` && required.includes(name) && !(name in result) && value !== '' && !value.startsWith('--'), 'ARGS');
    result[name] = value;
  }
  return result;
}

async function main() {
  const [mode, ...tokens] = process.argv.slice(2);
  if (mode === 'observe-app') {
    const args = options(tokens, ['origin', 'pid']);
    check(/^[1-9]\d*$/.test(args.pid), 'APP_PID');
    process.stdout.write(`${JSON.stringify(await observeApp(args.origin, Number(args.pid)))}\n`);
    return;
  }
  check(mode === 'produce' || mode === 'admit', 'ARGS');
  const common = ['expect', 'probe', 'out'];
  const args = options(tokens, mode === 'produce' ? common : [...common, 'retryable', 'retryable-sha256']);
  const want = expected((await input(args.expect, 'EXPECT_INPUT')).doc);
  const probe = await input(args.probe, 'PROBE_INPUT');
  const anchor = anchorFor(probe, want);
  if (mode === 'produce') {
    await produce(args, want, anchor);
    process.stdout.write('J7_RETRYABLE_OK\n');
    return;
  }
  const artifact = await input(args.retryable, 'RETRYABLE_INPUT');
  const receiptSha256 = hex(args['retryable-sha256'], 64, 'RETRYABLE_SHA');
  check(sha(artifact.bytes) === receiptSha256, 'RETRYABLE_SHA');
  validateReport(artifact.doc, want, anchor);
  await publish(args.out, { schema: 'j7-retryable-admission/1', retryableSha256: receiptSha256,
    probeSha256: want.probeSha256, attempts: artifact.doc.attempts, beforeGeneration: artifact.doc.before.generation,
    afterGeneration: artifact.doc.after.generation, sameKey: artifact.doc.sameKey });
  process.stdout.write('J7_RETRYABLE_ADMISSION_OK\n');
}

main().catch((error) => {
  const code = error instanceof Rejection ? error.message : 'RUNTIME';
  process.stderr.write(`J7_RETRYABLE_${code}\n`);
  process.exitCode = 1;
});
