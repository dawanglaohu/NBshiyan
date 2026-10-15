import type { StepSummary } from './retention';

type Send = (kind: string, lines: Record<string, string | number>, dedupeKey: string) => Promise<void>;
type Audit = (e: { action: string; meta: { failed: string[]; skipped: string[]; codes: string[] } }) => Promise<void>;

/** 截断成只含 [A-Za-z0-9_.:-] 的短串，防止错误码里夹带别的内容 */
const safe = (v: string) => v.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60) || 'unknown';

/**
 * 定时清理有步骤失败或因截止时间跳过时发一封汇总告警。
 * 只含步骤名、错误类型/码和条数；按 UTC 日期去重（cron-cleanup:YYYY-MM-DD）。
 * 告警或审计失败只记日志，绝不抛出，不影响 cron 的响应。返回是否尝试发送。
 */
export async function alertCleanupIssues(
  s: Pick<StepSummary, 'failed' | 'skipped' | 'deadlineReached'>,
  errors: Record<string, string>,
  send: Send,
  audit?: Audit,
  now = new Date(),
): Promise<boolean> {
  if (!s.failed.length && !s.skipped.length) return false;
  const failed = s.failed.map(safe);
  const skipped = s.skipped.map(safe);
  const codes = s.failed.map((n) => `${safe(n)}=${safe(errors[n] ?? 'unknown')}`);
  const lines: Record<string, string | number> = {
    任务: 'cleanup-uploads',
    失败步骤数: failed.length,
    跳过步骤数: skipped.length,
  };
  if (codes.length) lines['失败步骤'] = codes.join(', ');
  if (skipped.length) lines['因截止时间跳过'] = skipped.join(', ');
  try {
    await send('定时清理异常', lines, `cron-cleanup:${now.toISOString().slice(0, 10)}`);
  } catch (e) {
    console.error('[cron] cleanup alert failed', (e as { name?: string })?.name ?? typeof e);
  }
  if (audit) {
    try { await audit({ action: 'cron.cleanup.alert', meta: { failed, skipped, codes } }); }
    catch (e) { console.error('[cron] cleanup alert audit failed', (e as { name?: string })?.name ?? typeof e); }
  }
  return true;
}
