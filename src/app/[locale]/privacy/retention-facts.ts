import { RAW_EVENT_RETENTION_MS } from '@/lib/analytics/day-boundaries';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Aggregate analytics retention is not exported by the rollup jobs yet. */
export const AGGREGATE_RETENTION_MONTHS = 13;

export function retentionFacts() {
  return {
    rawAnalyticsDays: RAW_EVENT_RETENTION_MS / DAY_MS,
    aggregateMonths: AGGREGATE_RETENTION_MONTHS,
  };
}
