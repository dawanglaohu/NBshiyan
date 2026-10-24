/**
 * 生产依赖 high/critical 扫描。
 * 只允许 scripts/audit-exceptions.json 里这一条 zod 公告，且到期日必须是 2026-11-30（含当日，按 UTC）。
 * 改公告、包名、负责人或到期日都会失败，不能靠改配置延长豁免；2026-12-01 起该公告重新阻断。
 * 其他 high/critical 一律阻断。例外数为 0 时就是严格扫描。
 * 报告含 error、既没有 advisories 对象也没有 vulnerabilities 对象、或缺少 metadata 时失败。
 * pnpm 退出码非 0，且过滤后没有 high/critical、也没有命中豁免时失败。
 * CI=true 时忽略 AUDIT_PNPM_BIN，始终调用 pnpm。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APPROVED_EXCEPTION = {
  ghsa: 'GHSA-mrhx-c7xc-m3w5',
  package: 'zod',
  owner: 'Ryan',
  expires: '2026-11-30',
} as const;

const EXCEPTION_KEYS = ['expires', 'ghsa', 'owner', 'package', 'reason'] as const;
const GHSA_RE = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i;
const BLOCKING = new Set(['high', 'critical']);

export type Finding = { packageName: string; ghsa: string; severity: string };

export type AuditDecision = {
  ok: boolean;
  error?: string;
  suppressed: number;
  remaining: Finding[];
};

type Advisory = {
  name?: unknown;
  module_name?: unknown;
  severity?: unknown;
  github_advisory_id?: unknown;
  url?: unknown;
};

export function utcDay(now: Date): string {
  if (Number.isNaN(now.getTime())) throw new Error('invalid clock');
  return now.toISOString().slice(0, 10);
}

export function ghsaOf(adv: Advisory): string {
  if (typeof adv.github_advisory_id === 'string') {
    const id = adv.github_advisory_id.match(GHSA_RE);
    if (id) return id[0].toLowerCase();
  }
  if (typeof adv.url === 'string') {
    const id = adv.url.match(GHSA_RE);
    if (id) return id[0].toLowerCase();
  }
  return '';
}

function pushFinding(out: Finding[], packageName: unknown, ghsa: string, severity: unknown) {
  const name = typeof packageName === 'string' ? packageName : '';
  out.push({ packageName: name, ghsa, severity: String(severity || '').toLowerCase() });
}

export function collectFindings(report: unknown): Finding[] {
  const out: Finding[] = [];
  if (!report || typeof report !== 'object') return out;
  const root = report as Record<string, unknown>;
  const advisories = root.advisories;
  if (advisories && typeof advisories === 'object' && !Array.isArray(advisories)) {
    for (const raw of Object.values(advisories as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const adv = raw as Advisory;
      pushFinding(out, adv.module_name || adv.name, ghsaOf(adv), adv.severity);
    }
  }
  const vulns = root.vulnerabilities;
  if (vulns && typeof vulns === 'object' && !Array.isArray(vulns)) {
    for (const [pkg, raw] of Object.entries(vulns as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const vuln = raw as { via?: unknown; severity?: unknown };
      if (!Array.isArray(vuln.via)) continue;
      for (const item of vuln.via) {
        if (!item || typeof item !== 'object') continue;
        const adv = item as Advisory;
        pushFinding(out, adv.name || pkg, ghsaOf(adv), adv.severity || vuln.severity);
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = `${f.packageName}\0${f.ghsa}\0${f.severity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function approvedEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== EXCEPTION_KEYS.length || keys.some((key, i) => key !== EXCEPTION_KEYS[i])) return false;
  return record.ghsa === APPROVED_EXCEPTION.ghsa
    && record.package === APPROVED_EXCEPTION.package
    && record.owner === APPROVED_EXCEPTION.owner
    && record.expires === APPROVED_EXCEPTION.expires
    && typeof record.reason === 'string'
    && record.reason.trim().length > 0;
}

export function evaluateAudit(input: { report: unknown; exceptions: unknown; now?: Date }): AuditDecision {
  const { report, exceptions } = input;
  const now = input.now ?? new Date();
  if (!Array.isArray(exceptions)) {
    return { ok: false, error: 'exceptions 必须是数组', suppressed: 0, remaining: [] };
  }
  if (exceptions.length > 1) {
    return { ok: false, error: '只允许一条豁免', suppressed: 0, remaining: [] };
  }
  let active = false;
  if (exceptions.length === 1) {
    if (!approvedEntry(exceptions[0])) {
      return { ok: false, error: '豁免与已批准的 zod 公告不一致', suppressed: 0, remaining: [] };
    }
    active = utcDay(now) <= APPROVED_EXCEPTION.expires;
  }
  const blocking = collectFindings(report).filter((f) => BLOCKING.has(f.severity));
  const remaining = blocking.filter((f) => {
    if (!active) return true;
    return !(f.packageName === APPROVED_EXCEPTION.package && f.ghsa === APPROVED_EXCEPTION.ghsa.toLowerCase());
  });
  return { ok: remaining.length === 0, suppressed: blocking.length - remaining.length, remaining };
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function redact(text: string): string {
  if (/ghp_|github_pat_|npm_|Bearer\s+|eyJ[A-Za-z0-9_-]{10,}/.test(text)) return '';
  return text.replace(/\s+/g, ' ').slice(0, 180);
}

function auditErrorDetail(error: unknown): string {
  if (typeof error === 'string') return redact(error);
  if (!isRecord(error)) return '';
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? redact(error.message) : '';
  return [code, message].filter(Boolean).join(': ');
}

export function reportRejection(report: unknown): string | null {
  if (!isRecord(report)) return 'pnpm audit 报告不是对象，拒绝放行';
  if (Object.hasOwn(report, 'error')) {
    const detail = auditErrorDetail(report.error);
    return detail ? `pnpm audit 返回错误，拒绝放行：${detail}` : 'pnpm audit 返回错误，拒绝放行';
  }
  const hasAdvisories = isRecord(report.advisories);
  const hasVulns = isRecord(report.vulnerabilities);
  if (!hasAdvisories && !hasVulns) {
    return 'pnpm audit 报告既没有 advisories 对象，也没有 vulnerabilities 对象，拒绝放行';
  }
  if (!isRecord(report.metadata)) return 'pnpm audit 报告缺少 metadata，拒绝放行';
  return null;
}

export function pnpmLaunch(env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const configured = env.CI === 'true' ? undefined : env.AUDIT_PNPM_BIN;
  if (configured && configured.endsWith('.cjs')) {
    return { command: process.execPath, args: [configured] };
  }
  return {
    command: configured || (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
    args: [],
  };
}

function spawnPnpm(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const launch = pnpmLaunch(env);
  // Node 在 Windows 上直接 spawn .cmd/.bat 会 EINVAL，经 shell 才能调到真正的 pnpm。
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(launch.command);
  return spawnSync(launch.command, [...launch.args, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    shell,
    windowsHide: true,
  });
}

export function runAuditCli(now = new Date(), env: NodeJS.ProcessEnv = process.env): number {
  const root = repoRoot();
  const file = path.join(root, 'scripts', 'audit-exceptions.json');
  let parsedFile: unknown;
  try {
    parsedFile = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.error('无法读取 scripts/audit-exceptions.json');
    return 1;
  }
  if (!parsedFile || typeof parsedFile !== 'object' || Array.isArray(parsedFile) || !('exceptions' in parsedFile)) {
    console.error('scripts/audit-exceptions.json 必须是含 exceptions 数组的对象');
    return 1;
  }
  const result = spawnPnpm(['audit', '--audit-level', 'high', '--prod', '--json'], root, env);
  if (result.error) {
    console.error('无法启动 pnpm audit');
    return 1;
  }
  if (result.status !== 0 && result.status !== 1) {
    console.error(`pnpm audit 未能完成，退出码 ${String(result.status)}`);
    return 1;
  }
  const jsonText = extractJson(result.stdout || '');
  if (!jsonText) {
    console.error('pnpm audit 没有返回 JSON');
    return 1;
  }
  let report: unknown;
  try {
    report = JSON.parse(jsonText);
  } catch {
    console.error('pnpm audit 的 JSON 无法解析');
    return 1;
  }
  const rejection = reportRejection(report);
  if (rejection) {
    console.error(rejection);
    return 1;
  }
  const decision = evaluateAudit({
    report,
    exceptions: (parsedFile as { exceptions: unknown }).exceptions,
    now,
  });
  if (!decision.ok) {
    console.error(decision.error || '仍有 high 或 critical 漏洞');
    for (const finding of decision.remaining) {
      console.error(`${finding.severity} ${finding.packageName} ${finding.ghsa || '(无 GHSA)'}`);
    }
    return 1;
  }
  if (result.status !== 0 && decision.suppressed === 0) {
    console.error(`pnpm audit 退出码为 ${String(result.status)}，但没有 high/critical 发现，也没有命中豁免，拒绝放行`);
    return 1;
  }
  console.log(`依赖扫描通过。已豁免 ${decision.suppressed} 条，剩余 high/critical 为 0。`);
  return 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) process.exit(runAuditCli());
