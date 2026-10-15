/**
 * 可插拔限流存储。
 * - RATE_LIMIT_STORE=memory（默认）：进程内存，单实例有效，开发/预览用
 * - RATE_LIMIT_STORE=upstash：Upstash Redis REST（UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN），多实例共享
 * Upstash 不可用（超时/5xx/网络错误）时 hit() 直接 throw；降级行为（拒绝/本地计数/放行）由调用方 hitRateLimit 按路由的 onStoreError 决定（#74）。
 */
export interface RateLimitStore {
  /** 计一次数，返回本窗口内是否仍在上限内 */
  hit(key: string, limit: number, windowMs: number): Promise<boolean>;
}

export class MemoryStore implements RateLimitStore {
  private hits = new Map<string, number[]>();
  private calls = 0;
  async hit(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    if (++this.calls % 1000 === 0) this.sweep(now);
    return arr.length <= limit;
  }
  /** 清掉长时间没有请求的 key，防止内存无限增长 */
  private sweep(now: number) {
    for (const [k, v] of this.hits) if (!v.length || now - v[v.length - 1] > 24 * 3600_000) this.hits.delete(k);
  }
}

/** 固定窗口计数：key:窗口序号 INCR，首次设置过期。一次 pipeline 请求完成。 */
export class UpstashStore implements RateLimitStore {
  constructor(private url: string, private token: string, private timeoutMs = 1500, private prefix = 'rl:') {}
  /** 出错（超时/非 2xx/错误响应）时 throw，不在这里吞掉 */
  async hit(key: string, limit: number, windowMs: number) {
    const bucket = Math.floor(Date.now() / windowMs);
    const k = `${this.prefix}${key}:${bucket}`;
    const r = await fetch(`${this.url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['INCR', k], ['PEXPIRE', k, String(windowMs), 'NX']]),
      signal: AbortSignal.timeout(this.timeoutMs),
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(`upstash ${r.status}`);
    const j = (await r.json()) as { result?: unknown; error?: string }[];
    const n = Number(j?.[0]?.result);
    if (j?.[0]?.error || !Number.isFinite(n)) throw new Error('upstash bad response');
    return n <= limit;
  }
}

export function createRateLimitStore(env: Record<string, string | undefined> = process.env): RateLimitStore {
  const kind = env.RATE_LIMIT_STORE ?? 'memory';
  if (kind === 'upstash') {
    const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error('RATE_LIMIT_STORE=upstash 需要 UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN');
    if (!url.startsWith('https://') && env.NODE_ENV === 'production') throw new Error('UPSTASH_REDIS_REST_URL 必须是 https');
    return new UpstashStore(url, token);
  }
  if (kind !== 'memory') throw new Error(`未知的 RATE_LIMIT_STORE: ${kind}`);
  if (env.NODE_ENV === 'production' && env.VERCEL) console.warn('[ratelimit] 生产环境仍在用内存限流，多实例下不共享');
  return new MemoryStore();
}

const g = globalThis as unknown as { __rateLimitStore?: RateLimitStore };
export function rateLimitStore() {
  return (g.__rateLimitStore ??= createRateLimitStore());
}
/** 测试用 */
export function setRateLimitStore(s: RateLimitStore | undefined) { g.__rateLimitStore = s; }
