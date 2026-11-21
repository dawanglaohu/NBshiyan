import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const AGGREGATE = 'analytics-aggregate';
const RETENTION = 'analytics-retention';
const ORIGIN = 'http://localhost:3100';
const OPERATIONS = '/api/admin/cron/operations';
const MAIL_COUNTS = ['stale', 'sent', 'failed', 'deferred', 'dropped'];
const JOBS = [
  { key: RETENTION, route: OPERATIONS, payload: { jobKey: RETENTION, dryRun: true } },
  { key: 'mail-queue', route: '/api/admin/cron/mail-queue' },
  { key: 'chat-notifications', route: OPERATIONS, payload: { jobKey: 'chat-notifications' } },
];
const OUTBOUND_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'MAIL_SEND_ADAPTER',
  'CHAT_NOTIFICATION_TO', 'ADMIN_ALERT_EMAIL', 'INQUIRY_NOTIFY_EMAIL'];
const DOTENV = ['.env', '.env.local', '.env.production', '.env.production.local'];
const TOTAL_MS = 70_000;
const POST_MS = 58_000;
const MAX_BODY_BYTES = 16_384;

class Rejection extends Error {}
function check(condition, code) {
  if (!condition) throw new Rejection(code);
}

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function readExpectation(argv) {
  check(argv.length === 2 && argv[0] === '--expect' && argv[1].length > 0, 'ARGS');
  let want;
  try {
    const info = lstatSync(argv[1]);
    check(info.isFile() && info.size > 0 && info.size <= 4096, 'EXPECT');
    want = JSON.parse(readFileSync(argv[1], 'utf8'));
  } catch {
    throw new Rejection('EXPECT');
  }
  check(fields(want, ['app', 'pg']), 'EXPECT');
  const { app, pg } = want;
  check(fields(app, ['origin', 'pid', 'startTicks']) && app.origin === ORIGIN && positive(app.pid) && app.pid > 1 &&
    typeof app.startTicks === 'string' && /^[1-9]\d{0,31}$/.test(app.startTicks), 'EXPECT_APP');
  check(fields(pg, ['versionNum', 'database', 'clusterSha256']) &&
    Number.isInteger(pg.versionNum) && pg.versionNum >= 170000 && pg.versionNum < 180000 && pg.database === 'e2e' &&
    typeof pg.clusterSha256 === 'string' && /^[\da-f]{64}$/i.test(pg.clusterSha256) &&
    !/^0{64}$/.test(pg.clusterSha256), 'EXPECT_PG');
  return { app, pg: { ...pg, clusterSha256: pg.clusterSha256.toLowerCase() } };
}

function settings() {
  const { J7_ALLOW_WRITES, J7_PROBE_DB_URL: rawUrl, DATABASE_URL, J7_CRON_SECRET: secret, J7_REPO } = process.env;
  check(J7_ALLOW_WRITES === '1', 'WRITES_NOT_ALLOWED');
  check(typeof secret === 'string' && /^[\x21-\x7e]+$/.test(secret) && J7_REPO, 'ENV');
  let url, repo;
  try { url = new URL(rawUrl); } catch { throw new Rejection('DB_URL'); }
  check(rawUrl === DATABASE_URL && ['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '5432' && url.pathname === '/e2e' &&
    url.hash === '' && ['', '?schema=public'].includes(url.search) && url.username.length > 0, 'DB_URL');
  try { repo = realpathSync(J7_REPO); } catch { throw new Rejection('BUILD'); }
  return { rawUrl, secret, repo, standalone: path.join(repo, '.next', 'standalone') };
}

function checkBuild({ repo, standalone }) {
  let config;
  try {
    check(realpathSync(standalone) === standalone, 'BUILD');
    check(lstatSync(path.join(standalone, 'server.js')).isFile(), 'BUILD');
    const meta = path.join(standalone, '.next', 'required-server-files.json');
    const info = lstatSync(meta);
    check(info.isFile() && info.size > 0 && info.size <= 1_048_576, 'BUILD');
    config = JSON.parse(readFileSync(meta, 'utf8')).config?.env;
  } catch {
    throw new Rejection('BUILD');
  }
  check(config?.APP_ENV_AT_BUILD === 'test', 'BUILD');
  check(config.NEXT_PUBLIC_ADMIN_MAIL === 'http', 'MAIL_GATE');

  // /proc/environ is the launch environment. Reject files Next could load after launch.
  for (const root of [repo, standalone]) {
    for (const name of DOTENV) {
      try {
        lstatSync(path.join(root, name));
        throw new Rejection('APP_ENV');
      } catch (error) {
        check(error?.code === 'ENOENT', 'APP_ENV');
      }
    }
  }
}

function observe(app, config) {
  const observer = fileURLToPath(new URL('./j7-retryable.mjs', import.meta.url));
  let processEnv;
  try {
    const observed = JSON.parse(execFileSync(process.execPath, [observer, 'observe-app', '--origin', ORIGIN,
      '--pid', String(app.pid)], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }));
    check(isDeepStrictEqual(observed, app), 'APP_IDENTITY');
    check(realpathSync(`/proc/${app.pid}/cwd`) === config.standalone, 'APP_IDENTITY');
    processEnv = new Map();
    for (const entry of readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0').filter(Boolean)) {
      const end = entry.indexOf('=');
      const name = entry.slice(0, end);
      check(end > 0 && !processEnv.has(name), 'APP_IDENTITY');
      processEnv.set(name, entry.slice(end + 1));
    }
  } catch {
    throw new Rejection('APP_IDENTITY');
  }
  check(processEnv.get('APP_ENV') === 'test', 'APP_ENV');
  check(processEnv.get('NEXT_PUBLIC_ADMIN_MAIL') === 'http', 'MAIL_GATE');
  check(processEnv.get('DATABASE_URL') === config.rawUrl && processEnv.get('CRON_SECRET') === config.secret, 'APP_BIND');
  check(OUTBOUND_ENV.every((name) => !processEnv.get(name)), 'OUTBOUND_ENV');
}

