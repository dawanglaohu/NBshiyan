import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type Row = { id: string; expiresAt: Date; consumedAt: Date | null };

test('cleanup removes expired and consumed challenges and leaves a live one', async () => {
  const now = new Date('2026-10-26T00:00:00.000Z');
  const rows: Row[] = [
    { id: 'expired', expiresAt: new Date(now.getTime() - 1000), consumedAt: null },
    { id: 'consumed', expiresAt: new Date(now.getTime() + 60_000), consumedAt: new Date(now.getTime() - 500) },
    { id: 'live', expiresAt: new Date(now.getTime() + 60_000), consumedAt: null },
  ];
  const seen: unknown[] = [];
  const db = {
    adminLoginChallenge: {
      findMany: async (args: { where: { OR: unknown[] }; take: number }) => {
        seen.push(args.where);
        return rows
          .filter((row) => row.expiresAt < now || row.consumedAt != null)
          .slice(0, args.take)
          .map((row) => ({ id: row.id }));
      },
      deleteMany: async (args: { where: { id: { in: string[] } } }) => {
        let count = 0;
        for (const id of args.where.id.in) {
          const index = rows.findIndex((row) => row.id === id);
          if (index < 0) continue;
          rows.splice(index, 1);
          count += 1;
        }
        return { count };
      },
    },
  };
  const { cleanupExpiredLoginChallenges, staleLoginChallengeWhere } = await import('../src/lib/server/admin/login-challenge');
  const removed = await cleanupExpiredLoginChallenges(db as never, now);
  assert.equal(removed, 2);
  assert.deepEqual(rows.map((row) => row.id), ['live']);
  assert.deepEqual(seen[0], staleLoginChallengeWhere(now));

  const blocked = await cleanupExpiredLoginChallenges(db as never, now, Date.now() - 1);
  assert.equal(blocked, 0);
  assert.deepEqual(rows.map((row) => row.id), ['live']);

  const route = readFileSync('src/app/api/admin/cron/cleanup-uploads/route.ts', 'utf8');
  assert.match(route, /\['loginChallenges', \(d\) => cleanupExpiredLoginChallenges\(prisma, new Date\(\), d\)\]/);
  const dry = route.indexOf('isRetentionDryRun');
  const steps = route.indexOf('const steps');
  assert.ok(dry > 0 && steps > dry);
});
