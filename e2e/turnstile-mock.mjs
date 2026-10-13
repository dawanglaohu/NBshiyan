// 本机 Turnstile siteverify 模拟：token 以 "FAIL" 开头返回失败，否则成功。
import http from 'node:http';
const port = Number(process.env.TURNSTILE_MOCK_PORT ?? 3999);
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (req.url === '/health') { res.end('ok'); return; }
    const token = new URLSearchParams(b).get('response') ?? '';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: !!token && !token.startsWith('FAIL') }));
  });
}).listen(port, '127.0.0.1', () => console.log(`turnstile mock :${port}`));