async function snapshot(prisma, pg) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const rows = await tx.$queryRaw`SELECT current_database() AS database, current_schema() AS schema,
        current_setting('server_version_num')::int AS version_num,
        system_identifier::text AS system_identifier FROM pg_control_system()`;
      const identity = rows[0];
      check(rows.length === 1 && identity.database === pg.database && identity.schema === 'public' &&
        identity.version_num === pg.versionNum && typeof identity.system_identifier === 'string' &&
        /^[1-9]\d{0,31}$/.test(identity.system_identifier) &&
        createHash('sha256').update(`system_identifier:${identity.system_identifier}`).digest('hex') === pg.clusterSha256, 'PG_IDENTITY');

      const [queues] = await tx.$queryRaw`SELECT
        EXISTS (SELECT 1 FROM public."MailMessage" WHERE direction = 'OUTBOUND' AND status IN ('QUEUED', 'SENDING')) AS mail,
        EXISTS (SELECT 1 FROM public."ChatNotification" WHERE status IN ('QUEUED', 'SENDING', 'UNKNOWN')) AS chat`;
      check(queues?.mail === false, 'MAIL_PENDING');
      check(queues?.chat === false, 'CHAT_PENDING');
      const jobs = await tx.jobState.findMany({ orderBy: { key: 'asc' }, take: JOBS.length + 2 });
      return new Map(jobs.map((row) => [row.key, row]));
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 3000 });
  } catch (error) {
    if (error instanceof Rejection) throw error;
    throw new Rejection('DB_READ');
  }
}

function requireKeys(rows, keys) {
  check(rows.size === keys.length && keys.every((key) => rows.has(key)), 'ROWSET');
}

function rowTimes(row) {
  const startedAt = row?.lastStartedAt?.getTime();
  const finishedAt = row?.lastFinishedAt?.getTime();
  check(positive(startedAt) && positive(finishedAt) && startedAt <= finishedAt &&
    row.lastSucceededAt?.getTime() === finishedAt, 'JOB_CLOCK');
  return { startedAt, finishedAt };
}

function requireSucceeded(row) {
  check(row?.lastStatus === 'SUCCEEDED' && row.lastErrorCode === null &&
    row.leaseOwner === null && row.lockedUntil === null && positive(row.generation), 'JOB_STATE');
}

function validateHttp({ status, cacheControl, contentType, body }, job, window) {
  if (job.payload === undefined) check(status !== 404, 'MAIL_GATE');
  check(status === 200 && /\bno-store\b/i.test(cacheControl ?? '') && /^application\/json(?:\s*;|$)/i.test(contentType ?? ''), 'HTTP');
  const mail = job.payload === undefined;
  if (!mail) {
    check(fields(body, ['jobKey', 'status', 'counts', 'finishedAt']) && body.jobKey === job.key && body.status === 'SUCCEEDED', 'HTTP');
    const finishedAt = typeof body.finishedAt === 'string' ? Date.parse(body.finishedAt) : NaN;
    check(Number.isFinite(finishedAt) && new Date(finishedAt).toISOString() === body.finishedAt &&
      finishedAt >= window.start && finishedAt <= window.end, 'HTTP');
  }
  const counts = mail ? body : body.counts;
  if (job.key === RETENTION) {
    check(fields(counts, ['candidateCount', 'deletedCount']) && nonnegative(counts.candidateCount) && counts.deletedCount === 0, 'HTTP_COUNTS');
  } else {
    const keys = mail ? MAIL_COUNTS : ['candidateCount', ...MAIL_COUNTS];
    check(fields(counts, keys) && keys.every((key) => counts[key] === 0), 'HTTP_COUNTS');
  }
  return counts;
}

