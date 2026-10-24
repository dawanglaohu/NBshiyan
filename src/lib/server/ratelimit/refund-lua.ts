/**
 * refund 用的 Lua：key 存在且值 > 0 才 DECR，否则什么都不做。不用裸 DECR：key 过期后裸 DECR 会新建一个 -1 且没有 TTL 的 key，
 * 之后 hit 的 PEXPIRE NX 就不会再设过期时间，这个桶永远不过期。脚本不碰 TTL。
 */
export const REFUND_LUA = "local v = tonumber(redis.call('GET', KEYS[1])) if v and v > 0 then return redis.call('DECR', KEYS[1]) end return 0";
