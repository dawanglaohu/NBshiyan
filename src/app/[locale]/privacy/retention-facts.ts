import { RAW_EVENT_RETENTION_MS } from '@/lib/analytics/day-boundaries';
import { CHAT_VISITOR_POLICY } from '@/lib/server/config';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Consultation retention is not exported by the chat jobs yet. */
export const CONSULTATION_RETENTION_DAYS = 90;

/** Aggregate analytics retention is not exported by the rollup jobs yet. */
export const AGGREGATE_RETENTION_MONTHS = 13;

export function retentionFacts() {
  return {
    chatIdleDays: CHAT_VISITOR_POLICY.idleMs / DAY_MS,
    chatAbsoluteDays: CHAT_VISITOR_POLICY.absoluteMs / DAY_MS,
    consultationDays: CONSULTATION_RETENTION_DAYS,
    rawAnalyticsDays: RAW_EVENT_RETENTION_MS / DAY_MS,
    aggregateMonths: AGGREGATE_RETENTION_MONTHS,
  };
}
