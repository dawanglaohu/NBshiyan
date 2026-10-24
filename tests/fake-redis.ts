import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { REFUND_LUA } from '../src/lib/server/ratelimit/refund-lua';

type Entry = { v: number; exp: number | null };

/**
 * 测试用的最小 Redis：只认 AUTH / SELECT / INCR / PEXPIRE / EVAL（仅 REFUND_LUA）/ DEL。
 * 命令记录里 AUTH 只留名字，密码放在 auths()。
 */
export async function startFakeRedis(opts: { password?: string; hold?: boolean; failCommand?: string; tls?: { cert: Buffer; key: Buffer } } = {}) {
  const kv = new Map<string, Entry>();
  const commands: string[][] = [];
  const auths: string[] = [];
  const live = (k: string) => {
    const e = kv.get(k);
    if (!e) return undefined;
    if (e.exp !== null && e.exp <= Date.now()) { kv.delete(k); return undefined; }
    return e;
  };
  const replyInt = (n: number) => Buffer.from(`:${n}\r\n`);
  const replyOk = Buffer.from('+OK\r\n');
  const replyErr = (m: string) => Buffer.from(`-${m}\r\n`);

  function take(buf: Buffer): { args: string[]; rest: Buffer } | null {
    if (!buf.length) return null;
    if (buf[0] !== 42) throw new Error('client');
    const nl = buf.indexOf('\r\n');
    if (nl < 0) return null;
    const n = Number(buf.toString('utf8', 1, nl));
    if (!Number.isInteger(n) || n < 0) throw new Error('client');
    let p = nl + 2;
    const args: string[] = [];
    for (let i = 0; i < n; i++) {
      if (p >= buf.length || buf[p] !== 36) return null;
      const nl2 = buf.indexOf('\r\n', p);
      if (nl2 < 0) return null;
      const len = Number(buf.toString('utf8', p + 1, nl2));
      const start = nl2 + 2;
      if (!Number.isInteger(len) || len < 0 || buf.length < start + len + 2) return null;
      args.push(buf.toString('utf8', start, start + len));
      p = start + len + 2;
    }
    return { args, rest: buf.subarray(p) };
  }

  function onConn(sock: net.Socket) {
    sock.on('error', () => {});
    if (opts.hold) return;
    let authed = opts.password === undefined;
    let pending: Buffer = Buffer.alloc(0);
    const write = (b: Buffer) => { sock.write(b); };
    const exec = (args: string[]) => {
      const name = args[0]?.toUpperCase();
      if (name === 'AUTH') {
        const got = args.length >= 3 ? args[2] : args[1];
        auths.push(got ?? '');
        commands.push(['AUTH']);
        if (opts.password !== undefined && got !== opts.password) { write(replyErr('WRONGPASS')); return; }
        authed = true;
        write(replyOk);
        return;
      }
      commands.push(args);
      if (!authed) { write(replyErr('NOAUTH')); return; }
      if (opts.failCommand && name === opts.failCommand) { write(replyErr('nope')); return; }
      if (name === 'SELECT') { write(replyOk); return; }
      if (name === 'INCR') {
        const e = live(args[1]) ?? { v: 0, exp: null };
        e.v++;
        kv.set(args[1], e);
        write(replyInt(e.v));
        return;
      }
      if (name === 'PEXPIRE') {
        const e = live(args[1]);
        if (!e || (args[3] === 'NX' && e.exp !== null)) { write(replyInt(0)); return; }
        e.exp = Date.now() + Number(args[2]);
        write(replyInt(1));
        return;
      }
      if (name === 'EVAL') {
        if (args[1] !== REFUND_LUA || args[2] !== '1') { write(replyErr('noscript')); return; }
        const e = live(args[3]);
        if (e && e.v > 0) write(replyInt(--e.v));
        else write(replyInt(0));
        return;
      }
      if (name === 'DEL') {
        write(replyInt(kv.delete(args[1]) ? 1 : 0));
        return;
      }
      write(replyErr('unknown'));
    };
    sock.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      try {
        for (;;) {
          const cmd = take(pending);
          if (!cmd) break;
          pending = cmd.rest;
          exec(cmd.args);
        }
      } catch { sock.destroy(); }
    });
  }

  const sockets = new Set<net.Socket>();
  const srv = opts.tls ? tls.createServer(opts.tls, onConn) : net.createServer(onConn);
  srv.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const port = (srv.address() as AddressInfo).port;
  return {
    port,
    commands: () => commands.map((c) => [...c]),
    auths: () => [...auths],
    keys: () => kv,
    expire(key: string) { kv.delete(key); },
    close: () => new Promise<void>((ok) => {
      for (const sock of sockets) sock.destroy();
      srv.close(() => ok());
    }),
  };
}
