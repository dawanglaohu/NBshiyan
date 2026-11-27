import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { PrismaClient, type Role } from '@prisma/client';
import { authenticator } from 'otplib';
import {
  OpsReportReceiptDTOSchema,
  StatsDTOSchema,
  type OpsReportRequestDTO,
  type StatsDTO,
  type StatsSource,
} from '../src/lib/contracts/ops';
import { AppError } from '../src/lib/server/http/errors';
import {
  BACKUP_FRESHNESS_MS,
  canonicalOpsReportHash,
  createOpsSourceReaders,
  handlePostOpsReport,
  OPS_REPORT_MAX_BODY_BYTES,
  OPS_REPORT_ROUTE_ID,
  snapshotToStatsSourceDTO,
  STORAGE_FRESHNESS_MS,
  type OpsReportDb,
  type OpsReportHttpServices,
  type OpsSnapshotRecord,
} from '../src/lib/server/ops/ops-report';

const execFileAsync = promisify(execFile);
const ORIGIN = 'http://localhost:3000';
const SECRET = 'm6t3-local-cron-secret-0123456789abcdef';
const CONTEXT = { timezone: 'UTC', timezoneRevision: 1, queriedAt: '2026-11-27T12:00:00.000Z' };
const NOW = new Date('2026-11-27T12:00:00.000Z');
const SCOPE = {
  from: '2026-11-27',
  toExclusive: '2026-11-28',
  startUtc: '2026-11-27T00:00:00.000Z',
  endUtc: '2026-11-28T00:00:00.000Z',
  productSlug: undefined as string | undefined,
  timezone: 'UTC',
  timezoneRevision: 1,
};
const OPS_REPORT_SCRIPT = path.resolve(process.cwd(), 'deploy', 'ops-report.py');

