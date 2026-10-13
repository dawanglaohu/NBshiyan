import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Req = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
export async function mockServer(handler: (r: Req, res: http.ServerResponse) => void | Promise<void>) {
  const reqs: Req[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const r = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
      reqs.push(r);
      await handler(r, res);
    });
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { url, reqs, close: () => new Promise<void>((ok) => { srv.closeAllConnections(); srv.close(() => ok()); }) };
}
