import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVED_EXCEPTION, evaluateAudit, runAuditCli, utcDay, type Finding } from '../scripts/audit-high-prod';

const approved = {
  ghsa: APPROVED_EXCEPTION.ghsa,
  package: APPROVED_EXCEPTION.package,
  reason: '修复只在 zod 4.x。负责人 Ryan。',
  owner: APPROVED_EXCEPTION.owner,
  expires: APPROVED_EXCEPTION.expires,
};

const zod: Finding = { packageName: 'zod', ghsa: APPROVED_EXCEPTION.ghsa, severity: 'high' };
const other: Finding = { packageName: 'leftpad', ghsa: 'GHSA-aaaa-bbbb-cccc', severity: 'high' };

function advisoryReport(findings: Finding[]) {
  return {
    advisories: Object.fromEntries(findings.map((f, i) => [String(i), {
      module_name: f.packageName,
      severity: f.severity,
      github_advisory_id: f.ghsa,
      url: `https://github.com/advisories/${f.ghsa}`,
    }])),
  };
}

test('UTC 日期含 2026-11-30，次日不再含', () => {
  assert.equal(utcDay(new Date('2026-11-30T23:59:59.999Z')), '2026-11-30');
  assert.equal(utcDay(new Date('2026-12-01T00:00:00.000Z')), '2026-12-01');
});

