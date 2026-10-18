export const ENROLL_WINDOW_MS: number;
export const ERROR_LINE: 'error=audit_failed';
export const USAGE_LINE: 'error=no_args_accepted';
type CountArgs = { where: Record<string, unknown> };
export type AuditDb = { user: { count(args: CountArgs): Promise<number> }; $disconnect?(): Promise<void> };
export function windowClosedWhere(now: number): { OR: Record<string, unknown>[] };
export function windowClosedWhereCreatedOnly(now: number): { createdAt: { lte: Date } };
export function countAdmin2faAudit(db: AuditDb, now: number): Promise<{ admins: number; unboundOver72h: number }>;
export function formatAudit(r: { admins: number; unboundOver72h: number }): string;
export function runAudit(o: {
  db: AuditDb | (() => AuditDb | Promise<AuditDb>);
  now: number;
  argv?: string[];
  out: (s: string) => void;
  err: (s: string) => void;
}): Promise<0 | 1 | 2>;
