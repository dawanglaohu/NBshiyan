import { z } from 'zod';
// web-vitals 上报的数据格式与校验（不含个人信息：不收 IP、UA 原文、完整 URL 查询串）
export const METRICS = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'] as const;
export const RumBody = z.object({
  name: z.enum(METRICS),
  value: z.number().finite().min(0).max(600_000),
  rating: z.enum(['good', 'needs-improvement', 'poor']).optional(),
  id: z.string().max(64).regex(/^[\w.-]+$/),
  path: z.string().max(200).regex(/^\/[\w\-/.%]*$/),
  nav: z.string().max(32).regex(/^[\w-]*$/).optional(),
  device: z.enum(['mobile', 'desktop']).optional()
}).strict();
export type Rum = z.infer<typeof RumBody>;
export function parseRum(raw: string): Rum | null {
  try { const r = RumBody.safeParse(JSON.parse(raw)); return r.success ? r.data : null; } catch { return null; }
}
