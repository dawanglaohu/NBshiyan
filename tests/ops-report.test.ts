import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

      // 4) 显式 restoreVerified=true 且 restoreVerifiedAt >= backupCompletedAt 的 backup-meta.json → verified=true
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

      // 5) 损坏或引用缺失归档的 backup-meta.json → FAILED（绝不假报 OK）
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

  test('ops-sample 注册与单向架构边界：registry 导出 key 不导入 ops、composition 构造期不读库、deploy/cron.nbshiyan 每 15 分钟双条目无硬编码密钥', async () => {
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
    assert.match(reportLine, /NBSHIYAN_APP_ENV_FILE=@DATA_DIR@\/\.env/);
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
  let registry: typeof import('../src/lib/server/jobs/registry');
  let opsReportMod: typeof import('../src/lib/server/ops/ops-report');
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
    registry = await import('../src/lib/server/jobs/registry');
    opsReportMod = await import('../src/lib/server/ops/ops-report');
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

  test('AC1/E-65：受控 deploy/ops-report.py → 真实 HTTP POST /api/internal/ops-report 落库 OpsSourceSnapshot 与 ApiDailyCounter，并验证 5xx 单次幂等重试', async () => {
    const dataDir = makeTempDir('nbshiyan-m6t3-http-');
    mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
    mkdirSync(path.join(dataDir, 'backup'), { recursive: true });
    writeFileSync(path.join(dataDir, 'uploads', 'asset.webp'), Buffer.alloc(1536, 5));
    const dumpFile = path.join(dataDir, 'backup', 'nbshiyan-daily-20261127-0430.dump');
    writeFileSync(dumpFile, 'SYNTHETIC-DUMP-PAYLOAD-MUST-NOT-BE-SENT');
    const dumpTime = new Date(Date.now() - 180_000);
    utimesSync(dumpFile, dumpTime, dumpTime);
    writeFileSync(
      path.join(dataDir, 'backup', 'backup.log'),
      '[backup] nbshiyan-daily-20261127-0430.dump 1K; dir total 1 MB\n',
    );
    const envFile = path.join(dataDir, 'app.env');
    writeFileSync(envFile, `OTHER_KEY=1\nCRON_SECRET=${SECRET}\n`);
    if (process.platform !== 'win32') chmodSync(envFile, 0o600);

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
      const result = await runOpsReportScript([], {
        NBSHIYAN_DATA_DIR: dataDir,
        NBSHIYAN_APP_ENV_FILE: envFile,
        OPS_REPORT_URL: `http://127.0.0.1:${port}/api/internal/ops-report`,
      });
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(storageHits, 1, 'transient 503 should trigger single retry');
      assert.match(result.stdout, /source=STORAGE status=OK http=200 accepted=true/);
      assert.match(result.stdout, /source=BACKUP status=OK http=200 accepted=true/);
      assert.equal(result.stdout.includes(SECRET), false);
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
      assert.equal((backupRow.values as { verified: boolean }).verified, false);
      assert.ok(backupRow.lastSucceededAt !== null);

      const counterRows = await db.apiDailyCounter.findMany({ where: { routeId: OPS_REPORT_ROUTE_ID } });
      const totalRecorded = counterRows.reduce((sum, row) => sum + row.requestCount, 0);
      assert.equal(totalRecorded, 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
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

  test('AC2/E-65：ops-sample 经 POST /api/admin/cron/operations 实际执行、409 忙租约跳过、进程重启新建组合实例按 15 分钟推进并写入 stats', async () => {
    const uploadDir = makeTempDir('nbshiyan-m6t3-sample-');
    try {
      writeFileSync(path.join(uploadDir, 'file-1.bin'), Buffer.alloc(1024, 1));
      let currentNow = new Date('2026-11-27T12:00:00.000Z');
      const clock = () => new Date(currentNow);

      const postOp = (handler: (req: Request) => Promise<Response>) => handler(
        new Request(`${ORIGIN}/api/admin/cron/operations`, {
          method: 'POST',
          headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jobKey: 'ops-sample' }),
        }),
      );

      // 第 1 轮：经真实 operations 入口运行 ops-sample
      const boot1 = registry.createOperationsHandler({
        services: composition.createJobServices({
          db,
          clock,
          ops: { env: { STORAGE_DRIVER: 'local', UPLOAD_DIR: uploadDir } },
        }).jobs,
        clock,
        secret: SECRET,
      });
      const r1 = await postOp(boot1);
      assert.equal(r1.status, 200);
      const body1 = (await r1.json()) as { jobKey: string; status: string; counts: { candidateCount?: number } };
      assert.equal(body1.jobKey, 'ops-sample');
      assert.equal(body1.status, 'SUCCEEDED');
      assert.equal(body1.counts.candidateCount, 1);

      const state1 = await db.jobState.findUniqueOrThrow({ where: { key: 'ops-sample' } });
      assert.equal(state1.generation, 1);
      assert.equal(state1.lastStatus, 'SUCCEEDED');
      assert.equal(state1.lastSucceededAt?.toISOString(), '2026-11-27T12:00:00.000Z');

      // 租约被占用时返回 409 job_busy，不推进代次
      await db.jobState.update({
        where: { key: 'ops-sample' },
        data: { leaseOwner: 'other-worker', lockedUntil: new Date(currentNow.getTime() + 60_000) },
      });
      assert.equal((await postOp(boot1)).status, 409);
      await db.jobState.update({
        where: { key: 'ops-sample' },
        data: { leaseOwner: null, lockedUntil: null },
      });

      // 模拟进程重启：推进 15 分钟、写入新上传文件、构造全新组合服务实例再次按计划执行
      currentNow = new Date('2026-11-27T12:15:00.000Z');
      writeFileSync(path.join(uploadDir, 'file-2.bin'), Buffer.alloc(2048, 2));
      const boot2 = registry.createOperationsHandler({
        services: composition.createJobServices({
          db,
          clock,
          ops: { env: { STORAGE_DRIVER: 'local', UPLOAD_DIR: uploadDir } },
        }).jobs,
        clock,
        secret: SECRET,
      });
      const r2 = await postOp(boot2);
      assert.equal(r2.status, 200);
      const state2 = await db.jobState.findUniqueOrThrow({ where: { key: 'ops-sample' } });
      assert.equal(state2.generation, 2);
      assert.equal(state2.lastSucceededAt?.toISOString(), '2026-11-27T12:15:00.000Z');

      // 全新 AdminServices 读取 stats 反映第 2 轮真实值与真实时间戳，且未伪造 BACKUP
      const adminServices = composition.createAdminServices({ db, clock });
      const statsRes = await adminServices.stats.query({ role: 'ADMIN', userId: admin.userId, query: { sources: ['storage', 'backup'] } });
      assert.equal(findSource(statsRes.dto, 'storage').state, 'ok');
      assert.equal(findSource(statsRes.dto, 'storage').value, 3072);
      assert.equal(findSource(statsRes.dto, 'storage').lastSucceededAt, '2026-11-27T12:15:00.000Z');
      assert.equal(findSource(statsRes.dto, 'backup').state, 'not_connected');
    } finally {
      rmSync(uploadDir, { recursive: true, force: true });
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
