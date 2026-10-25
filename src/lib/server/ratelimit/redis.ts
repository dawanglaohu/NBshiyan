import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { REFUND_LUA } from './refund-lua';

/**
 * 最小 RESP 客户端（Node 内置 net / tls，无第三方 Redis 包）。
 * 连接只来自 REDIS_URL（redis:// 或 rediss://）。出错 throw 的文案是固定短句，不含主机、密码、key。
 * hit 与 UpstashStore 一样：INCR 后 PEXPIRE NX（需要 Redis 7 或更新），同一次写入里用同一个时间算窗口号。
 */

export type RedisEndpoint = {
  host: string;
  port: number;
  tls: boolean;
  username?: string;
  password?: string;
  db: number;
  /** 设了就替换默认信任库（调用方应已并入公共根证书） */
  ca?: ReadonlyArray<string | Buffer>;
};

const MISSING = 'RATE_LIMIT_STORE=redis 需要 REDIS_URL';
const BAD_SCHEME = 'REDIS_URL 必须是 redis:// 或 rediss://';
const BAD_URL = 'REDIS_URL 无效';

export function parseRedisUrl(raw: string | undefined): { ok: true; endpoint: RedisEndpoint } | { ok: false; error: string } {
  const text = raw?.trim();
  if (!text) return { ok: false, error: MISSING };
  let u: URL;
  try { u = new URL(text); } catch { return { ok: false, error: BAD_SCHEME }; }
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') return { ok: false, error: BAD_SCHEME };
  if (u.search || u.hash || !u.hostname) return { ok: false, error: BAD_URL };
  const port = u.port ? Number(u.port) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: BAD_URL };
  const path = u.pathname.replace(/^\//, '');
  if (path && (!/^\d+$/.test(path) || Number(path) > 15)) return { ok: false, error: BAD_URL };
  let password: string | undefined;
  let username: string | undefined;
  try {
    password = u.password ? decodeURIComponent(u.password) : undefined;
    username = u.username ? decodeURIComponent(u.username) : undefined;
  } catch { return { ok: false, error: BAD_URL }; }
  if (username && !password) return { ok: false, error: BAD_URL };
  const host = u.hostname.startsWith('[') && u.hostname.endsWith(']') ? u.hostname.slice(1, -1) : u.hostname;
  return { ok: true, endpoint: { host, port, tls: u.protocol === 'rediss:', username, password, db: path ? Number(path) : 0 } };
}

/** 读 env 里的 REDIS_URL。rediss:// 且设置了 NODE_EXTRA_CA_CERTS 时，把该 PEM 并进信任库（文件读不到则 throw，文案不含路径）。 */
export function redisEndpointFromEnv(env: Record<string, string | undefined>): RedisEndpoint {
  const parsed = parseRedisUrl(env.REDIS_URL);
  if (!parsed.ok) throw new Error(parsed.error);
  const ep: RedisEndpoint = { ...parsed.endpoint };
  const caPath = env.NODE_EXTRA_CA_CERTS?.trim();
  if (ep.tls && caPath) {
    let pem: Buffer;
    try { pem = readFileSync(caPath); } catch { throw new Error('redis connection failed'); }
    if (!pem.length) throw new Error('redis connection failed');
    ep.ca = [...tls.rootCertificates, pem];
  }
  return ep;
}

type Reply =
  | { kind: 'ok'; value: string }
  | { kind: 'err'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bulk'; value: Buffer | null }
  | { kind: 'arr'; value: Reply[] };

const MAX_BULK = 1_000_000;
const MAX_ARRAY = 64;
/** 正常回复是平的。0 是最外层，超过 2 层嵌套直接当坏回复，避免递归把进程打爆。 */
const MAX_RESP_DEPTH = 2;

function encodeCommand(args: string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.from(a);
    chunks.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(chunks);
}

/** 长度和个数必须是整数字面量。空串、1e3、带空格都不行。 */
function respCount(head: string): number | null {
  if (!/^-?\d+$/.test(head)) return null;
  const n = Number(head);
  return Number.isInteger(n) ? n : null;
}

/** 从 buf[at] 读一条 RESP。数据不够返回 null。协议不对返回 reply:'bad'。 */
function readOne(buf: Buffer, at: number, depth = 0): { reply: Reply | 'bad'; next: number } | null {
  if (depth > MAX_RESP_DEPTH) return { reply: 'bad', next: at };
  if (at >= buf.length) return null;
  const nl = buf.indexOf('\r\n', at);
  if (nl < 0) return null;
  const type = String.fromCharCode(buf[at]);
  const head = buf.toString('utf8', at + 1, nl);
  const next = nl + 2;
  if (type === '+' || type === '-') return { reply: { kind: type === '+' ? 'ok' : 'err', value: head }, next };
  if (type === ':') {
    const value = respCount(head);
    if (value === null || !Number.isSafeInteger(value)) return { reply: 'bad', next };
    return { reply: { kind: 'int', value }, next };
  }
  if (type === '$') {
    const n = respCount(head);
    if (n === null || n > MAX_BULK) return { reply: 'bad', next };
    if (n < 0) {
      if (n !== -1) return { reply: 'bad', next };
      return { reply: { kind: 'bulk', value: null }, next };
    }
    if (buf.length < next + n + 2) return null;
    return { reply: { kind: 'bulk', value: Buffer.from(buf.subarray(next, next + n)) }, next: next + n + 2 };
  }
  if (type === '*') {
    const n = respCount(head);
    if (n === null || n < 0 || n > MAX_ARRAY) return { reply: 'bad', next };
    const value: Reply[] = [];
    let p = next;
    for (let i = 0; i < n; i++) {
      const one = readOne(buf, p, depth + 1);
      if (!one) return null;
      if (one.reply === 'bad') return { reply: 'bad', next: one.next };
      value.push(one.reply);
      p = one.next;
    }
    return { reply: { kind: 'arr', value }, next: p };
  }
  return { reply: 'bad', next };
}

/** 读一条 RESP。测试与重置脚本里的副本对照用。 */
export function parseResp(buf: Buffer, at = 0) {
  return readOne(buf, at, 0);
}

function connect(ep: RedisEndpoint, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    const opts: net.NetConnectOpts & tls.ConnectionOptions = { host: ep.host, port: ep.port };
    if (ep.tls) {
      if (ep.ca) opts.ca = ep.ca as (string | Buffer)[];
      if (!net.isIP(ep.host)) opts.servername = ep.host;
    }
    const sock = ep.tls ? tls.connect(opts) : net.connect(opts);
    const timer = setTimeout(() => fail(new Error('redis timeout')), timeoutMs);
    sock.once('error', () => fail(new Error('redis connection failed')));
    sock.once(ep.tls ? 'secureConnect' : 'connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sock);
    });
  });
}

