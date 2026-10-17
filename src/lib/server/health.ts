import { MemoryStore } from './ratelimit';

/**
 * GET /api/health 的逻辑（路由只是薄包装，方便测试）。
 * - 只返回 {ok:true} / {ok:false}，不带版本、commit、环境、配置或错误信息；Cache-Control: no-store
 * - 只查数据库 `SELECT 1`，超时 HEALTH_DB_TIMEOUT_MS（1.5 秒）按失败处理；失败原因只进日志（只记错误类型），响应里没有
 * - 不连 Redis / SMTP / R2 / 任何外部服务。限流用进程内存计数（不走 Upstash，避免健康检查依赖 Redis）
 * - 同一时刻只跑一个 SELECT 1，并发请求共用结果，避免压垮连接池
 */
export const HEALTH_DB_TIMEOUT_MS = 1_500;
export const HEALTH_RATE_LIMIT = 120; // 每个来源每分钟
export const HEALTH_RATE_WINDOW_MS = 60_000;
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } as const;

export type HealthDeps = {
  selectOne: () => Promise<unknown>;
  subject: string;
  limiter?: { hit(key: string, limit: number, windowMs: number): Promise<boolean> };
  timeoutMs?: number;
  log?: (msg: string) => void;
};

const localLimiter = new MemoryStore();
let inflight: Promise<boolean> | null = null;

function errKind(e: unknown) {
  if ((e as Error)?.message === 'health_timeout') return 'timeout';
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : 'error';
}

async function dbOk(d: HealthDeps): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      d.selectOne(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('health_timeout')), d.timeoutMs ?? HEALTH_DB_TIMEOUT_MS); }),
    ]);
    return true;
  } catch (e) {
    (d.log ?? console.error)(`[health] db check failed: ${errKind(e)}`);
    return false;
  } finally { clearTimeout(timer); }
}

export async function healthResponse(d: HealthDeps): Promise<Response> {
  const allowed = await (d.limiter ?? localLimiter).hit(`health:${d.subject}`, HEALTH_RATE_LIMIT, HEALTH_RATE_WINDOW_MS);
  if (!allowed) return new Response(JSON.stringify({ ok: false }), { status: 429, headers: { ...HEADERS, 'Retry-After': '60' } });
  const ok = await (inflight ??= dbOk(d).finally(() => { inflight = null; }));
  return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 503, headers: HEADERS });
}