function resolvePythonBin(): string {
  for (const bin of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    try {
      const out = execFileSync(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      if (/Python 3\./i.test(out)) return bin;
    } catch {
      // try next candidate
    }
  }
  throw new Error('Python 3 executable is required for deploy/ops-report.py tests');
}

const PYTHON_BIN = resolvePythonBin();

async function runOpsReportScript(
  args: string[],
  envOverrides: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const drop of ['NBSHIYAN_DATA_DIR', 'NBSHIYAN_APP_ENV_FILE', 'CRON_SECRET', 'OPS_REPORT_URL']) {
    delete env[drop];
  }
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  try {
    const { stdout, stderr } = await execFileAsync(PYTHON_BIN, [OPS_REPORT_SCRIPT, ...args], {
      env: env as NodeJS.ProcessEnv,
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeNoopCounter() {
  const recorded: Array<{ routeId: string; status: number }> = [];
  return {
    recorded,
    apiCounter: {
      async recordFinalResponse<T>(response: { routeId: string; status: number; body: T }) {
        recorded.push({ routeId: response.routeId, status: response.status });
        return { status: response.status, body: response.body, recorded: true };
      },
    },
  };
}

function makeFakeReportHttp(submitImpl?: (raw: unknown) => Promise<{ accepted: boolean; measuredAt: string }>): {
  services: OpsReportHttpServices;
  recorded: Array<{ routeId: string; status: number }>;
  submitted: unknown[];
} {
  const { apiCounter, recorded } = makeNoopCounter();
  const submitted: unknown[] = [];
  const services: OpsReportHttpServices = {
    apiCounter,
    opsReport: {
      async submit(raw) {
        submitted.push(raw);
        if (submitImpl) return submitImpl(raw);
        const body = raw as { measuredAt: string };
        return OpsReportReceiptDTOSchema.parse({ accepted: true, measuredAt: body.measuredAt });
      },
      async readSnapshots() {
        return {};
      },
    },
  };
  return { services, recorded, submitted };
}

function findSource(dto: StatsDTO, source: StatsSource) {
  const hit = dto.sources.find((item) => item.source === source);
  assert.ok(hit, `expected source ${source}`);
  return hit;
}

describe('M6-T3 ops-report, deploy script, ops-sample wiring & pure rules (no database)', () => {
  test('POST /api/internal/ops-report 鉴权与输入校验：缺/错 Bearer、session cookie 401，超 8KiB 413，任意路径/内容 400', async () => {
    const { services, submitted } = makeFakeReportHttp();
    const validBody = JSON.stringify({
      source: 'STORAGE',
      measuredAt: '2026-11-27T12:00:00.000Z',
      status: 'OK',
      values: { bytesUsed: 1024, bytesFree: 4096 },
    });

    // 缺 Bearer、错 Bearer、未配 CRON_SECRET、只带后台 session cookie 均 401
    for (const [headers, secret] of [
      [{ 'content-type': 'application/json' }, SECRET],
      [{ 'content-type': 'application/json', authorization: 'Bearer wrong-secret' }, SECRET],
      [{ 'content-type': 'application/json', authorization: `Bearer ${SECRET}` }, undefined],
      [{ 'content-type': 'application/json', cookie: 'authjs.session-token=fake-admin-session' }, SECRET],
    ] as const) {
      const res = await handlePostOpsReport(
        new Request(`${ORIGIN}/api/internal/ops-report`, { method: 'POST', headers, body: validBody }),
        services,
        { secret },
      );
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      const json = (await res.json()) as { error: string; requestId: string };
      assert.equal(json.error, 'unauthorized');
      assert.ok(json.requestId);
    }

    // 超 8KiB 限体 → 413 too_large（不进入 JSON 解析和业务服务）
    const oversized = JSON.stringify({
      source: 'STORAGE',
      measuredAt: '2026-11-27T12:00:00.000Z',
      status: 'OK',
      padding: 'x'.repeat(OPS_REPORT_MAX_BODY_BYTES + 256),
    });
    const tooLargeRes = await handlePostOpsReport(
      new Request(`${ORIGIN}/api/internal/ops-report`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: oversized,
      }),
      services,
      { secret: SECRET },
    );
    assert.equal(tooLargeRes.status, 413);
    assert.equal(((await tooLargeRes.json()) as { error: string }).error, 'too_large');

    // 非法 JSON → 400 invalid
    const badJsonRes = await handlePostOpsReport(
      new Request(`${ORIGIN}/api/internal/ops-report`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: '{broken',
      }),
      services,
      { secret: SECRET },
    );
    assert.equal(badJsonRes.status, 400);
    assert.equal(((await badJsonRes.json()) as { error: string }).error, 'invalid');
    assert.equal(submitted.length, 0);

    // 真实 submit 校验层拒绝任意路径、内容、主机、备份时间晚于测量时间、负数等
    const realService = (await import('../src/lib/server/ops/ops-report')).createOpsReportService({
      db: { $transaction: async () => { throw new Error('db should not be touched on invalid payload'); } } as unknown as OpsReportDb,
    });
    const badPayloads: unknown[] = [
      { source: 'STORAGE', measuredAt: '2026-11-27T12:00:00.000Z', status: 'OK', path: '/etc/passwd', values: { bytesUsed: 1, bytesFree: 2 } },
      { source: 'STORAGE', measuredAt: '2026-11-27T12:00:00.000Z', status: 'OK', values: { bytesUsed: 1, bytesFree: 2, filePath: '/data/uploads' } },
      { source: 'BACKUP', measuredAt: '2026-11-27T12:00:00.000Z', status: 'OK', values: { backupCompletedAt: '2026-11-27T11:00:00.000Z', backupAgeSeconds: 3600, verified: false, dumpContent: 'PGDMP' } },
      { source: 'BACKUP', measuredAt: '2026-11-27T12:00:00.000Z', status: 'OK', values: { backupCompletedAt: '2026-11-27T12:01:00.000Z', backupAgeSeconds: 0, verified: false } },
      { source: 'STORAGE', measuredAt: '2026-11-27T12:00:00.000Z', status: 'OK', values: { bytesUsed: -1, bytesFree: 100 } },
      { source: 'SHELL', measuredAt: '2026-11-27T12:00:00.000Z', status: 'OK', command: 'ls' },
    ];
    for (const payload of badPayloads) {
      const res = await handlePostOpsReport(
        new Request(`${ORIGIN}/api/internal/ops-report`, {
          method: 'POST',
          headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        { opsReport: realService, apiCounter: services.apiCounter },
        { secret: SECRET },
      );
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
      assert.equal(((await res.json()) as { error: string }).error, 'invalid');
    }

    // 路由文件源码校验与子进程模块导出校验（不提前加载 db.ts / composition.ts 单例）
    const routeSrc = readFileSync(path.resolve(process.cwd(), 'src/app/api/internal/ops-report/route.ts'), 'utf8');
    assert.match(routeSrc, /export function POST\(/);
    assert.doesNotMatch(routeSrc, /export (async )?function GET\b|export const GET\b/);
    assert.doesNotMatch(routeSrc, /requireAdmin|auth\(/, 'ops-report route must not use browser session auth');
  });

  test('canonicalOpsReportHash：UTC 毫秒格式与键序归一化幂等，任意值或状态变化产生不同哈希', () => {
    const a: OpsReportRequestDTO = {
      source: 'STORAGE',
      measuredAt: '2026-11-27T12:00:00Z',
      status: 'OK',
      values: { bytesUsed: 512, bytesFree: 1024 },
    };
    const b: OpsReportRequestDTO = {
      source: 'STORAGE',
      measuredAt: '2026-11-27T12:00:00.000Z',
      status: 'OK',
      values: { bytesFree: 1024, bytesUsed: 512 },
    };
    const c: OpsReportRequestDTO = {
      source: 'STORAGE',
      measuredAt: '2026-11-27T12:00:00.000Z',
      status: 'OK',
      values: { bytesUsed: 513, bytesFree: 1024 },
    };
    const failA: OpsReportRequestDTO = {
      source: 'BACKUP',
      measuredAt: '2026-11-27T12:00:00Z',
      status: 'FAILED',
      safeErrorCode: 'service_unavailable',
    };
    const failB: OpsReportRequestDTO = {
      source: 'BACKUP',
      measuredAt: '2026-11-27T12:00:00.000Z',
      status: 'FAILED',
      values: null,
      safeErrorCode: 'service_unavailable',
    };
    const failC: OpsReportRequestDTO = {
      source: 'BACKUP',
      measuredAt: '2026-11-27T12:00:00.000Z',
      status: 'FAILED',
      safeErrorCode: 'source_unavailable',
    };

    assert.equal(canonicalOpsReportHash(a), canonicalOpsReportHash(b));
    assert.notEqual(canonicalOpsReportHash(a), canonicalOpsReportHash(c));
    assert.equal(canonicalOpsReportHash(failA), canonicalOpsReportHash(failB));
    assert.notEqual(canonicalOpsReportHash(failA), canonicalOpsReportHash(failC));
  });

  test('deploy/ops-report.py 拒绝任意路径、密钥、URL CLI 参数及非回环 OPS_REPORT_URL', async () => {
    const dir = makeTempDir('nbshiyan-ops-cli-');
    try {
      for (const badArgs of [
        ['--path', '/etc/passwd'],
        ['--dir', dir],
        ['--secret', SECRET],
        ['--url', 'https://evil.example/api/internal/ops-report'],
        ['/etc/shadow'],
      ]) {
        const res = await runOpsReportScript(badArgs, { NBSHIYAN_DATA_DIR: dir, CRON_SECRET: SECRET });
        assert.notEqual(res.code, 0, `expected rejection for args ${badArgs.join(' ')}`);
      }

      // 拒绝非回环或非法路径的 OPS_REPORT_URL
      for (const badUrl of [
        'https://evil.example/api/internal/ops-report',
        'http://169.254.169.254/api/internal/ops-report',
        'http://127.0.0.1:3000/api/admin/stats',
        'http://127.0.0.1:3000/api/internal/ops-report?extra=1',
      ]) {
        const res = await runOpsReportScript(['--dry-run'], {
          NBSHIYAN_DATA_DIR: dir,
          OPS_REPORT_URL: badUrl,
        });
        assert.equal(res.code, 2, `expected config_error for URL ${badUrl}`);
        assert.equal(res.stderr.includes(badUrl), false, 'stderr must not echo raw URL');
      }

      // 拒绝相对路径 NBSHIYAN_DATA_DIR
      const rel = await runOpsReportScript(['--dry-run'], { NBSHIYAN_DATA_DIR: 'relative/path' });
      assert.equal(rel.code, 2);
      assert.equal(rel.stderr.includes('relative/path'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deploy/ops-report.py 只读采集 STORAGE 与 BACKUP：无验证来源 NOT_CONNECTED、跳过符号链接、既有 backup.log 恒 verified=false、显式恢复验证才 true（E-65）', async () => {
    const dir = makeTempDir('nbshiyan-ops-collect-');
    const outside = makeTempDir('nbshiyan-ops-outside-');
    try {
      // 1) 空数据目录（无 uploads、无 backup）：两者皆 NOT_CONNECTED，无任何路径泄露
      const emptyRes = await runOpsReportScript(['--dry-run'], { NBSHIYAN_DATA_DIR: dir });
      assert.equal(emptyRes.code, 0, emptyRes.stderr);
      assert.equal(emptyRes.stdout.includes(dir), false, 'output must never contain host paths');
      const emptyPayloads = JSON.parse(emptyRes.stdout) as OpsReportRequestDTO[];
      assert.equal(emptyPayloads.length, 2);
      assert.equal(emptyPayloads[0]!.source, 'STORAGE');
      assert.equal(emptyPayloads[0]!.status, 'NOT_CONNECTED');
      assert.equal(emptyPayloads[1]!.source, 'BACKUP');
      assert.equal(emptyPayloads[1]!.status, 'NOT_CONNECTED');

      // 2) uploads 含普通文件 + 符号链接；backup 只有孤立文件和未完成 .dump.part（无完成证明 → NOT_CONNECTED）
      const uploadsDir = path.join(dir, 'uploads');
      const backupDir = path.join(dir, 'backup');
      mkdirSync(path.join(uploadsDir, 'nested'), { recursive: true });
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(path.join(uploadsDir, 'a.bin'), Buffer.alloc(120, 1));
      writeFileSync(path.join(uploadsDir, 'nested', 'b.bin'), Buffer.alloc(80, 2));
      writeFileSync(path.join(outside, 'secret.txt'), Buffer.alloc(9999, 3));
      try {
        symlinkSync(path.join(outside, 'secret.txt'), path.join(uploadsDir, 'escape-link'));
      } catch {
        // Windows without Developer Mode may disallow symlink creation; skip link assertion only if OS denies symlink creation
      }
      // 孤立普通文件、未完成 .dump.part、甚至没有日志/元数据证明的裸 .dump 都不能假装备份完成
      writeFileSync(path.join(backupDir, 'random-upload.txt'), 'not a backup');
      writeFileSync(path.join(backupDir, 'nbshiyan-daily-20261127-0430.dump.part'), 'partial');
      writeFileSync(path.join(backupDir, 'nbshiyan-daily-20261127-0430.dump'), 'PGDMP-SYNTHETIC');

      const unverifiedRes = await runOpsReportScript(['--dry-run'], { NBSHIYAN_DATA_DIR: dir });
      assert.equal(unverifiedRes.code, 0, unverifiedRes.stderr);
      const unverified = JSON.parse(unverifiedRes.stdout) as OpsReportRequestDTO[];
      const storage1 = unverified.find((item) => item.source === 'STORAGE');
      const backup1 = unverified.find((item) => item.source === 'BACKUP');
      assert.equal(storage1?.status, 'OK');
      assert.equal(storage1?.values?.bytesUsed, 200, 'must count only regular files and never follow symlink');
      assert.ok(typeof storage1?.values?.bytesFree === 'number' && storage1.values.bytesFree >= 0);
      assert.equal(backup1?.status, 'NOT_CONNECTED', 'unverified files without completion metadata must stay NOT_CONNECTED');

      // 3) 既有 backup-postgres.sh 完成日志 + 真实非空 .dump → OK 且 verified 恒为 false（不把 --list 当恢复验证）
      const dumpPath = path.join(backupDir, 'nbshiyan-daily-20261127-0430.dump');
      const past = new Date(Date.now() - 120_000);
      utimesSync(dumpPath, past, past);
      writeFileSync(
        path.join(backupDir, 'backup.log'),
        '[backup] nbshiyan-daily-20261127-0430.dump 16K; dir total 1 MB\n',
      );
      const logRes = await runOpsReportScript(['--source', 'backup', '--dry-run'], { NBSHIYAN_DATA_DIR: dir });
      assert.equal(logRes.code, 0, logRes.stderr);
      const logPayloads = JSON.parse(logRes.stdout) as OpsReportRequestDTO[];
      assert.equal(logPayloads.length, 1);
      assert.equal(logPayloads[0]!.source, 'BACKUP');
      assert.equal(logPayloads[0]!.status, 'OK');
      assert.equal(logPayloads[0]!.values?.verified, false);
      assert.ok((logPayloads[0]!.values?.backupAgeSeconds ?? -1) >= 100);
      assert.equal(logRes.stdout.includes('nbshiyan-daily-20261127-0430.dump'), false, 'output must never leak archive filename');
      assert.equal(logRes.stdout.includes('PGDMP-SYNTHETIC'), false, 'output must never leak dump content');

      // 4) R1：昨日已验证 backup-meta.json 不能遮蔽今日 backup.log 新归档；按最新可信完成时间选归档且验证只属对应归档
      const yesterdayCompleted = new Date(Date.now() - 24 * 3600_000);
      const yesterdayVerified = new Date(Date.now() - 23 * 3600_000);
      const yesterdayDump = path.join(backupDir, 'nbshiyan-daily-20261126-0430.dump');
      writeFileSync(yesterdayDump, 'PGDMP-YESTERDAY');
      utimesSync(yesterdayDump, yesterdayCompleted, yesterdayCompleted);
      writeFileSync(
        path.join(backupDir, 'backup-meta.json'),
        JSON.stringify({
          archiveName: 'nbshiyan-daily-20261126-0430.dump',
          backupCompletedAt: yesterdayCompleted.toISOString(),
          restoreVerified: true,
          restoreVerifiedAt: yesterdayVerified.toISOString(),
        }),
      );
      writeFileSync(
        path.join(backupDir, 'backup.log'),
        [
          '[backup] nbshiyan-daily-20261126-0430.dump 16K; dir total 1 MB',
          '[backup] nbshiyan-daily-20261127-0430.dump 16K; dir total 2 MB',
        ].join('\n') + '\n',
      );
      const newerUnverifiedRes = await runOpsReportScript(['--source', 'backup', '--dry-run'], { NBSHIYAN_DATA_DIR: dir });
      assert.equal(newerUnverifiedRes.code, 0, newerUnverifiedRes.stderr);
      const newerUnverified = (JSON.parse(newerUnverifiedRes.stdout) as OpsReportRequestDTO[])[0]!;
      assert.equal(newerUnverified.source, 'BACKUP');
      assert.equal(newerUnverified.status, 'OK');
      assert.equal(newerUnverified.values?.verified, false, 'yesterday verification must never apply to today archive');
      const reportedTodayMs = Date.parse(newerUnverified.values?.backupCompletedAt ?? '');
      assert.ok(
        Math.abs(reportedTodayMs - past.getTime()) <= 2_000,
        `expected today completion time ~${past.toISOString()}, got ${newerUnverified.values?.backupCompletedAt}`,
      );

      // 5) 显式对今日同一归档写入 restoreVerified=true 且 restoreVerifiedAt >= backupCompletedAt 的 backup-meta.json → verified=true
      const completedIso = new Date(Date.now() - 300_000).toISOString();
      const verifiedIso = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(
        path.join(backupDir, 'backup-meta.json'),
        JSON.stringify({
          archiveName: 'nbshiyan-daily-20261127-0430.dump',
          backupCompletedAt: completedIso,
          restoreVerified: true,
          restoreVerifiedAt: verifiedIso,
        }),
      );
      const verifiedRes = await runOpsReportScript(['--source', 'backup', '--dry-run'], { NBSHIYAN_DATA_DIR: dir });
      assert.equal(verifiedRes.code, 0, verifiedRes.stderr);
      const verifiedPayloads = JSON.parse(verifiedRes.stdout) as OpsReportRequestDTO[];
      const verifiedBackup = verifiedPayloads[0]!;
      assert.equal(verifiedBackup.source, 'BACKUP');
      assert.equal(verifiedBackup.status, 'OK');
      assert.equal(verifiedBackup.values?.verified, true);

      // 6) 损坏或引用缺失归档的 backup-meta.json → FAILED（绝不假报 OK）
      writeFileSync(
        path.join(backupDir, 'backup-meta.json'),
        JSON.stringify({
          archiveName: 'nbshiyan-daily-20990101-0000.dump',
          backupCompletedAt: completedIso,
          restoreVerified: true,
          restoreVerifiedAt: verifiedIso,
        }),
      );
      const corruptRes = await runOpsReportScript(['--source', 'backup', '--dry-run'], { NBSHIYAN_DATA_DIR: dir });
      assert.equal(corruptRes.code, 0, corruptRes.stderr);
      const corruptPayloads = JSON.parse(corruptRes.stdout) as OpsReportRequestDTO[];
      assert.equal(corruptPayloads[0]!.status, 'FAILED');
      assert.equal(corruptPayloads[0]!.safeErrorCode, 'service_unavailable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('R3：deploy/ops-report.py 拒绝 3xx 自动重定向且无第二次请求，原地址 5xx 至多重试一次', async () => {
    const dir = makeTempDir('nbshiyan-ops-r3-');
    const fakeSecret = 'fake-r3-bearer-credential-must-not-redirect-0123456789';
    let mode: { kind: 'redirect'; status: number } | { kind: 'always503' } | { kind: 'flaky503' } = {
      kind: 'redirect',
      status: 302,
    };
    let hits: Array<{ method: string; url: string; auth: string | undefined; body: string }> = [];

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        hits.push({
          method: req.method ?? '',
          url: req.url ?? '',
          auth: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
          body,
        });
        if (req.url === '/redirect-sink') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, measuredAt: new Date().toISOString() }));
          return;
        }
        if (mode.kind === 'redirect') {
          const { port } = server.address() as AddressInfo;
          res.writeHead(mode.status, { Location: `http://127.0.0.1:${port}/redirect-sink` });
          res.end();
          return;
        }
        if (mode.kind === 'always503' || (mode.kind === 'flaky503' && hits.length === 1)) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'service_unavailable' }));
          return;
        }
        const parsed = JSON.parse(body) as { measuredAt: string };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, measuredAt: parsed.measuredAt }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const reportUrl = `http://127.0.0.1:${port}/api/internal/ops-report`;

      for (const status of [301, 302, 303, 307, 308]) {
        hits = [];
        mode = { kind: 'redirect', status };
        const res = await runOpsReportScript(['--source', 'storage'], {
          NBSHIYAN_DATA_DIR: dir,
          CRON_SECRET: fakeSecret,
          OPS_REPORT_URL: reportUrl,
        });
        assert.notEqual(res.code, 0, `3xx status ${status} must fail closed`);
        assert.equal(hits.length, 1, `status ${status} must not issue a second request`);
        assert.equal(hits[0]!.url, '/api/internal/ops-report');
        assert.equal(hits.some((hit) => hit.url === '/redirect-sink'), false);
        assert.equal(res.stdout.includes(fakeSecret), false);
        assert.equal(res.stderr.includes(fakeSecret), false);
        assert.equal(res.stdout.includes('/redirect-sink'), false);
        assert.equal(res.stderr.includes('/redirect-sink'), false);
      }

      // 原地址持续 503：至多重试一次（总请求严格等于 2）
      hits = [];
      mode = { kind: 'always503' };
      const alwaysFail = await runOpsReportScript(['--source', 'storage'], {
        NBSHIYAN_DATA_DIR: dir,
        CRON_SECRET: fakeSecret,
        OPS_REPORT_URL: reportUrl,
      });
      assert.notEqual(alwaysFail.code, 0);
      assert.equal(hits.length, 2, '5xx must retry at most once');
      assert.equal(hits[0]!.body, hits[1]!.body);

      // 原地址首请 503、次请 200：精确重试一次成功
      hits = [];
      mode = { kind: 'flaky503' };
      const recovered = await runOpsReportScript(['--source', 'storage'], {
        NBSHIYAN_DATA_DIR: dir,
        CRON_SECRET: fakeSecret,
        OPS_REPORT_URL: reportUrl,
      });
      assert.equal(recovered.code, 0, `${recovered.stdout}\n${recovered.stderr}`);
      assert.equal(hits.length, 2);
      assert.equal(hits[0]!.auth, `Bearer ${fakeSecret}`);
      assert.equal(hits[1]!.auth, `Bearer ${fakeSecret}`);
      assert.equal(hits[0]!.body, hits[1]!.body);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('R4：deploy/ops-report.py 按部署 compose.env 解析自定义 0600 应用环境文件，默认 .env 缺失仍成功且参数日志不含凭据', async () => {
    const dataDir = makeTempDir('nbshiyan-ops-r4-data-');
    const customDir = makeTempDir('nbshiyan-ops-r4-custom-');
    const customSecret = 'fake-r4-custom-env-file-secret-abcdef0123456789';
    const customEnvFile = path.join(customDir, 'prod-custom.env');
    const composeEnvFile = path.join(dataDir, 'compose.env');
    const receivedAuth: Array<string | undefined> = [];

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receivedAuth.push(typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined);
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { measuredAt: string };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, measuredAt: parsed.measuredAt }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const reportUrl = `http://127.0.0.1:${port}/api/internal/ops-report`;

      // 默认 dataDir/.env 不存在；部署生成的 compose.env 指向自定义 0600 环境文件
      writeFileSync(customEnvFile, `APP_ENV=production\nCRON_SECRET="${customSecret}"\n`);
      writeFileSync(
        composeEnvFile,
        `NBSHIYAN_DATA_DIR=${dataDir}\nNBSHIYAN_APP_ENV_FILE=${customEnvFile}\nAPP_TAG=current\n`,
      );
      if (process.platform !== 'win32') {
        chmodSync(customEnvFile, 0o600);
        chmodSync(composeEnvFile, 0o600);
      }

      // 模拟 deploy/cron.nbshiyan:29：仅传 NBSHIYAN_DATA_DIR（不传 CRON_SECRET / NBSHIYAN_APP_ENV_FILE）
      const okRes = await runOpsReportScript(['--source', 'storage'], {
        NBSHIYAN_DATA_DIR: dataDir,
        OPS_REPORT_URL: reportUrl,
      });
      assert.equal(okRes.code, 0, `${okRes.stdout}\n${okRes.stderr}`);
      assert.deepEqual(receivedAuth, [`Bearer ${customSecret}`]);
      assert.equal(okRes.stdout.includes(customSecret), false);
      assert.equal(okRes.stderr.includes(customSecret), false);
      assert.equal(okRes.stdout.includes(customEnvFile), false);
      assert.equal(okRes.stderr.includes(customEnvFile), false);
      assert.equal(okRes.stdout.includes(dataDir), false);

      // POSIX 下自定义环境文件非 0600 时必须 fail closed
      if (process.platform !== 'win32') {
        chmodSync(customEnvFile, 0o644);
        const badModeRes = await runOpsReportScript(['--source', 'storage'], {
          NBSHIYAN_DATA_DIR: dataDir,
          OPS_REPORT_URL: reportUrl,
        });
        assert.equal(badModeRes.code, 2);
        assert.match(badModeRes.stderr, /code=env_file_insecure_perms/);
        assert.equal(badModeRes.stderr.includes(customEnvFile), false);
        chmodSync(customEnvFile, 0o600);
      }

      // compose.env 指向不存在的自定义环境文件时，即使默认 .env 存在也绝不静默回退
      const defaultEnvFile = path.join(dataDir, '.env');
      writeFileSync(defaultEnvFile, 'CRON_SECRET=fallback-default-secret-should-not-be-used\n');
      if (process.platform !== 'win32') chmodSync(defaultEnvFile, 0o600);
      writeFileSync(
        composeEnvFile,
        `NBSHIYAN_DATA_DIR=${dataDir}\nNBSHIYAN_APP_ENV_FILE=${path.join(customDir, 'missing.env')}\nAPP_TAG=current\n`,
      );
      if (process.platform !== 'win32') chmodSync(composeEnvFile, 0o600);
      const missingCustomRes = await runOpsReportScript(['--source', 'storage'], {
        NBSHIYAN_DATA_DIR: dataDir,
        OPS_REPORT_URL: reportUrl,
      });
      assert.equal(missingCustomRes.code, 2);
      assert.match(missingCustomRes.stderr, /code=env_file_unreadable/);
      assert.equal(receivedAuth.length, 1, 'must not fall back to default .env when compose.env points elsewhere');

      // 无 compose.env 时回退默认 0600 .env 仍可用
      rmSync(composeEnvFile, { force: true });
      const fallbackRes = await runOpsReportScript(['--source', 'storage'], {
        NBSHIYAN_DATA_DIR: dataDir,
        OPS_REPORT_URL: reportUrl,
      });
      assert.equal(fallbackRes.code, 0, `${fallbackRes.stdout}\n${fallbackRes.stderr}`);
      assert.equal(receivedAuth[1], 'Bearer fallback-default-secret-should-not-be-used');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  test('ops-sample 注册与单向架构边界：registry 导出 key 不导入 ops、composition 构造期不读库、deploy/cron.nbshiyan 每 15 分钟双条目无硬编码密钥与默认 .env', async () => {
    const registrySrc = readFileSync(path.resolve(process.cwd(), 'src/lib/server/jobs/registry.ts'), 'utf8');
    assert.doesNotMatch(registrySrc, /\.\.\/ops\//, 'registry.ts must never import M6 ops implementation');

    // 在独立子进程里校验组合点、作业工厂与路由导出，避免 Suite 1 提前缓存 db.ts / auth.ts 模块单例
    const probeScript = [
      "const assert = require('node:assert/strict');",
      "const { OPS_SAMPLE_JOB_KEY } = require('./src/lib/server/jobs/registry');",
      "const { createOpsSampleJob } = require('./src/lib/server/ops/ops-sample');",
      "const { createJobServices } = require('./src/lib/server/composition');",
      "const route = require('./src/app/api/internal/ops-report/route');",
      "assert.equal(OPS_SAMPLE_JOB_KEY, 'ops-sample');",
      "const neverDb = new Proxy({}, { get: () => { throw new Error('db touched during construction'); } });",
      "assert.equal(createOpsSampleJob({ db: neverDb }).key, 'ops-sample');",
      "const services = createJobServices({ db: neverDb, deleteAuthorized: false });",
      "assert.equal(services.jobs.has('ops-sample'), true);",
      "assert.equal(services.jobs.keys().includes('ops-sample'), true);",
      "assert.equal(typeof route.POST, 'function');",
      "assert.equal(typeof route.GET, 'undefined');",
    ].join('\n');
    execFileSync(process.execPath, ['--import', 'tsx', '-e', probeScript], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test' },
      stdio: 'pipe',
    });

    const cron = readFileSync(path.resolve(process.cwd(), 'deploy/cron.nbshiyan'), 'utf8');
    const lines = cron.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'));

    const sampleLines = lines.filter(
      (line) => line.includes('/api/admin/cron/operations') && line.includes("jobKey:'ops-sample'"),
    );
    assert.equal(sampleLines.length, 1, 'deploy/cron.nbshiyan must have exactly one ops-sample operations line');
    const sampleLine = sampleLines[0]!;
    assert.match(sampleLine, /^\*\/15 \* \* \* \* /);
    assert.match(sampleLine, /method:'POST'/);
    assert.match(sampleLine, /process\.env\.CRON_SECRET/);
    assert.equal(sampleLine.replaceAll('process.env.CRON_SECRET', '').includes('CRON_SECRET'), false);
    assert.match(sampleLine, /AbortSignal\.timeout\(55000\)/);
    assert.match(sampleLine, /r\.status===409\?0:1/);
    assert.match(sampleLine, />> @DATA_DIR@\/cron-ops-sample\.log 2>&1$/);

    const reportLines = lines.filter((line) => line.includes('deploy/ops-report.py'));
    assert.equal(reportLines.length, 1, 'deploy/cron.nbshiyan must have exactly one controlled ops-report.py line');
    const reportLine = reportLines[0]!;
    assert.match(reportLine, /^\*\/15 \* \* \* \* /);
    assert.match(reportLine, /NBSHIYAN_DATA_DIR=@DATA_DIR@/);
    assert.equal(
      reportLine.includes('NBSHIYAN_APP_ENV_FILE='),
      false,
      'host cron line must not hardcode NBSHIYAN_APP_ENV_FILE=@DATA_DIR@/.env; script resolves compose.env',
    );
    assert.equal(reportLine.includes('CRON_SECRET'), false, 'host cron line must never pass CRON_SECRET on argv');
    assert.doesNotMatch(reportLine, /--(path|dir|file|secret|token|url)\b/);
    assert.match(reportLine, />> @DATA_DIR@\/cron-ops-report\.log 2>&1$/);
  });

  test('snapshotToStatsSourceDTO：storage/backup 零值、正常、45m/36h 过期旧值、FAILED 保留旧值/无旧值、未验证备份 partial 与脏快照降级（E-65、E-67）', () => {
    const t0 = new Date(NOW.getTime() - 10 * 60_000);
    const baseHash = 'a'.repeat(64);

    // 无快照 / NOT_CONNECTED -> not_connected
    assert.equal(snapshotToStatsSourceDTO(CONTEXT, 'storage', null, NOW).state, 'not_connected');
    assert.equal(snapshotToStatsSourceDTO(CONTEXT, 'backup', null, NOW).state, 'not_connected');
    assert.equal(
      snapshotToStatsSourceDTO(CONTEXT, 'storage', {
        source: 'STORAGE', status: 'NOT_CONNECTED', measuredAt: t0, lastSucceededAt: null, values: null, safeErrorCode: 'source_unavailable', payloadHash: baseHash,
      }, NOW).state,
      'not_connected',
    );

    // STORAGE 0 字节 -> zero；非零 -> ok；>=45min -> stale 保留原时间
    const zeroStorage = snapshotToStatsSourceDTO(CONTEXT, 'storage', {
      source: 'STORAGE', status: 'OK', measuredAt: t0, lastSucceededAt: t0, values: { bytesUsed: 0, bytesFree: 2048 }, safeErrorCode: null, payloadHash: baseHash,
    }, NOW);
    assert.deepEqual([zeroStorage.state, zeroStorage.value, zeroStorage.coverage, zeroStorage.lastSucceededAt], ['zero', 0, 'full', t0.toISOString()]);

    const staleTime = new Date(NOW.getTime() - STORAGE_FRESHNESS_MS);
    const staleStorage = snapshotToStatsSourceDTO(CONTEXT, 'storage', {
      source: 'STORAGE', status: 'OK', measuredAt: staleTime, lastSucceededAt: staleTime, values: { bytesUsed: 4096, bytesFree: 8192 }, safeErrorCode: null, payloadHash: baseHash,
    }, NOW);
    assert.deepEqual([staleStorage.state, staleStorage.value, staleStorage.lastSucceededAt, staleStorage.dataThrough], ['stale', 4096, staleTime.toISOString(), staleTime.toISOString()]);

    // STORAGE FAILED 有旧值 -> stale + partial + 原成功时间；无旧值 -> query_failed
    const failedWithOld = snapshotToStatsSourceDTO(CONTEXT, 'storage', {
      source: 'STORAGE', status: 'FAILED', measuredAt: NOW, lastSucceededAt: t0, values: { bytesUsed: 2048, bytesFree: 8192 }, safeErrorCode: 'service_unavailable', payloadHash: baseHash,
    }, NOW);
    assert.deepEqual([failedWithOld.state, failedWithOld.value, failedWithOld.coverage, failedWithOld.lastSucceededAt, failedWithOld.dataThrough], ['stale', 2048, 'partial', t0.toISOString(), t0.toISOString()]);

    const failedNoOld = snapshotToStatsSourceDTO(CONTEXT, 'storage', {
      source: 'STORAGE', status: 'FAILED', measuredAt: NOW, lastSucceededAt: null, values: null, safeErrorCode: 'service_unavailable', payloadHash: baseHash,
    }, NOW);
    assert.deepEqual([failedNoOld.state, failedNoOld.value, failedNoOld.lastSucceededAt], ['query_failed', null, null]);

    // BACKUP verified=false -> partial（不标可恢复）；verified=true -> full；>=36h -> stale 保留原时间
    const completedAt = new Date(NOW.getTime() - 2 * 60 * 60_000);
    const unverifiedBackup = snapshotToStatsSourceDTO(CONTEXT, 'backup', {
      source: 'BACKUP', status: 'OK', measuredAt: t0, lastSucceededAt: t0,
      values: { backupCompletedAt: completedAt.toISOString(), backupAgeSeconds: 6600, verified: false },
      safeErrorCode: null, payloadHash: baseHash,
    }, NOW);
    assert.deepEqual(
      [unverifiedBackup.state, unverifiedBackup.value, unverifiedBackup.coverage, unverifiedBackup.dataThrough, unverifiedBackup.lastSucceededAt],
      ['ok', 6600, 'partial', completedAt.toISOString(), t0.toISOString()],
    );

    const verifiedBackup = snapshotToStatsSourceDTO(CONTEXT, 'backup', {
      source: 'BACKUP', status: 'OK', measuredAt: t0, lastSucceededAt: t0,
      values: { backupCompletedAt: completedAt.toISOString(), backupAgeSeconds: 6600, verified: true },
      safeErrorCode: null, payloadHash: baseHash,
    }, NOW);
    assert.equal(verifiedBackup.coverage, 'full');

    const oldCompletedAt = new Date(NOW.getTime() - BACKUP_FRESHNESS_MS);
    const staleBackup = snapshotToStatsSourceDTO(CONTEXT, 'backup', {
      source: 'BACKUP', status: 'OK', measuredAt: t0, lastSucceededAt: t0,
      values: { backupCompletedAt: oldCompletedAt.toISOString(), backupAgeSeconds: 129000, verified: false },
      safeErrorCode: null, payloadHash: baseHash,
    }, NOW);
    assert.deepEqual([staleBackup.state, staleBackup.dataThrough, staleBackup.lastSucceededAt], ['stale', oldCompletedAt.toISOString(), t0.toISOString()]);

    // 脏载荷（被外部篡改）降级 query_failed
    const corrupt: OpsSnapshotRecord = {
      source: 'STORAGE', status: 'OK', measuredAt: t0, lastSucceededAt: t0,
      values: { bytesUsed: 'corrupt' }, safeErrorCode: null, payloadHash: baseHash,
    };
    assert.equal(snapshotToStatsSourceDTO(CONTEXT, 'storage', corrupt, NOW).state, 'query_failed');
  });

  test('createOpsSourceReaders：非 ADMIN 二次拒绝 403、单源 DB 异常独立降级 query_failed 不影响其余来源（E-66、E-67）', async () => {
    const failingDb = {
      async $transaction() {
        throw new Error('storage snapshot connection error');
      },
    } as unknown as OpsReportDb;
    const readers = createOpsSourceReaders(failingDb);

    for (const role of ['SALES', 'EDITOR'] as const) {
      await assert.rejects(
        async () => readers.storage({ role, scope: SCOPE, context: CONTEXT, now: NOW, connected: true }),
        (err: unknown) => err instanceof AppError && err.code === 'forbidden',
      );
      await assert.rejects(
        async () => readers.backup({ role, scope: SCOPE, context: CONTEXT, now: NOW, connected: true }),
        (err: unknown) => err instanceof AppError && err.code === 'forbidden',
      );
    }

    const failedStorage = await readers.storage({ role: 'ADMIN', scope: SCOPE, context: CONTEXT, now: NOW, connected: true });
    assert.equal(failedStorage.state, 'query_failed');
    assert.equal(failedStorage.value, null);
    assert.equal(failedStorage.lastSucceededAt, null);
  });

  test('sampleControlledLocalStorage：仅受控 local + UPLOAD_DIR 统计普通文件字节与 statfs 空间，跳过符号链接，未配置不伪造（E-65）', async () => {
    const dir = makeTempDir('nbshiyan-ops-local-');
    try {
      const missingDir = path.join(dir, 'missing');
      mkdirSync(path.join(dir, 'sub'), { recursive: true });
      writeFileSync(path.join(dir, 'one.bin'), Buffer.alloc(300, 7));
      writeFileSync(path.join(dir, 'sub', 'two.bin'), Buffer.alloc(450, 8));

      const script = [
        '(async () => {',
        "  const assert = require('node:assert/strict');",
        "  const { sampleControlledLocalStorage } = require('./src/lib/server/ops/ops-sample');",
        '  const signal = new AbortController().signal;',
        "  assert.deepEqual(await sampleControlledLocalStorage({}, signal), { kind: 'unconfigured' });",
        "  assert.deepEqual(await sampleControlledLocalStorage({ STORAGE_DRIVER: 'r2', UPLOAD_DIR: '/data/uploads' }, signal), { kind: 'unconfigured' });",
        `  assert.deepEqual(await sampleControlledLocalStorage({ STORAGE_DRIVER: 'local', UPLOAD_DIR: ${JSON.stringify(missingDir)} }, signal), { kind: 'not_connected' });`,
        `  const res = await sampleControlledLocalStorage({ STORAGE_DRIVER: 'local', UPLOAD_DIR: ${JSON.stringify(dir)} }, signal);`,
        "  assert.equal(res.kind, 'ok');",
        '  assert.equal(res.values.bytesUsed, 750);',
        '  assert.ok(Number.isSafeInteger(res.values.bytesFree) && res.values.bytesFree >= 0);',
        '})().catch((err) => { console.error(err); process.exit(1); });',
      ].join('\n');
      execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test' },
        stdio: 'pipe',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* --------------------------------------------------------------- 真实 PostgreSQL + Auth.js + HTTP 集成验收 */

const rawDatabaseUrl = process.env.M6T3_TEST_DATABASE_URL;
const databaseUrl = rawDatabaseUrl?.startsWith('postgres') ? rawDatabaseUrl : null;
if (process.env.M6T3_REQUIRE_DATABASE === 'true' && !databaseUrl) {
  throw new Error('M6T3_REQUIRE_DATABASE=true requires a PostgreSQL M6T3_TEST_DATABASE_URL');
}
if (databaseUrl) {
  const host = new URL(databaseUrl).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`M6T3_TEST_DATABASE_URL must target loopback PostgreSQL, got ${host}`);
  }
}

describe('M6-T3 ops-report & ops-sample PostgreSQL + Auth.js integration', {
  concurrency: false,
  skip: !databaseUrl && 'no dedicated M6T3_TEST_DATABASE_URL',
  timeout: 240_000,
}, () => {
  const schema = `m6t3_${randomBytes(6).toString('hex')}`;
  const savedEnv: Record<string, string | undefined> = {};
  let owner: PrismaClient;
  let db: PrismaClient;
  let appDb: PrismaClient;
  let schemaCreated = false;
  let auth: typeof import('../src/app/api/auth/[...nextauth]/route');
  let statsRoute: typeof import('../src/app/api/admin/stats/route');
  let opsReportRoute: typeof import('../src/app/api/internal/ops-report/route');
  let composition: typeof import('../src/lib/server/composition');
  let opsReportMod: typeof import('../src/lib/server/ops/ops-report');
  let opsSampleMod: typeof import('../src/lib/server/ops/ops-sample');
  let leaseRepoMod: typeof import('../src/lib/server/jobs/lease-repo');
  let statsServiceMod: typeof import('../src/lib/server/ops/stats-service');
  let hashSecret: typeof import('../src/lib/server/admin/crypto').hashSecret;
  let encrypt: typeof import('../src/lib/server/admin/crypto').encrypt;
  let setStore: (store: unknown) => void;
  let MemoryStoreCtor: new () => unknown;
  let admin: Operator;
  let sales: Operator;
  let editor: Operator;

  type Operator = { userId: string; cookie: string };

  const ENV: Record<string, string> = {
    AUTH_SECRET: 'm6t3-test-auth-secret-0123456789abcdef',
    EDGE_AUTH_SECRET: 'm6t3-test-edge-secret-0123456789abcdef',
    ADMIN_TOTP_KEY: Buffer.alloc(32, 7).toString('base64'),
    PRIVACY_HASH_SECRET: 'm6t3-test-privacy-hash-secret-0123456789abcdef',
    CRON_SECRET: SECRET,
    NEXT_PUBLIC_SITE_URL: ORIGIN,
    AUTH_URL: ORIGIN,
    RATE_LIMIT_STORE: 'memory',
    APP_ENV: 'test',
  };

  function cookies(response: Response, previous = ''): string {
    const jar = new Map<string, string>();
    for (const part of previous.split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name) jar.set(name, value.join('='));
    }
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';', 1);
      const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async function loginAs(role: Role): Promise<Operator> {
    const password = 'm6t3-isolated-test-password';
    const totpSecret = authenticator.generateSecret();
    const user = await db.user.create({
      data: {
        email: `m6t3-${role.toLowerCase()}-${randomBytes(4).toString('hex')}@example.com`,
        name: `M6T3 ${role}`,
        role,
        passwordHash: await hashSecret(password),
        totpEnabled: true,
        totpSecret: encrypt(totpSecret),
      },
    });
    const csrf = await auth.GET(new Request(`${ORIGIN}/api/auth/csrf`, { headers: { cookie: '' } }));
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const jar = cookies(csrf);
    const login = await auth.POST(new Request(`${ORIGIN}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: { cookie: jar, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: user.email,
        password,
        csrfToken,
        totp: authenticator.generate(totpSecret),
      }),
    }));
    const cookie = cookies(login, jar);
    assert.match(cookie, /authjs\.session-token=[^;]+/);
    return { userId: user.id, cookie };
  }

  function postOpsReport(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) {
    return opsReportRoute.POST(new Request(`${ORIGIN}/api/internal/ops-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }));
  }

  before(async () => {
    assert.ok(databaseUrl);
    for (const [key, value] of Object.entries(ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    savedEnv.UPLOAD_DIR = process.env.UPLOAD_DIR;
    delete process.env.UPLOAD_DIR;

    const base = new URL(databaseUrl);
    base.searchParams.delete('schema');
    owner = new PrismaClient({ datasourceUrl: base.href });
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    base.searchParams.set('schema', schema);
    base.searchParams.set('connection_limit', '5');
    savedEnv.DATABASE_URL = process.env.DATABASE_URL;
    process.env.DATABASE_URL = base.href;
    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], {
      stdio: 'pipe',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' },
    });

    db = new PrismaClient({ datasourceUrl: base.href });
    ({ prisma: appDb } = await import('../src/lib/server/db'));
    auth = await import('../src/app/api/auth/[...nextauth]/route');
    statsRoute = await import('../src/app/api/admin/stats/route');
    opsReportRoute = await import('../src/app/api/internal/ops-report/route');
    composition = await import('../src/lib/server/composition');
    opsReportMod = await import('../src/lib/server/ops/ops-report');
    opsSampleMod = await import('../src/lib/server/ops/ops-sample');
    leaseRepoMod = await import('../src/lib/server/jobs/lease-repo');
    statsServiceMod = await import('../src/lib/server/ops/stats-service');
    ({ hashSecret, encrypt } = await import('../src/lib/server/admin/crypto'));
    const limiter = await import('../src/lib/server/ratelimit');
    setStore = (store) => limiter.setRateLimitStore(store as never);
    MemoryStoreCtor = limiter.MemoryStore as never;
    setStore(new MemoryStoreCtor());

    admin = await loginAs('ADMIN');
    sales = await loginAs('SALES');
    editor = await loginAs('EDITOR');
  });

  beforeEach(async () => {
    await db.opsSourceSnapshot.deleteMany();
    await db.jobState.deleteMany();
    await db.apiDailyCounter.deleteMany();
    await db.siteSetting.deleteMany();
    await db.analyticsDaily.deleteMany();
    await db.analyticsAggregateDayState.deleteMany();
    setStore(new MemoryStoreCtor());
  });

  after(async () => {
    setStore(undefined);
    await appDb?.$disconnect();
    await db?.$disconnect();
    try {
      if (schemaCreated) await owner.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await owner?.$disconnect();
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('AC1/E-65/R1/R4：受控 deploy/ops-report.py 从 compose.env 自定义 0600 文件真实 POST 上报，昨日已验证不遮蔽今日未验证并在 stats 显示今日时间与 partial，验证 5xx 单次重试', async () => {
    const dataDir = makeTempDir('nbshiyan-m6t3-http-');
    const customEnvDir = makeTempDir('nbshiyan-m6t3-custom-env-');
    mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
    mkdirSync(path.join(dataDir, 'backup'), { recursive: true });
    writeFileSync(path.join(dataDir, 'uploads', 'asset.webp'), Buffer.alloc(1536, 5));

    // R1：昨日归档已恢复验证（backup-meta.json restoreVerified=true），今日归档由 backup.log 完成但未恢复验证
    const yesterdayCompleted = new Date(Date.now() - 24 * 3600_000);
    const yesterdayVerified = new Date(Date.now() - 23 * 3600_000);
    const todayCompleted = new Date(Date.now() - 180_000);
    const yesterdayDump = path.join(dataDir, 'backup', 'nbshiyan-daily-20261126-0430.dump');
    const todayDump = path.join(dataDir, 'backup', 'nbshiyan-daily-20261127-0430.dump');
    writeFileSync(yesterdayDump, 'SYNTHETIC-YESTERDAY-DUMP');
    utimesSync(yesterdayDump, yesterdayCompleted, yesterdayCompleted);
    writeFileSync(todayDump, 'SYNTHETIC-DUMP-PAYLOAD-MUST-NOT-BE-SENT');
    utimesSync(todayDump, todayCompleted, todayCompleted);
    writeFileSync(
      path.join(dataDir, 'backup', 'backup-meta.json'),
      JSON.stringify({
        archiveName: 'nbshiyan-daily-20261126-0430.dump',
        backupCompletedAt: yesterdayCompleted.toISOString(),
        restoreVerified: true,
        restoreVerifiedAt: yesterdayVerified.toISOString(),
      }),
    );
    writeFileSync(
      path.join(dataDir, 'backup', 'backup.log'),
      [
        '[backup] nbshiyan-daily-20261126-0430.dump 1K; dir total 1 MB',
        '[backup] nbshiyan-daily-20261127-0430.dump 1K; dir total 2 MB',
      ].join('\n') + '\n',
    );

    // R4：默认 dataDir/.env 不存在；deploy.sh 生成的 compose.env 指向独立自定义 0600 文件
    const customEnvFile = path.join(customEnvDir, 'app-custom.env');
    const composeEnvFile = path.join(dataDir, 'compose.env');
    writeFileSync(customEnvFile, `OTHER_KEY=1\nCRON_SECRET=${SECRET}\n`);
    writeFileSync(
      composeEnvFile,
      `NBSHIYAN_DATA_DIR=${dataDir}\nNBSHIYAN_APP_ENV_FILE=${customEnvFile}\nAPP_TAG=current\n`,
    );
    if (process.platform !== 'win32') {
      chmodSync(customEnvFile, 0o600);
      chmodSync(composeEnvFile, 0o600);
    }

    let storageHits = 0;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (req.method === 'POST' && req.url === '/api/internal/ops-report') {
          // 首次 STORAGE 请求模拟瞬态 503，验证脚本以相同 measuredAt 载荷精确重试一次
          if (raw.includes('"STORAGE"') && storageHits === 0) {
            storageHits += 1;
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'service_unavailable' }));
            return;
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key, value);
          }
          const response = await opsReportRoute.POST(
            new Request(`http://127.0.0.1${req.url}`, { method: 'POST', headers, body: raw }),
          );
          const body = await response.text();
          res.writeHead(response.status, {
            'content-type': response.headers.get('content-type') ?? 'application/json',
            'cache-control': response.headers.get('cache-control') ?? 'private, no-store',
          });
          res.end(body);
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      // 与 deploy/cron.nbshiyan:29 一致：不传 CRON_SECRET / NBSHIYAN_APP_ENV_FILE，仅传 NBSHIYAN_DATA_DIR
      const result = await runOpsReportScript([], {
        NBSHIYAN_DATA_DIR: dataDir,
        OPS_REPORT_URL: `http://127.0.0.1:${port}/api/internal/ops-report`,
      });
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(storageHits, 1, 'transient 503 should trigger single retry');
      assert.match(result.stdout, /source=STORAGE status=OK http=200 accepted=true/);
      assert.match(result.stdout, /source=BACKUP status=OK http=200 accepted=true/);
      assert.equal(result.stdout.includes(SECRET), false);
      assert.equal(result.stderr.includes(SECRET), false);
      assert.equal(result.stdout.includes(customEnvFile), false);
      assert.equal(result.stdout.includes(dataDir), false);
      assert.equal(result.stdout.includes('SYNTHETIC-DUMP-PAYLOAD'), false);

      const snapshots = await db.opsSourceSnapshot.findMany({ orderBy: { source: 'asc' } });
      assert.equal(snapshots.length, 2);
      const storageRow = snapshots.find((row) => row.source === 'STORAGE')!;
      const backupRow = snapshots.find((row) => row.source === 'BACKUP')!;
      assert.equal(storageRow.status, 'OK');
      assert.equal((storageRow.values as { bytesUsed: number }).bytesUsed, 1536);
      assert.ok(storageRow.lastSucceededAt !== null);
      assert.equal(backupRow.status, 'OK');
      const backupValues = backupRow.values as { backupCompletedAt: string; verified: boolean };
      assert.equal(backupValues.verified, false, 'today archive must remain unverified despite yesterday backup-meta.json');
      assert.ok(
        Math.abs(Date.parse(backupValues.backupCompletedAt) - todayCompleted.getTime()) <= 2_000,
        `expected today completion time ~${todayCompleted.toISOString()}, got ${backupValues.backupCompletedAt}`,
      );
      assert.ok(backupRow.lastSucceededAt !== null);

      // R1：真实 ADMIN GET /api/admin/stats 同样反映今日完成时间与未验证状态（coverage=partial）
      const statsRes = await statsRoute.GET(new Request(`${ORIGIN}/api/admin/stats?sources=storage,backup`, {
        headers: { cookie: admin.cookie },
      }));
      assert.equal(statsRes.status, 200);
      const statsDto = StatsDTOSchema.parse(await statsRes.json());
      const backupCard = findSource(statsDto, 'backup');
      assert.equal(backupCard.state, 'ok');
      assert.equal(backupCard.coverage, 'partial');
      assert.equal(backupCard.dataThrough, backupValues.backupCompletedAt);
      assert.ok(Math.abs(Date.parse(backupCard.dataThrough ?? '') - todayCompleted.getTime()) <= 2_000);

      const counterRows = await db.apiDailyCounter.findMany({ where: { routeId: OPS_REPORT_ROUTE_ID } });
      const totalRecorded = counterRows.reduce((sum, row) => sum + row.requestCount, 0);
      assert.equal(totalRecorded, 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(customEnvDir, { recursive: true, force: true });
    }
  });

  test('AC1：同 source+measuredAt 同载荷幂等、异载荷 409、旧时间 accepted=false 不覆盖、FAILED 保留原值/时间、并发首次写入串行无竞态', async () => {
    const t1 = '2026-11-27T10:00:00.000Z';
    const t2 = '2026-11-27T10:15:00.000Z';
    const t0 = '2026-11-27T09:45:00.000Z';
    const payloadT1: OpsReportRequestDTO = {
      source: 'STORAGE',
      measuredAt: t1,
      status: 'OK',
      values: { bytesUsed: 2048, bytesFree: 8192 },
    };

    // 并发首次写入相同载荷：均返回 200 accepted=true，库内仅一行
    const [firstA, firstB] = await Promise.all([postOpsReport(payloadT1), postOpsReport(payloadT1)]);
    assert.equal(firstA.status, 200);
    assert.equal(firstB.status, 200);
    assert.deepEqual(OpsReportReceiptDTOSchema.parse(await firstA.json()), { accepted: true, measuredAt: t1 });
    assert.deepEqual(OpsReportReceiptDTOSchema.parse(await firstB.json()), { accepted: true, measuredAt: t1 });

    // 同时间同载荷重放（UTC 无毫秒变体）幂等返回 200，不改 lastSucceededAt
    const replay = await postOpsReport({ ...payloadT1, measuredAt: '2026-11-27T10:00:00Z' });
    assert.equal(replay.status, 200);
    assert.deepEqual(OpsReportReceiptDTOSchema.parse(await replay.json()), { accepted: true, measuredAt: t1 });

    // 同时间异载荷 → 409 idempotency_conflict，不改原快照
    const conflict = await postOpsReport({
      source: 'STORAGE',
      measuredAt: t1,
      status: 'OK',
      values: { bytesUsed: 9999, bytesFree: 1000 },
    });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: string }).error, 'idempotency_conflict');

    // 旧时间 → 200 accepted=false 并忽略，不倒退 lastSucceededAt 或覆盖新值
    const older = await postOpsReport({
      source: 'STORAGE',
      measuredAt: t0,
      status: 'OK',
      values: { bytesUsed: 1, bytesFree: 1 },
    });
    assert.equal(older.status, 200);
    assert.deepEqual(OpsReportReceiptDTOSchema.parse(await older.json()), { accepted: false, measuredAt: t0 });
    const afterOlder = await db.opsSourceSnapshot.findUniqueOrThrow({ where: { source: 'STORAGE' } });
    assert.equal(afterOlder.measuredAt.toISOString(), t1);
    assert.equal((afterOlder.values as { bytesUsed: number }).bytesUsed, 2048);

    // 较新时间的 FAILED 报告保留此前成功 values 与 lastSucceededAt
    const failedPayload: OpsReportRequestDTO = {
      source: 'STORAGE',
      measuredAt: t2,
      status: 'FAILED',
      safeErrorCode: 'service_unavailable',
    };
    const failedRes = await postOpsReport(failedPayload);
    assert.equal(failedRes.status, 200);
    assert.deepEqual(OpsReportReceiptDTOSchema.parse(await failedRes.json()), { accepted: true, measuredAt: t2 });
    const afterFailed = await db.opsSourceSnapshot.findUniqueOrThrow({ where: { source: 'STORAGE' } });
    assert.equal(afterFailed.status, 'FAILED');
    assert.equal(afterFailed.measuredAt.toISOString(), t2);
    assert.equal(afterFailed.lastSucceededAt?.toISOString(), t1, 'FAILED must preserve previous lastSucceededAt');
    assert.deepEqual(afterFailed.values, { bytesUsed: 2048, bytesFree: 8192 });

    // 重放完全相同的 FAILED 报告幂等 200；同时间不同错误码 409
    assert.equal((await postOpsReport(failedPayload)).status, 200);
    assert.equal(
      (await postOpsReport({ ...failedPayload, safeErrorCode: 'source_unavailable' })).status,
      409,
    );
  });

  test('R2：ops-sample 作业内快照写入与 JobState 租约结算共享受预算与代次保护的事务——失效代次不改快照与成功时间，正常代次写入，独立 POST 保持幂等与 409', async () => {
    let nowMs = Date.parse('2026-11-27T12:00:00.000Z');
    const clock = () => new Date(nowMs);
    const makeCtx = () => ({
      now: new Date(nowMs),
      deadlineAt: new Date(Date.now() + 55_000),
      signal: new AbortController().signal,
    });

    // 1) 空库：第 1 代取得租约后暂停，95s 后第 2 代取得租约；第 1 代恢复返回 finish_failed，库内 0 快照残留
    let releaseGen1!: () => void;
    const gen1Paused = new Promise<void>((resolve) => { releaseGen1 = resolve; });
    let gen1Entered!: () => void;
    const gen1EnteredPromise = new Promise<void>((resolve) => { gen1Entered = resolve; });

    const gen1Job = opsSampleMod.createOpsSampleJob({
      db,
      clock,
      sampleStorage: async () => {
        gen1Entered();
        await gen1Paused;
        return { kind: 'ok', values: { bytesUsed: 37, bytesFree: 1000 } };
      },
    });
    const gen1Run = gen1Job.run(makeCtx());
    await gen1EnteredPromise;

    nowMs += 95_000;
    const claim2 = await leaseRepoMod.createJobLeaseRepo({ db, clock }).claim({
      key: 'ops-sample',
      owner: 'ops-sample-runtime',
    });
    assert.equal(claim2.acquired, true);
    if (!claim2.acquired) throw new Error('expected generation 2 claim');
    assert.equal(claim2.generation, 2);

    releaseGen1();
    const outcome1 = await gen1Run;
    assert.deepEqual(outcome1, { kind: 'finish_failed' });
    assert.equal(await db.opsSourceSnapshot.count(), 0, 'stale generation 1 must roll back 37-byte snapshot');
    const stateAfterGen1 = await db.jobState.findUniqueOrThrow({ where: { key: 'ops-sample' } });
    assert.equal(stateAfterGen1.generation, 2);
    assert.equal(stateAfterGen1.lastSucceededAt, null);

    // 2) 释放第 2 代租约后，正常第 3 代写入 512 字节快照成功
    await db.jobState.update({ where: { key: 'ops-sample' }, data: { leaseOwner: null, lockedUntil: null } });
    nowMs += 5_000;
    const t3Iso = new Date(nowMs).toISOString();
    const gen3Job = opsSampleMod.createOpsSampleJob({
      db,
      clock,
      sampleStorage: async () => ({ kind: 'ok', values: { bytesUsed: 512, bytesFree: 4096 } }),
    });
    const outcome3 = await gen3Job.run(makeCtx());
    assert.equal(outcome3.kind, 'ran');
    assert.equal(outcome3.status, 'SUCCEEDED');
    const snap3 = await db.opsSourceSnapshot.findUniqueOrThrow({ where: { source: 'STORAGE' } });
    assert.deepEqual(snap3.values, { bytesUsed: 512, bytesFree: 4096 });
    assert.equal(snap3.lastSucceededAt?.toISOString(), t3Iso);
    const state3 = await db.jobState.findUniqueOrThrow({ where: { key: 'ops-sample' } });
    assert.equal(state3.generation, 3);
    assert.equal(state3.lastSucceededAt?.toISOString(), t3Iso);

    // 3) 已有 512 字节快照时，第 4 代被第 5 代抢占：第 4 代返回 finish_failed 且不改变 512 字节快照或 lastSucceededAt
    nowMs += 60_000;
    let releaseGen4!: () => void;
    const gen4Paused = new Promise<void>((resolve) => { releaseGen4 = resolve; });
    let gen4Entered!: () => void;
    const gen4EnteredPromise = new Promise<void>((resolve) => { gen4Entered = resolve; });
    const gen4Job = opsSampleMod.createOpsSampleJob({
      db,
      clock,
      sampleStorage: async () => {
        gen4Entered();
        await gen4Paused;
        return { kind: 'ok', values: { bytesUsed: 9999, bytesFree: 1 } };
      },
    });
    const gen4Run = gen4Job.run(makeCtx());
    await gen4EnteredPromise;

    nowMs += 95_000;
    const claim5 = await leaseRepoMod.createJobLeaseRepo({ db, clock }).claim({
      key: 'ops-sample',
      owner: 'ops-sample-runtime',
    });
    assert.equal(claim5.acquired, true);
    if (!claim5.acquired) throw new Error('expected generation 5 claim');
    assert.equal(claim5.generation, 5);

    releaseGen4();
    assert.deepEqual(await gen4Run, { kind: 'finish_failed' });
    const snapAfterGen4 = await db.opsSourceSnapshot.findUniqueOrThrow({ where: { source: 'STORAGE' } });
    assert.deepEqual(snapAfterGen4.values, { bytesUsed: 512, bytesFree: 4096 });
    assert.equal(snapAfterGen4.measuredAt.toISOString(), t3Iso);
    assert.equal(snapAfterGen4.lastSucceededAt?.toISOString(), t3Iso);
    const stateAfterGen4 = await db.jobState.findUniqueOrThrow({ where: { key: 'ops-sample' } });
    assert.equal(stateAfterGen4.generation, 5);
    assert.equal(stateAfterGen4.lastSucceededAt?.toISOString(), t3Iso);

    // 4) 释放租约后正常第 6 代写入 768 字节，且独立 POST 保持同时间同载荷幂等 200 与异载荷 409
    await db.jobState.update({ where: { key: 'ops-sample' }, data: { leaseOwner: null, lockedUntil: null } });
    nowMs += 5_000;
    const t6Iso = new Date(nowMs).toISOString();
    const gen6Job = opsSampleMod.createOpsSampleJob({
      db,
      clock,
      sampleStorage: async () => ({ kind: 'ok', values: { bytesUsed: 768, bytesFree: 8192 } }),
    });
    const outcome6 = await gen6Job.run(makeCtx());
    assert.equal(outcome6.kind, 'ran');
    assert.equal(outcome6.status, 'SUCCEEDED');
    const snap6 = await db.opsSourceSnapshot.findUniqueOrThrow({ where: { source: 'STORAGE' } });
    assert.deepEqual(snap6.values, { bytesUsed: 768, bytesFree: 8192 });
    assert.equal(snap6.lastSucceededAt?.toISOString(), t6Iso);

    const idemRes = await postOpsReport({
      source: 'STORAGE',
      measuredAt: t6Iso,
      status: 'OK',
      values: { bytesUsed: 768, bytesFree: 8192 },
    });
    assert.equal(idemRes.status, 200);
    assert.deepEqual(OpsReportReceiptDTOSchema.parse(await idemRes.json()), { accepted: true, measuredAt: t6Iso });

    const conflictRes = await postOpsReport({
      source: 'STORAGE',
      measuredAt: t6Iso,
      status: 'OK',
      values: { bytesUsed: 769, bytesFree: 8192 },
    });
    assert.equal(conflictRes.status, 409);
    assert.equal(((await conflictRes.json()) as { error: string }).error, 'idempotency_conflict');
  });

  test('AC1/E-66：后台 ADMIN Auth.js session 不能替代 Bearer 调 ops-report（401）；SALES/EDITOR 直接 GET stats 的 storage/backup 403、混合来源裁剪、空库 not_connected', async () => {
    // 1) 真登录 ADMIN session cookie 无 Bearer 调 POST /api/internal/ops-report -> 401
    const sessionAttempt = await postOpsReport(
      { source: 'STORAGE', measuredAt: NOW.toISOString(), status: 'OK', values: { bytesUsed: 100, bytesFree: 900 } },
      { cookie: admin.cookie },
    );
    assert.equal(sessionAttempt.status, 401);
    assert.equal(await db.opsSourceSnapshot.count(), 0);

    // 2) 空库（无验证来源）下 ADMIN 读取 storage/backup 为 not_connected
    const emptyRes = await statsRoute.GET(new Request(`${ORIGIN}/api/admin/stats?sources=storage,backup`, {
      headers: { cookie: admin.cookie },
    }));
    assert.equal(emptyRes.status, 200);
    const emptyDto = StatsDTOSchema.parse(await emptyRes.json());
    assert.equal(findSource(emptyDto, 'storage').state, 'not_connected');
    assert.equal(findSource(emptyDto, 'storage').value, null);
    assert.equal(findSource(emptyDto, 'backup').state, 'not_connected');
    assert.equal(findSource(emptyDto, 'backup').value, null);

    // 3) 写入真实快照后校验 ADMIN 可读，未登录 401，SALES/EDITOR 直接请求 403 且无计数，混合请求查询前裁剪
    const nowIso = new Date().toISOString();
    const completedIso = new Date(Date.now() - 600_000).toISOString();
    assert.equal((await postOpsReport({
      source: 'STORAGE', measuredAt: nowIso, status: 'OK', values: { bytesUsed: 4096, bytesFree: 81920 },
    })).status, 200);
    assert.equal((await postOpsReport({
      source: 'BACKUP', measuredAt: nowIso, status: 'OK', values: { backupCompletedAt: completedIso, backupAgeSeconds: 600, verified: false },
    })).status, 200);

    const adminRes = await statsRoute.GET(new Request(`${ORIGIN}/api/admin/stats?sources=storage,backup`, {
      headers: { cookie: admin.cookie },
    }));
    assert.equal(adminRes.status, 200);
    const adminDto = StatsDTOSchema.parse(await adminRes.json());
    assert.equal(findSource(adminDto, 'storage').state, 'ok');
    assert.equal(findSource(adminDto, 'storage').value, 4096);
    assert.equal(findSource(adminDto, 'backup').state, 'ok');
    assert.equal(findSource(adminDto, 'backup').value, 600);
    assert.equal(findSource(adminDto, 'backup').coverage, 'partial');

    const anonRes = await statsRoute.GET(new Request(`${ORIGIN}/api/admin/stats?sources=storage,backup`));
    assert.equal(anonRes.status, 401);

    for (const actor of [sales, editor]) {
      for (const q of ['storage', 'backup', 'storage,backup']) {
        const denied = await statsRoute.GET(new Request(`${ORIGIN}/api/admin/stats?sources=${q}`, {
          headers: { cookie: actor.cookie },
        }));
        assert.equal(denied.status, 403, `expected 403 for ${q}`);
        const text = await denied.text();
        assert.equal(text.includes('4096'), false);
        assert.equal(text.includes('600'), false);
      }

      const mixed = await statsRoute.GET(new Request(`${ORIGIN}/api/admin/stats?sources=visitors,storage,backup`, {
        headers: { cookie: actor.cookie },
      }));
      assert.equal(mixed.status, 200);
      const rawMixed = await mixed.text();
      assert.equal(rawMixed.includes('4096'), false);
      assert.equal(rawMixed.includes('"storage"'), false);
      assert.equal(rawMixed.includes('"backup"'), false);
      const mixedDto = StatsDTOSchema.parse(JSON.parse(rawMixed));
      assert.deepEqual(mixedDto.sources.map((item) => item.source), ['visitors']);
    }
  });

  test('AC2/E-65/R5：由安装后的 deploy/cron.nbshiyan 真实 */15 计划驱动隔离 HTTP 服务，验证重启前后不同 OS 进程、触发时间、同库递增 JobState 与对应真实 stats GET', async () => {
    const dataDir = makeTempDir('nbshiyan-m6t3-r5-');
    const uploadDir = path.join(dataDir, 'uploads');
    mkdirSync(uploadDir, { recursive: true });
    writeFileSync(path.join(uploadDir, 'file-1.bin'), Buffer.alloc(1024, 1));

    // 安装 deploy/cron.nbshiyan（按安装约定替换 @DATA_DIR@），校验真实 */15 表达式并提取原样触发命令
    const rawCron = readFileSync(path.resolve(process.cwd(), 'deploy/cron.nbshiyan'), 'utf8');
    const installedCronPath = path.join(dataDir, 'cron.nbshiyan');
    writeFileSync(installedCronPath, rawCron.replaceAll('@DATA_DIR@', dataDir));
    const installedOpsSampleLine = readFileSync(installedCronPath, 'utf8')
      .split(/\r?\n/)
      .find((line) => !line.trimStart().startsWith('#') && line.includes("jobKey:'ops-sample'"));
    assert.ok(installedOpsSampleLine, 'installed cron must contain ops-sample entry');
    assert.match(installedOpsSampleLine, /^\*\/15 \* \* \* \* root /);
    const nodeExprMatch = /node -e "([^"]+)"/.exec(installedOpsSampleLine);
    assert.ok(nodeExprMatch, 'installed ops-sample cron line must contain node -e expression');
    const installedCronNodeExpr = nodeExprMatch[1]!;

    // 独立隔离 HTTP 服务入口：挂载生产 route.ts（operations + stats + ops-report + health），以真实 OS 子进程启停
    const operationsRouteFile = JSON.stringify(path.resolve(process.cwd(), 'src/app/api/admin/cron/operations/route.ts'));
    const statsRouteFile = JSON.stringify(path.resolve(process.cwd(), 'src/app/api/admin/stats/route.ts'));
    const opsReportRouteFile = JSON.stringify(path.resolve(process.cwd(), 'src/app/api/internal/ops-report/route.ts'));
    const serverEntryPath = path.join(dataDir, 'isolated-ops-server.ts');
    writeFileSync(
      serverEntryPath,
      [
        "import http from 'node:http';",
        `import { POST as operationsPost } from ${operationsRouteFile};`,
        `import { GET as statsGet } from ${statsRouteFile};`,
        `import { POST as opsReportPost } from ${opsReportRouteFile};`,
        '',
        'const port = Number(process.env.ISOLATED_PORT || 0);',
        'const server = http.createServer((req, res) => {',
        '  const chunks: Buffer[] = [];',
        '  req.on("data", (chunk: Buffer) => chunks.push(chunk));',
        '  req.on("end", async () => {',
        '    try {',
        '      const addr = server.address();',
        '      const listenPort = typeof addr === "object" && addr ? addr.port : port;',
        '      const url = `http://127.0.0.1:${listenPort}${req.url ?? "/"}`;',
        '      if (req.method === "GET" && req.url === "/api/health") {',
        '        res.writeHead(200, { "content-type": "application/json" });',
        '        res.end(JSON.stringify({ ok: true, pid: process.pid }));',
        '        return;',
        '      }',
        '      const headers = new Headers();',
        '      for (const [key, value] of Object.entries(req.headers)) {',
        '        if (typeof value === "string") headers.set(key, value);',
        '        else if (Array.isArray(value)) headers.set(key, value.join(", "));',
        '      }',
        '      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;',
        '      let response: Response;',
        '      if (req.method === "POST" && req.url === "/api/admin/cron/operations") {',
        '        response = await operationsPost(new Request(url, { method: "POST", headers, body }));',
        '      } else if (req.method === "POST" && req.url === "/api/internal/ops-report") {',
        '        response = await opsReportPost(new Request(url, { method: "POST", headers, body }));',
        '      } else if (req.method === "GET" && (req.url ?? "").startsWith("/api/admin/stats")) {',
        '        response = await statsGet(new Request(url, { method: "GET", headers }));',
        '      } else {',
        '        res.writeHead(404, { "content-type": "application/json" });',
        '        res.end(JSON.stringify({ error: "not_found" }));',
        '        return;',
        '      }',
        '      const outHeaders: Record<string, string> = {};',
        '      response.headers.forEach((v, k) => { outHeaders[k] = v; });',
        '      const text = await response.text();',
        '      res.writeHead(response.status, outHeaders);',
        '      res.end(text);',
        '    } catch {',
        '      res.writeHead(500, { "content-type": "application/json" });',
        '      res.end(JSON.stringify({ error: "internal_error" }));',
        '    }',
        '  });',
        '});',
        'server.listen(port, "127.0.0.1", () => {',
        '  const addr = server.address();',
        '  const listenPort = typeof addr === "object" && addr ? addr.port : port;',
        '  process.stdout.write(`READY ${JSON.stringify({ port: listenPort, pid: process.pid })}\\n`);',
        '});',
        'const shutdown = () => { server.closeAllConnections?.(); server.close(() => process.exit(0)); };',
        'process.on("SIGTERM", shutdown);',
        'process.on("SIGINT", shutdown);',
      ].join('\n'),
    );

    type SpawnedServer = { child: ChildProcess; port: number; pid: number };
    const startIsolatedServer = async (): Promise<SpawnedServer> => {
      const child = spawn(process.execPath, ['--import', 'tsx', serverEntryPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          STORAGE_DRIVER: 'local',
          UPLOAD_DIR: uploadDir,
          ISOLATED_PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdoutBuf = '';
      let stderrBuf = '';
      child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });
      const ready = await new Promise<{ port: number; pid: number }>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`isolated server startup timeout; stderr=${stderrBuf}`));
        }, 45_000);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`isolated server exited early code=${code} signal=${signal} stderr=${stderrBuf}`));
        });
        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString('utf8');
          const match = /READY (\{[^\n]+\})/.exec(stdoutBuf);
          if (match) {
            clearTimeout(timer);
            resolve(JSON.parse(match[1]!) as { port: number; pid: number });
          }
        });
      });
      const health = await fetch(`http://127.0.0.1:${ready.port}/api/health`);
      assert.equal(health.status, 200);
      const healthBody = (await health.json()) as { ok: boolean; pid: number };
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.pid, ready.pid);
      return { child, port: ready.port, pid: ready.pid };
    };

    const stopIsolatedServer = async (srv: SpawnedServer | null) => {
      if (!srv) return;
      if (srv.child.exitCode !== null || srv.child.signalCode !== null) return;
      const exited = once(srv.child, 'exit');
      srv.child.kill('SIGTERM');
      await Promise.race([
        exited,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('stop timeout')), 8_000)),
      ]).catch(() => {
        srv.child.kill('SIGKILL');
      });
    };

    const runInstalledCronTick = async (port: number) => {
      const expr = installedCronNodeExpr.replace('http://127.0.0.1:3000', `http://127.0.0.1:${port}`);
      const { stdout, stderr } = await execFileAsync(process.execPath, ['-e', expr], {
        env: { ...process.env, CRON_SECRET: SECRET },
        timeout: 30_000,
      });
      assert.equal(stderr.includes(SECRET), false);
      assert.equal(stdout.includes(SECRET), false);
      const match = /^(\S+)\s+ops-sample\s+(\d+)$/.exec(stdout.trim());
      assert.ok(match, `unexpected cron log line: ${stdout}`);
      return { triggeredAt: match[1]!, status: Number(match[2]!) };
    };

    let proc1: SpawnedServer | null = null;
    let proc2: SpawnedServer | null = null;
    try {
      // 1) 重启前进程 1：安装后 cron 触发 → 同库 JobState=1 → 真实 HTTP GET /api/admin/stats
      proc1 = await startIsolatedServer();
      const tick1 = await runInstalledCronTick(proc1.port);
      assert.equal(tick1.status, 200);
      assert.ok(Number.isFinite(Date.parse(tick1.triggeredAt)));

      const state1 = await db.jobState.findUniqueOrThrow({ where: { key: 'ops-sample' } });
      const snap1 = await db.opsSourceSnapshot.findUniqueOrThrow({ where: { source: 'STORAGE' } });
      assert.equal(state1.generation, 1);
      assert.equal(state1.lastStatus, 'SUCCEEDED');
      assert.ok(state1.lastSucceededAt !== null);
      assert.ok(snap1.lastSucceededAt !== null);
      assert.ok(snap1.lastSucceededAt.getTime() <= state1.lastSucceededAt.getTime());

      const stats1Res = await fetch(`http://127.0.0.1:${proc1.port}/api/admin/stats?sources=storage,backup`, {
        headers: { cookie: admin.cookie },
      });
      assert.equal(stats1Res.status, 200);
      const stats1Dto = StatsDTOSchema.parse(await stats1Res.json());
      assert.equal(findSource(stats1Dto, 'storage').state, 'ok');
      assert.equal(findSource(stats1Dto, 'storage').value, 1024);
      assert.equal(findSource(stats1Dto, 'storage').lastSucceededAt, snap1.lastSucceededAt.toISOString());
      assert.equal(findSource(stats1Dto, 'backup').state, 'not_connected');

      // 租约被占用时，安装后 cron 脚本收到 409 正常跳过（exit 0，不推进代次）
      await db.jobState.update({
        where: { key: 'ops-sample' },
        data: { leaseOwner: 'other-worker', lockedUntil: new Date(Date.now() + 60_000) },
      });
      const busyTick = await runInstalledCronTick(proc1.port);
      assert.equal(busyTick.status, 409);
      assert.equal((await db.jobState.findUniqueOrThrow({ where: { key: 'ops-sample' } })).generation, 1);
      await db.jobState.update({
        where: { key: 'ops-sample' },
        data: { leaseOwner: null, lockedUntil: null },
      });

      // 2) 终止进程 1，新增上传文件，启动独立新 OS 进程 2（断言 PID 不同）
      await stopIsolatedServer(proc1);
      const pid1 = proc1.pid;
      proc1 = null;
      writeFileSync(path.join(uploadDir, 'file-2.bin'), Buffer.alloc(2048, 2));
      await new Promise((resolve) => setTimeout(resolve, 25));

      proc2 = await startIsolatedServer();
      assert.notEqual(proc2.pid, pid1, 'restarted isolated service must run in a distinct OS process');

      // 3) 重启后进程 2：再次由安装后 cron 命令触发 → 同库 JobState 递增 → 真实 HTTP GET /api/admin/stats 反映新值与新时间
      const tick2 = await runInstalledCronTick(proc2.port);
      assert.equal(tick2.status, 200);
      assert.ok(Date.parse(tick2.triggeredAt) > Date.parse(tick1.triggeredAt));

      const state2 = await db.jobState.findUniqueOrThrow({ where: { key: 'ops-sample' } });
      const snap2 = await db.opsSourceSnapshot.findUniqueOrThrow({ where: { source: 'STORAGE' } });
      assert.equal(state2.generation, 2);
      assert.equal(state2.lastStatus, 'SUCCEEDED');
      assert.ok(state2.lastSucceededAt !== null);
      assert.ok(snap2.lastSucceededAt !== null);
      assert.ok(state2.lastSucceededAt.getTime() > state1.lastSucceededAt.getTime());
      assert.ok(snap2.lastSucceededAt.getTime() > snap1.lastSucceededAt.getTime());
      assert.ok(snap2.lastSucceededAt.getTime() <= state2.lastSucceededAt.getTime());

      const stats2Res = await fetch(`http://127.0.0.1:${proc2.port}/api/admin/stats?sources=storage,backup`, {
        headers: { cookie: admin.cookie },
      });
      assert.equal(stats2Res.status, 200);
      const stats2Dto = StatsDTOSchema.parse(await stats2Res.json());
      assert.equal(findSource(stats2Dto, 'storage').state, 'ok');
      assert.equal(findSource(stats2Dto, 'storage').value, 3072);
      assert.equal(findSource(stats2Dto, 'storage').lastSucceededAt, snap2.lastSucceededAt.toISOString());
      assert.equal(findSource(stats2Dto, 'backup').state, 'not_connected');
    } finally {
      await stopIsolatedServer(proc1);
      await stopIsolatedServer(proc2);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('AC2/E-65：停止报告超过 45m/36h 在 stats 保留原 measuredAt/lastSucceededAt 标 stale；未做恢复验证不标可恢复', async () => {
    const tReport = '2026-11-27T08:00:00.000Z';
    const tCompleted = '2026-11-27T04:30:00.000Z';
    const service = opsReportMod.createOpsReportService({ db });

    await service.submit({
      source: 'STORAGE',
      measuredAt: tReport,
      status: 'OK',
      values: { bytesUsed: 8192, bytesFree: 16384 },
    });
    await service.submit({
      source: 'BACKUP',
      measuredAt: tReport,
      status: 'OK',
      values: { backupCompletedAt: tCompleted, backupAgeSeconds: 12600, verified: false },
    });

    // 10 分钟后查询：两者均新鲜；BACKUP 未做恢复验证 → coverage=partial（不得为 full）
    const freshClock = () => new Date('2026-11-27T08:10:00.000Z');
    const freshStats = await composition.createAdminServices({ db, clock: freshClock }).stats.query({
      role: 'ADMIN',
      userId: admin.userId,
      query: { sources: ['storage', 'backup'] },
    });
    assert.equal(findSource(freshStats.dto, 'storage').state, 'ok');
    assert.equal(findSource(freshStats.dto, 'storage').lastSucceededAt, tReport);
    assert.equal(findSource(freshStats.dto, 'backup').state, 'ok');
    assert.equal(findSource(freshStats.dto, 'backup').coverage, 'partial');
    assert.equal(findSource(freshStats.dto, 'backup').dataThrough, tCompleted);
    assert.equal(findSource(freshStats.dto, 'backup').lastSucceededAt, tReport);

    // 停止报告 46 分钟后：STORAGE 变 stale 但保留原值与原 lastSucceededAt；BACKUP 仍在 36h 内保持 ok
    const storageStaleClock = () => new Date('2026-11-27T08:46:00.000Z');
    const midStats = await composition.createAdminServices({ db, clock: storageStaleClock }).stats.query({
      role: 'ADMIN',
      userId: admin.userId,
      query: { sources: ['storage', 'backup'] },
    });
    const staleStorage = findSource(midStats.dto, 'storage');
    assert.equal(staleStorage.state, 'stale');
    assert.equal(staleStorage.value, 8192);
    assert.equal(staleStorage.lastSucceededAt, tReport);
    assert.equal(staleStorage.dataThrough, tReport);
    assert.equal(staleStorage.queriedAt, '2026-11-27T08:46:00.000Z');
    assert.equal(findSource(midStats.dto, 'backup').state, 'ok');

    // 停止报告 37 小时后：BACKUP 也变 stale 并保留原 backupCompletedAt 与原 lastSucceededAt
    const backupStaleClock = () => new Date('2026-11-28T17:30:00.000Z');
    const lateStats = await composition.createAdminServices({ db, clock: backupStaleClock }).stats.query({
      role: 'ADMIN',
      userId: admin.userId,
      query: { sources: ['storage', 'backup'] },
    });
    const staleBackup = findSource(lateStats.dto, 'backup');
    assert.equal(staleBackup.state, 'stale');
    assert.equal(staleBackup.value, 12600);
    assert.equal(staleBackup.dataThrough, tCompleted);
    assert.equal(staleBackup.lastSucceededAt, tReport);

    // 显式完成隔离恢复验证（verified=true）的新报告后，coverage 升为 full
    const tVerifiedReport = '2026-11-28T18:00:00.000Z';
    const tVerifiedBackup = '2026-11-28T17:45:00.000Z';
    await service.submit({
      source: 'BACKUP',
      measuredAt: tVerifiedReport,
      status: 'OK',
      values: { backupCompletedAt: tVerifiedBackup, backupAgeSeconds: 900, verified: true },
    });
    const verifiedStats = await composition.createAdminServices({
      db,
      clock: () => new Date('2026-11-28T18:05:00.000Z'),
    }).stats.query({
      role: 'ADMIN',
      userId: admin.userId,
      query: { sources: ['backup'] },
    });
    assert.equal(findSource(verifiedStats.dto, 'backup').state, 'ok');
    assert.equal(findSource(verifiedStats.dto, 'backup').coverage, 'full');
  });

  test('AC2/E-67：辅助源 storage/backup 读取异常仅令该卡返回 query_failed，核心流量与业务来源仍返回 200 真实结果', async () => {
    const now = new Date('2026-11-27T12:00:00.000Z');
    await db.analyticsDaily.create({
      data: {
        localDate: '2026-11-27',
        timezoneRevision: 1,
        timezone: 'UTC',
        dimension: 'site',
        visitors: 4,
        pageViews: 11,
        productViews: 3,
        modelStarts: 2,
        modelSuccesses: 2,
        modelFailures: 0,
        chatStarts: 1,
        durationMsSum: 800n,
        loadDurationSamples: 2,
        sourceThrough: new Date('2026-11-27T11:55:00.000Z'),
        aggregatedAt: new Date('2026-11-27T11:56:00.000Z'),
        expiresAt: new Date('2027-12-27T00:00:00.000Z'),
      },
    });
    await db.analyticsAggregateDayState.create({
      data: {
        localDate: '2026-11-27',
        timezoneRevision: 1,
        timezone: 'UTC',
        markerVersions: {},
      },
    });

    const failingOpsDb = {
      async $transaction() {
        throw new Error('simulated ops snapshot outage');
      },
    } as unknown as OpsReportDb;
    const failingReaders = opsReportMod.createOpsSourceReaders(failingOpsDb);

    const statsService = statsServiceMod.createStatsService({
      db,
      clock: () => now,
      analyticsConfigured: () => true,
      aggregateJobRegistered: () => true,
      nonCoreReaders: {
        ...failingReaders,
      },
    });

    const { dto } = await statsService.query({
      role: 'ADMIN',
      userId: admin.userId,
      query: { from: '2026-11-27', to: '2026-11-27', sources: ['page_views', 'visitors', 'storage', 'backup'] },
    });

    assert.equal(findSource(dto, 'page_views').state, 'ok');
    assert.equal(findSource(dto, 'page_views').value, 11);
    assert.equal(findSource(dto, 'visitors').state, 'ok');
    assert.equal(findSource(dto, 'visitors').value, 4);
    assert.equal(findSource(dto, 'storage').state, 'query_failed');
    assert.equal(findSource(dto, 'storage').value, null);
    assert.equal(findSource(dto, 'backup').state, 'query_failed');
    assert.equal(findSource(dto, 'backup').value, null);
  });
});
