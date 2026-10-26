export const ORDINARY_ABSOLUTE_MS: number;
export const REMEMBERED_ABSOLUTE_MS: number;
export const ERROR_LINE: 'error=backfill_failed\n';
export const USAGE_LINE: 'error=no_args_accepted\n';

export type HardExpiresPolicy = { ordinaryAbsoluteMs: number; absoluteMs: number };
export type HardExpiresCounts = { ordinary: number; remembered: number };
export type ExecuteDb = {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number | bigint>;
  $disconnect?(): Promise<void>;
};

export function fillNullHardExpiresAt(db: ExecuteDb, policy: HardExpiresPolicy): Promise<HardExpiresCounts>;
export function runBackfill(options: {
  argv: readonly string[];
  backfill: () => Promise<HardExpiresCounts>;
  out: (chunk: string) => void;
  err: (chunk: string) => void;
}): Promise<0 | 1 | 2>;
