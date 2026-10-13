import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { retentionDryRunCounts, isRetentionDryRun } from '../src/lib/server/retention-dry-run';

afterEach(() => { delete process.env.ADMIN_INACTIVE_DAYS; });

/** 任何非只读方法（create/update/delete/$executeRaw/$transaction…）一调用就记下来并抛错 */
function guardedDb(counts: Record<string, number[]>, users: { inactive: { id: string; role: string }[]; activeAdmins: number }) {
  const writes: string[] = [];
  const reads: string[] = [];
  const model = (name: string) => new Proxy({}, {
    get: (_t, m: string) => {
      if (m === 'count') return async () => { reads.push(`${name}.count`); return (counts[name] ?? []).shift() ?? 0; };
      if (m === 'findMany' && name === 'user') return async (a: any) => { reads.push('user.findMany'); return a.where.role === 'ADMIN' ? Array.from({ length: users.activeAdmins }, (_, i) => ({ id: `a${i}` })) : users.inactive; };
      return () => { writes.push(`${name}.${m}`); throw new Error(`write in dry run: ${name}.${m}`); };
    },
  });
  const db = new Proxy({}, { get: (_t, k: string) => (k.startsWith('$') ? () => { writes.push(k); throw new Error(k); } : model(k)) });
  return { db, writes, reads };
}

test('dry run only counts: zero writes, counts every step', async () => {
  const { db, writes, reads } = guardedDb(
    { sharedDesign: [3], logoUpload: [4, 2], sampleRequest: [5], auditLog: [6], inquiry: [7] },
    { inactive: [{ id: 's1', role: 'SALES' }], activeAdmins: 2 },
  );
  const r = await retentionDryRunCounts(db as never, new Date('2026-10-13T00:00:00Z'));
  assert.deepEqual(r, { designs: 3, orphanLogos: 4, sampleCounters: 5, auditLogs: 6, inquiries: 7, inquiryLogos: 2, inactiveUsers: 1, skippedLastAdmin: 0 });
  assert.deepEqual(writes, []);
  assert.ok(reads.every((x) => x.endsWith('.count') || x === 'user.findMany'));
});

test('dry run simulates last-ADMIN protection', async () => {
  const { db, writes } = guardedDb({}, { inactive: [{ id: 'a0', role: 'ADMIN' }, { id: 'a1', role: 'ADMIN' }, { id: 's1', role: 'SALES' }], activeAdmins: 2 });
  const r = await retentionDryRunCounts(db as never);
  assert.equal(r.inactiveUsers, 2); // a0 + s1
  assert.equal(r.skippedLastAdmin, 1); // a1 是最后一个有效 ADMIN
  assert.deepEqual(writes, []);
});

test('RETENTION_DRY_RUN only on exact "1"', () => {
  assert.equal(isRetentionDryRun({ RETENTION_DRY_RUN: '1' } as never), true);
  for (const v of [undefined, '', '0', 'true', 'yes']) assert.equal(isRetentionDryRun({ RETENTION_DRY_RUN: v } as never), false, String(v));
});

test('cron route: dry-run branch returns before any cleanup step', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../src/app/api/admin/cron/cleanup-uploads/route.ts', import.meta.url), 'utf8');
  const dry = src.indexOf('if (isRetentionDryRun())');
  const auth = src.indexOf('secretMatches(token');
  const steps = src.indexOf('const steps');
  assert.ok(auth > 0 && dry > auth && steps > dry, 'order: auth → dry run return → steps');
  assert.match(src.slice(dry, steps), /return NextResponse\.json\(\{ dryRun: true/);
});
