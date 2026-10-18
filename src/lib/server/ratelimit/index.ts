import { isProdEnvFrom } from '../../site';
/**
 * 可插拔限流存储。
 * - RATE_LIMIT_STORE=memory（默认）：进程内存，单实例有效，开发/预览用
 * - RATE_LIMIT_STORE=upstash：Upstash Redis REST（UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN），多实例共享
 * Upstash 不可用（超时/5xx/网络错误）时 hit()/refund() 直接 throw；hit 的降级行为（拒绝/本地计数/放行）由调用方 hitRateLimit 按路由的 onStoreError 决定（#74），
 * refund 出错由 refundRateLimit 直接忽略（计数保留，偏严）。
 */
export interface RateLimitStore {
  /** 计一次数，返回本窗口内是否仍在上限内 */
  hit(key: string, limit: number, windowMs: number): Promise<boolean>;
  /**
   * 退回一次 hit（key、windowMs 与那次 hit 相同，指向同一个窗口计数）。计数最低到 0；
   * key 不存在或窗口已过期时什么都不做，不新建 key、不动过期时间。
   */
  refund(key: string, windowMs: number): Promise<void>;
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
  async refund(key: string, windowMs: number) {
    const now = Date.now();
    const arr = this.hits.get(key);
    if (!arr) return;
    const live = arr.filter((t) => now - t < windowMs);
    if (!live.length) return; // 窗口已过期：不动（过期的记录留给 hit/sweep 清理）
    live.pop(); // 去掉最近的一次
    this.hits.set(key, live);
  }
  /** 清掉长时间没有请求的 key，防止内存无限增长 */
  private sweep(now: number) {
    for (const [k, v] of this.hits) if (!v.length || now - v[v.length - 1] > 24 * 3600_000) this.hits.delete(k);
  }
}

/** 固定窗口计数：key:窗口序号 INCR，首次设置过期。一次 pipeline 请求完成。 */
/**
 * refund 用的 Lua：key 存在且值 > 0 才 DECR，否则什么都不做。不用裸 DECR：key 过期后裸 DECR 会新建一个 -1 且没有 TTL 的 key，
 * 之后 hit 的 PEXPIRE NX 就不会再设过期时间，这个桶永远不过期。脚本不碰 TTL。
 */
export const REFUND_LUA = "local v = tonumber(redis.call('GET', KEYS[1])) if v and v > 0 then return redis.call('DECR', KEYS[1]) end return 0";

export class UpstashStore implements RateLimitStore {
  constructor(private url: string, private token: string, private timeoutMs = 1500, private prefix = 'rl:') {}
  private keyOf(key: string, windowMs: number) { return `${this.prefix}${key}:${Math.floor(Date.now() / windowMs)}`; }
  private async pipeline(cmds: string[][]) {
    const r = await fetch(`${this.url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(this.timeoutMs),
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(`upstash ${r.status}`);
    const j = (await r.json()) as { result?: unknown; error?: string }[];
    if (!Array.isArray(j) || j[0]?.error) throw new Error('upstash bad response');
    return j;
  }
  /** 出错（超时/非 2xx/错误响应）时 throw，不在这里吞掉 */
  async hit(key: string, limit: number, windowMs: number) {
    const k = this.keyOf(key, windowMs);
    const j = await this.pipeline([['INCR', k], ['PEXPIRE', k, String(windowMs), 'NX']]);
    const n = Number(j[0]?.result);
    if (!Number.isFinite(n)) throw new Error('upstash bad response');
    return n <= limit;
  }
  /** 条件 DECR 同一个 `rl:<key>:<窗口序号>`（见 REFUND_LUA）。出错 throw，由 refundRateLimit 忽略。 */
  async refund(key: string, windowMs: number) {
    await this.pipeline([['EVAL', REFUND_LUA, '1', this.keyOf(key, windowMs)]]);
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
  if (isProdEnvFrom(env)) console.warn('[ratelimit] 生产环境仍在用内存限流，多实例下不共享');
  return new MemoryStore();
}

const g = globalThis as unknown as { __rateLimitStore?: RateLimitStore };
export function rateLimitStore() {
  return (g.__rateLimitStore ??= createRateLimitStore());
}
/** 测试用 */
export function setRateLimitStore(s: RateLimitStore | undefined) { g.__rateLimitStore = s; }