function readReplies(sock: net.Socket, n: number, timeoutMs: number): Promise<Reply[]> {
  return new Promise((resolve, reject) => {
    const bufs: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err: Error | null, value?: Reply[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      sock.removeListener('end', onEnd);
      sock.removeListener('timeout', onTimeout);
      if (err) reject(err);
      else resolve(value!);
    };
    const pump = () => {
      try {
        const buf = Buffer.concat(bufs, size);
        const out: Reply[] = [];
        let at = 0;
        while (out.length < n) {
          const one = readOne(buf, at);
          if (!one) return;
          if (one.reply === 'bad') return finish(new Error('redis bad response'));
          out.push(one.reply);
          at = one.next;
        }
        finish(null, out);
      } catch {
        finish(new Error('redis bad response'));
      }
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > MAX_BULK) return finish(new Error('redis bad response'));
      bufs.push(c);
      pump();
    };
    const onErr = () => finish(new Error('redis connection failed'));
    const onEnd = () => finish(new Error('redis bad response'));
    const onTimeout = () => finish(new Error('redis timeout'));
    const timer = setTimeout(() => finish(new Error('redis timeout')), timeoutMs);
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('end', onEnd);
    sock.on('timeout', onTimeout);
    sock.setTimeout(timeoutMs);
  });
}

async function redisPipeline(ep: RedisEndpoint, commands: string[][], timeoutMs: number): Promise<Reply[]> {
  const batch: string[][] = [];
  if (ep.password) batch.push(ep.username ? ['AUTH', ep.username, ep.password] : ['AUTH', ep.password]);
  if (ep.db !== 0) batch.push(['SELECT', String(ep.db)]);
  batch.push(...commands);
  const sock = await connect(ep, timeoutMs);
  const replies = readReplies(sock, batch.length, timeoutMs);
  try {
    try {
      await new Promise<void>((resolve, reject) => {
        sock.write(Buffer.concat(batch.map(encodeCommand)), (err) => (err ? reject(new Error('redis connection failed')) : resolve()));
      });
    } catch (e) {
      replies.catch(() => {});
      throw e;
    }
    const got = await replies;
    let i = 0;
    if (ep.password) {
      const auth = got[i++];
      if (auth?.kind === 'err') throw new Error('redis auth failed');
      if (auth?.kind !== 'ok' || auth.value !== 'OK') throw new Error('redis bad response');
    }
    if (ep.db !== 0) {
      const sel = got[i++];
      if (sel?.kind !== 'ok' || sel.value !== 'OK') throw new Error('redis bad response');
    }
    const body = got.slice(i);
    if (body.length !== commands.length || body.some((r) => r.kind === 'err')) throw new Error('redis bad response');
    return body;
  } finally {
    sock.removeAllListeners();
    sock.on('error', () => {});
    sock.destroy();
  }
}

export class RedisStore {
  constructor(private ep: RedisEndpoint, private timeoutMs = 1500, private prefix = 'rl:') {}
  private windowKey(key: string, windowMs: number, offset: number, now: number) {
    return `${this.prefix}${key}:${Math.floor(now / windowMs) + offset}`;
  }
  /** 出错（超时 / 认证 / 协议 / 断线）时 throw，不在这里吞掉 */
  async hit(key: string, limit: number, windowMs: number) {
    const k = this.windowKey(key, windowMs, 0, Date.now());
    const j = await redisPipeline(this.ep, [['INCR', k], ['PEXPIRE', k, String(windowMs), 'NX']], this.timeoutMs);
    const n = j[0];
    if (n?.kind !== 'int') throw new Error('redis bad response');
    return n.value <= limit;
  }
  /** 条件 DECR 同一个 `rl:<key>:<窗口序号>`（见 REFUND_LUA）。出错 throw。 */
  async refund(key: string, windowMs: number) {
    const j = await redisPipeline(this.ep, [['EVAL', REFUND_LUA, '1', this.windowKey(key, windowMs, 0, Date.now())]], this.timeoutMs);
    if (j[0]?.kind !== 'int') throw new Error('redis bad response');
  }
  /** 每个 key 的当前窗口、上一个窗口各一个 DEL（按名字删，不扫描）。任何一条出错都 throw。 */
  async clear(entries: { key: string; windowMs: number }[]) {
    if (!entries.length) return;
    const now = Date.now();
    const keys = entries.flatMap(({ key, windowMs }) => [this.windowKey(key, windowMs, 0, now), this.windowKey(key, windowMs, -1, now)]);
    const j = await redisPipeline(this.ep, keys.map((k) => ['DEL', k]), this.timeoutMs);
    if (j.length !== keys.length || j.some((x) => x.kind !== 'int')) throw new Error('redis bad response');
  }
}
