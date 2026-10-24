import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVED_EXCEPTION, evaluateAudit, utcDay, type Finding } from '../scripts/audit-high-prod';

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