function post(job, secret, timeout) {
  const payload = job.payload === undefined ? '' : JSON.stringify(job.payload);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: 3100, path: job.route, method: 'POST',
      agent: false, signal: AbortSignal.timeout(timeout), headers: {
        host: 'localhost:3100', origin: ORIGIN, authorization: `Bearer ${secret}`,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      } }, async (response) => {
      const { statusCode: status, headers } = response;
      if (status !== 200) {
        response.destroy();
        resolve({ status });
        return;
      }
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of response) {
          size += chunk.length;
          check(size <= MAX_BODY_BYTES, 'HTTP_BODY');
          chunks.push(chunk);
        }
        resolve({ status, cacheControl: headers['cache-control'], contentType: headers['content-type'],
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch (error) {
        reject(error instanceof Rejection ? error : new Rejection('HTTP_BODY'));
      }
    });
    req.on('error', (error) => reject(new Rejection(error.code === 'ABORT_ERR' ? 'HTTP_TIMEOUT' : 'HTTP_REQUEST')));
    req.end(payload);
  });
}

function assertStep(before, after, job, window, counts) {
  requireKeys(after, [...before.keys(), job.key]);
  const next = after.get(job.key);
  requireSucceeded(next);
  check(next.generation === 1, 'GENERATION');
  const times = rowTimes(next);
  check(times.startedAt >= window.start && times.finishedAt <= window.end, 'JOB_CLOCK');
  check(isDeepStrictEqual(next.summary?.counts, counts), 'JOB_COUNTS');

  for (const [key, prior] of before) {
    const found = after.get(key);
    if (key === AGGREGATE && job.key === RETENTION) {
      // Retention takes and releases the aggregate lease without replacing its last business result.
      const { generation, updatedAt, ...status } = found;
      const { generation: priorGeneration, updatedAt: priorUpdate, ...priorStatus } = prior;
      check(generation === priorGeneration + 1 && isDeepStrictEqual(status, priorStatus) &&
        updatedAt.getTime() >= Math.max(window.start, priorUpdate.getTime()) && updatedAt.getTime() <= window.end, 'AGGREGATE');
    } else {
      check(isDeepStrictEqual(found, prior), key === AGGREGATE ? 'AGGREGATE' : 'UNRELATED_JOB');
    }
  }
}

async function preflight(prisma, want, config, deadline) {
  let before = await snapshot(prisma, want.pg);
  requireKeys(before, [AGGREGATE]);
  const aggregate = before.get(AGGREGATE);
  requireSucceeded(aggregate);
  check(rowTimes(aggregate).finishedAt <= Date.now(), 'JOB_CLOCK');

  for (const job of JOBS) {
    checkBuild(config);
    observe(want.app, config);
    const remaining = Math.floor(deadline - performance.now() - 6000);
    check(remaining > 0, 'TIMEOUT');
    const start = Date.now();
    const response = await post(job, config.secret, Math.min(POST_MS, remaining));
    const window = { start, end: Date.now() };
    const counts = validateHttp(response, job, window);
    observe(want.app, config);
    const after = await snapshot(prisma, want.pg);
    assertStep(before, after, job, window, counts);
    before = after;
  }
}

function failure(error) {
  process.stderr.write(`J7_JOBSTATE_PREFLIGHT_${error instanceof Rejection ? error.message : 'RUNTIME'}\n`);
}

async function main(argv) {
  const deadline = performance.now() + TOTAL_MS;
  const timer = setTimeout(() => {
    failure(new Rejection('TIMEOUT'));
    process.exit(1);
  }, TOTAL_MS);
  try {
    const want = readExpectation(argv);
    const config = settings();
    checkBuild(config);
    observe(want.app, config);
    const { PrismaClient } = createRequire(path.join(config.repo, 'package.json'))('@prisma/client');
    const prisma = new PrismaClient({ datasources: { db: { url: config.rawUrl } } });
    try {
      await preflight(prisma, want, config, deadline);
    } catch (error) {
      await prisma.$disconnect().catch(() => {});
      throw error;
    }
    try { await prisma.$disconnect(); } catch { throw new Rejection('DB_DISCONNECT'); }
    check(performance.now() < deadline, 'TIMEOUT');
    process.stdout.write('J7_JOBSTATE_PREFLIGHT_OK\n');
  } finally {
    clearTimeout(timer);
  }
}

main(process.argv.slice(2)).catch((error) => {
  failure(error);
  process.exitCode = 1;
});