test('2026-11-30 只豁免这一条 zod 公告，moderate 不阻断', () => {
  const decision = evaluateAudit({
    report: advisoryReport([zod, { packageName: 'leftpad', ghsa: 'GHSA-aaaa-bbbb-cccc', severity: 'moderate' }]),
    exceptions: [approved],
    now: new Date('2026-11-30T12:00:00.000Z'),
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.suppressed, 1);
  assert.deepEqual(decision.remaining, []);
});

test('公告编号大小写不同仍只豁免这一条', () => {
  const decision = evaluateAudit({
    report: advisoryReport([{ packageName: 'zod', ghsa: APPROVED_EXCEPTION.ghsa.toUpperCase(), severity: 'high' }]),
    exceptions: [approved],
    now: new Date('2026-11-30T00:00:00.000Z'),
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.suppressed, 1);
});

test('2026-12-01 起同一条 zod 公告重新阻断', () => {
  const decision = evaluateAudit({
    report: advisoryReport([zod]),
    exceptions: [approved],
    now: new Date('2026-12-01T00:00:00.000Z'),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.suppressed, 0);
  assert.equal(decision.remaining.length, 1);
  assert.equal(decision.remaining[0].ghsa, APPROVED_EXCEPTION.ghsa.toLowerCase());
});

test('其他 GHSA 或别的包即使同号也不豁免', () => {
  const sameIdOtherPkg = evaluateAudit({
    report: advisoryReport([{ packageName: 'not-zod', ghsa: APPROVED_EXCEPTION.ghsa, severity: 'high' }]),
    exceptions: [approved],
    now: new Date('2026-11-01T00:00:00.000Z'),
  });
  assert.equal(sameIdOtherPkg.ok, false);
  const otherGhsa = evaluateAudit({
    report: advisoryReport([other]),
    exceptions: [approved],
    now: new Date('2026-11-01T00:00:00.000Z'),
  });
  assert.equal(otherGhsa.ok, false);
  assert.equal(otherGhsa.remaining[0].ghsa, other.ghsa.toLowerCase());
});

test('第二条豁免、错误负责人、错误到期日或多余字段都失败', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');
  const clean = { advisories: {} };
  assert.equal(evaluateAudit({ report: clean, exceptions: [approved, approved], now }).ok, false);
  assert.match(evaluateAudit({ report: clean, exceptions: [{ ...approved, owner: 'Eve' }], now }).error || '', /不一致/);
  assert.equal(evaluateAudit({ report: clean, exceptions: [{ ...approved, expires: '2027-01-01' }], now }).ok, false);
  assert.equal(evaluateAudit({ report: clean, exceptions: [{ ...approved, note: 'no' }], now }).ok, false);
  assert.equal(evaluateAudit({ report: advisoryReport([zod]), exceptions: [{ ...approved, owner: 'Eve' }], now }).ok, false);
});

test('没有豁免时干净报告通过，zod 公告阻断', () => {
  assert.equal(evaluateAudit({ report: { advisories: {} }, exceptions: [], now: new Date('2026-12-02T00:00:00.000Z') }).ok, true);
  assert.equal(evaluateAudit({ report: advisoryReport([zod]), exceptions: [], now: new Date('2026-11-01T00:00:00.000Z') }).ok, false);
});

test('豁免过期但公告已消失时通过；critical 仍阻断', () => {
  const expiredClean = evaluateAudit({
    report: { advisories: {} },
    exceptions: [approved],
    now: new Date('2026-12-01T00:00:00.000Z'),
  });
  assert.equal(expiredClean.ok, true);
  assert.equal(expiredClean.suppressed, 0);
  const critical = evaluateAudit({
    report: advisoryReport([{ packageName: 'leftpad', ghsa: 'GHSA-dddd-eeee-ffff', severity: 'critical' }]),
    exceptions: [approved],
    now: new Date('2026-11-01T00:00:00.000Z'),
  });
  assert.equal(critical.ok, false);
  assert.equal(critical.remaining[0].severity, 'critical');
});

test('npm v2 报告按 via 对象认 GHSA，字符串传递不另算一条', () => {
  const decision = evaluateAudit({
    report: {
      vulnerabilities: {
        zod: {
          severity: 'high',
          via: [{ name: 'zod', severity: 'high', url: `https://github.com/advisories/${APPROVED_EXCEPTION.ghsa}` }],
        },
        parent: { severity: 'high', via: ['zod'] },
      },
    },
    exceptions: [approved],
    now: new Date('2026-11-30T00:00:00.000Z'),
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.suppressed, 1);
});

test('仓库里的豁免文件只有这一条已批准记录', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'audit-exceptions.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { exceptions: Record<string, string>[] };
  assert.equal(parsed.exceptions.length, 1);
  const entry = parsed.exceptions[0];
  assert.equal(entry.ghsa, APPROVED_EXCEPTION.ghsa);
  assert.equal(entry.package, APPROVED_EXCEPTION.package);
  assert.equal(entry.owner, APPROVED_EXCEPTION.owner);
  assert.equal(entry.expires, APPROVED_EXCEPTION.expires);
  assert.match(entry.reason, /Ryan/);
  assert.match(entry.reason, /2026-11-30|4\.6\.6|zod 4/);
  const decision = evaluateAudit({
    report: advisoryReport([zod]),
    exceptions: parsed.exceptions,
    now: new Date('2026-11-30T00:00:00.000Z'),
  });
  assert.equal(decision.ok, true);
});

const cleanReport = {
  advisories: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
};

function envWithoutCi(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.CI;
  return env;
}

function writeFakePnpm(stdout: string, status: number): { dir: string; bin: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-fake-pnpm-'));
  const bin = path.join(dir, 'pnpm.cjs');
  writeFileSync(bin, `process.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${status});\n`);
  return { dir, bin };
}

function captureAudit(env: NodeJS.ProcessEnv, now = new Date('2026-11-30T00:00:00.000Z')) {
  const errors: string[] = [];
  const logs: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    return { code: runAuditCli(now, env), errors: errors.join('\n'), logs: logs.join('\n') };
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
}

describe('无法确认的审计结果拒绝放行', { concurrency: false }, () => {
  test('error 报告失败', () => {
    const payload = JSON.stringify({
      error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE', message: 'The registry responded with 403' },
    });
    const fake = writeFakePnpm(payload, 1);
    try {
      const result = captureAudit(envWithoutCi({ AUDIT_PNPM_BIN: fake.bin }));
      assert.equal(result.code, 1);
      assert.match(result.errors, /ERR_PNPM_AUDIT_BAD_RESPONSE/);
      assert.match(result.errors, /拒绝放行/);
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test('空对象失败', () => {
    const fake = writeFakePnpm('{}', 0);
    try {
      const result = captureAudit(envWithoutCi({ AUDIT_PNPM_BIN: fake.bin }));
      assert.equal(result.code, 1);
      assert.match(result.errors, /既没有 advisories 对象，也没有 vulnerabilities 对象/);
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test('有 advisories 但缺少 metadata 时失败', () => {
    const fake = writeFakePnpm(JSON.stringify({ advisories: {} }), 0);
    try {
      const result = captureAudit(envWithoutCi({ AUDIT_PNPM_BIN: fake.bin }));
      assert.equal(result.code, 1);
      assert.match(result.errors, /缺少 metadata/);
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test('退出码 1 但报告干净时失败', () => {
    const fake = writeFakePnpm(JSON.stringify(cleanReport), 1);
    try {
      const result = captureAudit(envWithoutCi({ AUDIT_PNPM_BIN: fake.bin }));
      assert.equal(result.code, 1);
      assert.match(result.errors, /退出码为 1/);
      assert.match(result.errors, /没有命中豁免/);
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test('退出码 1 且只命中已批准的 zod 公告时通过', () => {
    const report = {
      advisories: {
        '111': {
          module_name: 'zod',
          severity: 'high',
          github_advisory_id: APPROVED_EXCEPTION.ghsa,
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
    };
    const fake = writeFakePnpm(JSON.stringify(report), 1);
    try {
      const result = captureAudit(envWithoutCi({ AUDIT_PNPM_BIN: fake.bin }));
      assert.equal(result.code, 0);
      assert.match(result.logs, /已豁免 1 条/);
    } finally {
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test('CI=true 时设置 AUDIT_PNPM_BIN 不能放行', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-ci-pnpm-'));
    const bypassMarker = path.join(dir, 'bypass');
    const realMarker = path.join(dir, 'real');
    const bypass = path.join(dir, 'bypass.cjs');
    const errorJson = JSON.stringify({
      error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE', message: 'ci stub' },
    });
    writeFileSync(bypass, `require('fs').writeFileSync(${JSON.stringify(bypassMarker)}, '1');\nprocess.stdout.write(${JSON.stringify(JSON.stringify(cleanReport))});\nprocess.exit(0);\n`);
    const stub = path.join(dir, 'stub.cjs');
    writeFileSync(stub, `require('fs').writeFileSync(${JSON.stringify(realMarker)}, '1');\nprocess.stdout.write(${JSON.stringify(errorJson)});\nprocess.exit(1);\n`);
    if (process.platform === 'win32') {
      writeFileSync(path.join(dir, 'pnpm.cmd'), `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`);
    } else {
      const shim = path.join(dir, 'pnpm');
      writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
      chmodSync(shim, 0o755);
    }
    try {
      const result = captureAudit({
        ...process.env,
        CI: 'true',
        AUDIT_PNPM_BIN: bypass,
        PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
      });
      assert.equal(existsSync(bypassMarker), false);
      assert.equal(existsSync(realMarker), true);
      assert.equal(result.code, 1);
      assert.match(result.errors, /ERR_PNPM_AUDIT_BAD_RESPONSE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
