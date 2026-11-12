// M5-T12 守卫负控（离线，stub tx 走真实函数分支）：不连 PG。
// 覆盖原审要求的失败谓词：缺行 / 代次不等（含小于）/ owner 不等 / 过期 / 未传（编译期必填由类型保证）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDailyAggregateGuards } from '../src/lib/server/analytics/aggregate';
import { AggregateVersionConflict } from '../src/lib/server/analytics/aggregate';

const NOW = new Date('2026-03-02T10:00:00.000Z');

function stubTx(jobState: Array<Record<string, unknown>>): Parameters<typeof assertDailyAggregateGuards>[0] {
  let call = 0;
  return {
    $executeRaw: async () => 0,
    $queryRaw: async () => {
      call += 1;
      if (call === 1) return jobState;
      return [{ value: { timezoneRevision: 3, timezone: 'UTC', version: 1, changedAt: NOW.toISOString(), updatedBy: null } }];
    },
  } as unknown as Parameters<typeof assertDailyAggregateGuards>[0];
}

const base = { timezoneRevision: 3, now: NOW, generation: 7, leaseOwner: 'analytics-aggregate' };
const future = new Date(Date.now() + 60_000).toISOString().replace('T', 'T').replace('Z', 'Z');

describe('M5-T12 assertDailyAggregateGuards fail-closed', { concurrency: false }, () => {
  test('正常租约通过', async () => {
    await assertDailyAggregateGuards(stubTx([{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil: future }]), base);
  });

  test('无 JobState 行 → stale_generation', async () => {
    await assert.rejects(() => assertDailyAggregateGuards(stubTx([]), base), AggregateVersionConflict);
  });

  test('代次不相等（含库内更小）→ stale_generation', async () => {
    for (const generation of [6, 8]) {
      await assert.rejects(
        () => assertDailyAggregateGuards(stubTx([{ generation, leaseOwner: 'analytics-aggregate', lockedUntil: future }]), base),
        AggregateVersionConflict,
      );
    }
  });

  test('owner 不等 → stale_generation', async () => {
    await assert.rejects(
      () => assertDailyAggregateGuards(stubTx([{ generation: 7, leaseOwner: 'other-worker', lockedUntil: future }]), base),
      AggregateVersionConflict,
    );
  });

  test('lockedUntil 缺失/非法/已过期 → stale_generation', async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    for (const lockedUntil of [null, 'not-a-time', past]) {
      await assert.rejects(
        () => assertDailyAggregateGuards(stubTx([{ generation: 7, leaseOwner: 'analytics-aggregate', lockedUntil }]), base),
        AggregateVersionConflict,
      );
    }
  });
});
